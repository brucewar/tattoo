import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  OnApplicationBootstrap,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { Prisma, User } from '@prisma/client';
import type { AccountSecurityStatus } from '@tattoo/contracts';
import { Database } from '../database';
import type { Config } from '../config';
import { hashPassword, hashToken, SecretBox, verifyPassword } from '../security';
import { LoginRateLimiter } from './rate-limit';
import {
  createRecoveryCodes,
  createTotpSecret,
  createTotpUri,
  normalizeProof,
  recoveryCodeHash,
  verifyTotpStep,
} from './totp';

export const sessionCookieName = 'tattoo_session';
export const challengeCookieName = 'tattoo_login_challenge';
export const sessionDurationMilliseconds = 7 * 24 * 60 * 60 * 1000;
export const challengeDurationMilliseconds = 5 * 60 * 1000;
export const identityLock = 8472902;
const setupDurationMilliseconds = 10 * 60 * 1000;
const factorWindowMilliseconds = 5 * 60 * 1000;
const maxFactorFailures = 10;
const maxChallengeFailures = 5;
export type Principal = { id: string; email: string };
export type IssuedSession = { token: string; expiresAt: Date; user: Principal };
export type LoginResult =
  IssuedSession | { mfaRequired: true; challengeToken: string; expiresAt: Date };
export type SecurityStatus = AccountSecurityStatus;
export type SecurityMutation = {
  session: IssuedSession;
  status: SecurityStatus;
  recoveryCodes?: string[];
};
type Transaction = Prisma.TransactionClient;
type Failure = { failure: { status: 400 | 401 | 429; message: string } };
type Outcome<T> = { value: T } | Failure;
const pendingCleared = {
  pendingTotpEncrypted: null,
  pendingTotpExpiresAt: null,
  pendingTotpSessionHash: null,
  pendingTotpSetupId: null,
};
const failuresCleared = {
  factorFailureCount: 0,
  factorFailureStartedAt: null,
  factorBlockedUntil: null,
};
const failure = (status: 400 | 401 | 429, message: string): Failure => ({
  failure: { status, message },
});

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader || cookieHeader.length > 16384) return null;
  const matches = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  if (matches.length !== 1) return null;
  const token = matches[0]!.slice(name.length + 1);
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}
export function readSessionToken(cookieHeader: string | undefined): string | null {
  return readCookie(cookieHeader, sessionCookieName);
}
export function readChallengeToken(cookieHeader: string | undefined): string | null {
  return readCookie(cookieHeader, challengeCookieName);
}

@Injectable()
export class IdentityService implements OnApplicationBootstrap {
  private readonly dummyPasswordHash = hashPassword(randomBytes(32).toString('hex'));
  private readonly limiter = new LoginRateLimiter();
  private readonly sensitiveLimiter = new LoginRateLimiter();
  private readonly secrets: SecretBox;
  constructor(
    private readonly database: Database,
    @Inject('APP_CONFIG') private readonly config: Config,
  ) {
    this.secrets = new SecretBox(config.APP_ENCRYPTION_KEY);
  }
  async onApplicationBootstrap() {
    await this.initialize();
  }

  async initialize() {
    await this.database.$transaction(async (transaction) => {
      await this.lock(transaction);
      const count = await transaction.user.count();
      if (count > 1) throw new Error('实例包含多个管理员，请先检查数据库');
      if (count === 1) return;
      if (!this.config.ADMIN_PASSWORD) throw new Error('首次启动必须配置 ADMIN_PASSWORD');
      await transaction.user.create({
        data: {
          email: this.config.ADMIN_EMAIL.trim().toLowerCase(),
          passwordHash: hashPassword(this.config.ADMIN_PASSWORD),
        },
      });
    });
  }

  async login(email: string, password: string, ip: string): Promise<LoginResult> {
    const key = this.ipKey(ip);
    this.limiter.consume(key);
    const user = await this.database.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    const accepted = verifyPassword(password, user?.passwordHash ?? this.dummyPasswordHash);
    if (!user || !accepted) throw new UnauthorizedException('邮箱或密码错误');
    const result = await this.database.$transaction(
      async (transaction): Promise<Outcome<LoginResult>> => {
        await this.lock(transaction);
        const current = await transaction.user.findUnique({ where: { id: user.id } });
        if (
          !current ||
          current.passwordHash !== user.passwordHash ||
          current.securityVersion !== user.securityVersion
        )
          return failure(401, '邮箱或密码错误');
        const now = new Date();
        if (!current.totpSecretEncrypted)
          return { value: await this.issueSession(transaction, current, now) };
        if (this.factorBlocked(current, now)) return this.blockedFailure();
        await transaction.loginChallenge.deleteMany({ where: { expiresAt: { lte: now } } });
        const challengeToken = randomBytes(32).toString('hex');
        const expiresAt = new Date(now.getTime() + challengeDurationMilliseconds);
        await transaction.loginChallenge.create({
          data: {
            id: hashToken(challengeToken),
            userId: current.id,
            securityVersion: current.securityVersion,
            expiresAt,
          },
        });
        return { value: { mfaRequired: true, challengeToken, expiresAt } };
      },
    );
    const value = this.unwrap(result);
    if (!('mfaRequired' in value)) this.limiter.clear(key);
    return value;
  }

  async verifyLoginChallenge(
    cookieHeader: string | undefined,
    code: string,
    ip: string,
  ): Promise<IssuedSession> {
    const token = readChallengeToken(cookieHeader);
    if (!token) throw new UnauthorizedException('登录验证已过期，请重新输入邮箱和密码');
    const result = await this.database.$transaction(
      async (transaction): Promise<Outcome<IssuedSession>> => {
        await this.lock(transaction);
        const challenge = await transaction.loginChallenge.findUnique({
          where: { id: hashToken(token) },
          include: { user: true },
        });
        const now = new Date();
        if (
          !challenge ||
          challenge.expiresAt <= now ||
          challenge.attempts >= maxChallengeFailures ||
          challenge.securityVersion !== challenge.user.securityVersion ||
          !challenge.user.totpSecretEncrypted
        ) {
          if (challenge)
            await transaction.loginChallenge.deleteMany({ where: { id: challenge.id } });
          return failure(401, '登录验证已过期，请重新输入邮箱和密码');
        }
        const invalid = await this.consumeFactor(transaction, challenge.user, code, now);
        if (invalid) {
          if (invalid.failure.status !== 429) {
            if (challenge.attempts + 1 >= maxChallengeFailures) {
              await transaction.loginChallenge.deleteMany({ where: { id: challenge.id } });
              return failure(401, '登录验证尝试次数已用完，请重新输入邮箱和密码');
            }
            await transaction.loginChallenge.update({
              where: { id: challenge.id },
              data: { attempts: { increment: 1 } },
            });
          }
          return invalid;
        }
        await transaction.loginChallenge.delete({ where: { id: challenge.id } });
        return { value: await this.issueSession(transaction, challenge.user, now) };
      },
    );
    const value = this.unwrap(result);
    this.limiter.clear(this.ipKey(ip));
    return value;
  }

  async cancelLoginChallenge(cookieHeader: string | undefined): Promise<void> {
    const token = readChallengeToken(cookieHeader);
    if (!token) return;
    await this.database.$transaction(async (transaction) => {
      await this.lock(transaction);
      await transaction.loginChallenge.deleteMany({ where: { id: hashToken(token) } });
    });
  }

  async authenticate(cookieHeader: string | undefined): Promise<Principal | null> {
    const token = readSessionToken(cookieHeader);
    if (!token) return null;
    const id = hashToken(token);
    const session = await this.database.session.findUnique({
      where: { id },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!session) return null;
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.database.session.deleteMany({ where: { id } });
      return null;
    }
    return session.user;
  }

  async logout(cookieHeader: string | undefined) {
    const token = readSessionToken(cookieHeader);
    const challenge = readChallengeToken(cookieHeader);
    if (!token && !challenge) return;
    await this.database.$transaction(async (transaction) => {
      await this.lock(transaction);
      if (token) {
        const sessionId = hashToken(token);
        await transaction.session.deleteMany({ where: { id: sessionId } });
        await transaction.user.updateMany({
          where: { pendingTotpSessionHash: sessionId },
          data: pendingCleared,
        });
      }
      if (challenge)
        await transaction.loginChallenge.deleteMany({ where: { id: hashToken(challenge) } });
    });
  }

  async getSecurity(cookieHeader: string | undefined): Promise<SecurityStatus> {
    return this.sessionTransaction(cookieHeader, (transaction, user, sessionId, now) =>
      this.status(transaction, user.id, sessionId, now),
    );
  }

  async startTotpSetup(cookieHeader: string | undefined, currentPassword: string) {
    return this.withPassword(
      cookieHeader,
      currentPassword,
      undefined,
      false,
      async (transaction, user, sessionId, now) => {
        if (user.totpSecretEncrypted)
          throw new BadRequestException('双重验证已启用，请先关闭后重新绑定');
        const secret = createTotpSecret();
        const setupId = randomUUID();
        const expiresAt = new Date(now.getTime() + setupDurationMilliseconds);
        await transaction.user.update({
          where: { id: user.id },
          data: {
            pendingTotpEncrypted: this.encryptTotp(user.id, secret),
            pendingTotpExpiresAt: expiresAt,
            pendingTotpSessionHash: sessionId,
            pendingTotpSetupId: setupId,
          },
        });
        return { setupId, secret, otpauthUrl: createTotpUri(secret, user.email), expiresAt };
      },
    );
  }

  async cancelTotpSetup(cookieHeader: string | undefined, setupId: string) {
    return this.sessionTransaction(cookieHeader, async (transaction, user, sessionId, now) => {
      // A delayed cancellation of an old QR code must not clear a newer setup.
      await transaction.user.updateMany({
        where: { id: user.id, pendingTotpSetupId: setupId, pendingTotpSessionHash: sessionId },
        data: pendingCleared,
      });
      return this.status(transaction, user.id, sessionId, now);
    });
  }

  async confirmTotpSetup(
    cookieHeader: string | undefined,
    setupId: string,
    code: string,
  ): Promise<SecurityMutation> {
    const result = await this.sessionTransaction(
      cookieHeader,
      async (transaction, user, sessionId, now): Promise<Outcome<SecurityMutation>> => {
        if (user.totpSecretEncrypted) return failure(400, '双重验证已启用，请刷新账户安全状态');
        if (
          !user.pendingTotpEncrypted ||
          !user.pendingTotpExpiresAt ||
          user.pendingTotpSetupId !== setupId ||
          user.pendingTotpSessionHash !== sessionId
        )
          return failure(400, '绑定已失效，请重新开始设置');
        if (user.pendingTotpExpiresAt <= now) {
          await transaction.user.update({ where: { id: user.id }, data: pendingCleared });
          return failure(400, '绑定已过期，请重新开始设置');
        }
        if (this.factorBlocked(user, now)) return this.blockedFailure();
        const step = await verifyTotpStep(
          this.decryptTotp(user.id, user.pendingTotpEncrypted),
          code,
          null,
          now.getTime(),
        );
        if (step === null) return this.recordFactorFailure(transaction, user, now);
        await transaction.user.update({
          where: { id: user.id },
          data: {
            totpSecretEncrypted: user.pendingTotpEncrypted,
            totpLastStep: step,
            securityVersion: { increment: 1 },
            ...pendingCleared,
            ...failuresCleared,
          },
        });
        const recoveryCodes = await this.replaceRecoveryCodes(transaction, user.id);
        const session = await this.rotateSession(transaction, user, now);
        return {
          value: {
            session,
            status: await this.status(transaction, user.id, hashToken(session.token), now),
            recoveryCodes,
          },
        };
      },
    );
    return this.unwrap(result);
  }

  async changePassword(
    cookieHeader: string | undefined,
    currentPassword: string,
    newPassword: string,
    code?: string,
  ): Promise<SecurityMutation> {
    if (newPassword.length < 12 || newPassword.length > 256 || !newPassword.trim())
      throw new BadRequestException('新密码必须为 12 至 256 个字符');
    if (newPassword === currentPassword) throw new BadRequestException('新密码不能与当前密码相同');
    return this.withPassword(
      cookieHeader,
      currentPassword,
      code,
      true,
      async (transaction, user, _sessionId, now) => {
        const passwordHash = hashPassword(newPassword);
        await transaction.user.update({
          where: { id: user.id },
          data: { passwordHash, securityVersion: { increment: 1 }, ...pendingCleared },
        });
        const session = await this.rotateSession(transaction, user, now);
        return {
          session,
          status: await this.status(transaction, user.id, hashToken(session.token), now),
        };
      },
    );
  }

  async disableTotp(
    cookieHeader: string | undefined,
    currentPassword: string,
    code: string,
  ): Promise<SecurityMutation> {
    return this.withPassword(
      cookieHeader,
      currentPassword,
      code,
      true,
      async (transaction, user, _sessionId, now) => {
        if (!user.totpSecretEncrypted) throw new BadRequestException('双重验证尚未启用');
        await transaction.user.update({
          where: { id: user.id },
          data: {
            totpSecretEncrypted: null,
            totpLastStep: null,
            securityVersion: { increment: 1 },
            ...pendingCleared,
            ...failuresCleared,
          },
        });
        await transaction.recoveryCode.deleteMany({ where: { userId: user.id } });
        const session = await this.rotateSession(transaction, user, now);
        return {
          session,
          status: await this.status(transaction, user.id, hashToken(session.token), now),
        };
      },
    );
  }

  async regenerateRecoveryCodes(
    cookieHeader: string | undefined,
    currentPassword: string,
    code: string,
  ): Promise<SecurityMutation> {
    return this.withPassword(
      cookieHeader,
      currentPassword,
      code,
      true,
      async (transaction, user, _sessionId, now) => {
        if (!user.totpSecretEncrypted) throw new BadRequestException('请先启用双重验证');
        await transaction.user.update({
          where: { id: user.id },
          data: { securityVersion: { increment: 1 }, ...pendingCleared },
        });
        const recoveryCodes = await this.replaceRecoveryCodes(transaction, user.id);
        const session = await this.rotateSession(transaction, user, now);
        return {
          session,
          status: await this.status(transaction, user.id, hashToken(session.token), now),
          recoveryCodes,
        };
      },
    );
  }

  async revokeOtherSessions(
    cookieHeader: string | undefined,
    currentPassword: string,
    code?: string,
  ): Promise<SecurityStatus> {
    return this.withPassword(
      cookieHeader,
      currentPassword,
      code,
      true,
      async (transaction, user, sessionId, now) => {
        await transaction.session.deleteMany({
          where: { userId: user.id, id: { not: sessionId } },
        });
        await transaction.loginChallenge.deleteMany({ where: { userId: user.id } });
        await transaction.user.update({
          where: { id: user.id },
          data: { securityVersion: { increment: 1 }, ...pendingCleared },
        });
        return this.status(transaction, user.id, sessionId, now);
      },
    );
  }

  async resetPassword(password: string) {
    if (password.length < 12 || password.length > 256 || !password.trim())
      throw new Error('新密码长度必须为 12 至 256 个字符');
    const passwordHash = hashPassword(password);
    await this.database.$transaction(async (transaction) => {
      await this.lock(transaction);
      const users = await transaction.user.findMany({ select: { id: true }, take: 2 });
      if (users.length !== 1) throw new Error('实例必须已有且只有一个管理员');
      const userId = users[0]!.id;
      await transaction.user.update({
        where: { id: userId },
        data: {
          passwordHash,
          securityVersion: { increment: 1 },
          ...pendingCleared,
          ...failuresCleared,
        },
      });
      await transaction.session.deleteMany({ where: { userId } });
      await transaction.loginChallenge.deleteMany({ where: { userId } });
    });
  }

  private async withPassword<T>(
    cookieHeader: string | undefined,
    password: string,
    code: string | undefined,
    requireFactor: boolean,
    action: (transaction: Transaction, user: User, sessionId: string, now: Date) => Promise<T>,
  ): Promise<T> {
    const token = readSessionToken(cookieHeader);
    if (!token) throw new UnauthorizedException('请先登录');
    const rateKey = hashToken(token);
    this.sensitiveLimiter.consume(rateKey);
    const result = await this.sessionTransaction(
      cookieHeader,
      async (transaction, user, sessionId, now): Promise<Outcome<T>> => {
        if (
          password.length < 1 ||
          password.length > 256 ||
          !verifyPassword(password, user.passwordHash)
        )
          return failure(400, '当前密码错误');
        this.sensitiveLimiter.clear(rateKey);
        if (requireFactor && user.totpSecretEncrypted) {
          const invalid = await this.consumeFactor(transaction, user, code ?? '', now);
          if (invalid) return invalid;
        }
        return { value: await action(transaction, user, sessionId, now) };
      },
    );
    return this.unwrap(result);
  }

  private async sessionTransaction<T>(
    cookieHeader: string | undefined,
    action: (transaction: Transaction, user: User, sessionId: string, now: Date) => Promise<T>,
  ): Promise<T> {
    const token = readSessionToken(cookieHeader);
    if (!token) throw new UnauthorizedException('请先登录');
    return this.database.$transaction(async (transaction) => {
      await this.lock(transaction);
      const session = await transaction.session.findUnique({
        where: { id: hashToken(token) },
        include: { user: true },
      });
      const now = new Date();
      if (!session || session.expiresAt <= now) throw new UnauthorizedException('请先登录');
      return action(transaction, session.user, session.id, now);
    });
  }

  private async consumeFactor(
    transaction: Transaction,
    user: User,
    code: string,
    now: Date,
  ): Promise<Failure | null> {
    if (this.factorBlocked(user, now)) return this.blockedFailure();
    const normalized = normalizeProof(code);
    if (!normalized) return failure(400, '请输入动态验证码或恢复码');
    const secret = user.totpSecretEncrypted;
    if (!secret) return failure(400, '双重验证尚未启用');
    if (/^\d{6}$/.test(normalized)) {
      const step = await verifyTotpStep(
        this.decryptTotp(user.id, secret),
        normalized,
        user.totpLastStep,
        now.getTime(),
      );
      if (step !== null) {
        await transaction.user.update({
          where: { id: user.id },
          data: { totpLastStep: step, ...failuresCleared },
        });
        return null;
      }
    } else {
      const codeHash = recoveryCodeHash(user.id, normalized);
      if (codeHash) {
        const consumed = await transaction.recoveryCode.deleteMany({
          where: { userId: user.id, codeHash },
        });
        if (consumed.count === 1) {
          await transaction.user.update({ where: { id: user.id }, data: failuresCleared });
          return null;
        }
      }
    }
    return this.recordFactorFailure(transaction, user, now);
  }

  private factorBlocked(user: User, now: Date): boolean {
    return Boolean(user.factorBlockedUntil && user.factorBlockedUntil > now);
  }
  private blockedFailure(): Failure {
    return failure(429, '验证码尝试过于频繁，请等待 5 分钟后再试');
  }

  private async recordFactorFailure(
    transaction: Transaction,
    user: User,
    now: Date,
  ): Promise<Failure> {
    if (this.factorBlocked(user, now)) return this.blockedFailure();
    const sameWindow =
      user.factorFailureStartedAt &&
      now.getTime() - user.factorFailureStartedAt.getTime() < factorWindowMilliseconds &&
      !(user.factorBlockedUntil && user.factorBlockedUntil <= now);
    const count = sameWindow ? user.factorFailureCount + 1 : 1;
    await transaction.user.update({
      where: { id: user.id },
      data: {
        factorFailureCount: count,
        factorFailureStartedAt: sameWindow ? user.factorFailureStartedAt : now,
        factorBlockedUntil:
          count >= maxFactorFailures ? new Date(now.getTime() + factorWindowMilliseconds) : null,
      },
    });
    return count >= maxFactorFailures
      ? this.blockedFailure()
      : failure(400, '验证码无效、已使用或已过期，或恢复码不可用');
  }

  private async replaceRecoveryCodes(transaction: Transaction, userId: string): Promise<string[]> {
    const codes = createRecoveryCodes();
    await transaction.recoveryCode.deleteMany({ where: { userId } });
    await transaction.recoveryCode.createMany({
      data: codes.map((code) => ({ userId, codeHash: recoveryCodeHash(userId, code)! })),
    });
    return codes;
  }

  private async rotateSession(
    transaction: Transaction,
    user: Principal,
    now: Date,
  ): Promise<IssuedSession> {
    await transaction.session.deleteMany({ where: { userId: user.id } });
    await transaction.loginChallenge.deleteMany({ where: { userId: user.id } });
    return this.issueSession(transaction, user, now);
  }

  private async issueSession(
    transaction: Transaction,
    user: Principal,
    now: Date,
  ): Promise<IssuedSession> {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(now.getTime() + sessionDurationMilliseconds);
    await transaction.session.create({
      data: { id: hashToken(token), userId: user.id, expiresAt },
    });
    return { token, expiresAt, user: { id: user.id, email: user.email } };
  }

  private async status(
    transaction: Transaction,
    userId: string,
    sessionId: string,
    now: Date,
  ): Promise<SecurityStatus> {
    const [user, recoveryCodesRemaining, otherSessionsCount] = await Promise.all([
      transaction.user.findUniqueOrThrow({
        where: { id: userId },
        select: { totpSecretEncrypted: true },
      }),
      transaction.recoveryCode.count({ where: { userId } }),
      transaction.session.count({
        where: { userId, id: { not: sessionId }, expiresAt: { gt: now } },
      }),
    ]);
    return {
      totpEnabled: Boolean(user.totpSecretEncrypted),
      recoveryCodesRemaining,
      otherSessionsCount,
    };
  }

  private encryptTotp(userId: string, secret: string): string {
    return this.secrets.encrypt(`tattoo:totp:v1:${userId}:${secret}`);
  }
  private decryptTotp(userId: string, encrypted: string): string {
    const prefix = `tattoo:totp:v1:${userId}:`;
    try {
      const value = this.secrets.decrypt(encrypted);
      if (!value.startsWith(prefix) || !/^[A-Z2-7]{52}$/.test(value.slice(prefix.length)))
        throw new Error('invalid secret');
      return value.slice(prefix.length);
    } catch {
      throw new InternalServerErrorException('双重验证配置无法读取，请检查实例加密主密钥');
    }
  }
  private async lock(transaction: Transaction) {
    await transaction.$queryRaw`SELECT pg_advisory_xact_lock(${identityLock})::text AS locked`;
  }
  private ipKey(ip: string): string {
    return ip.slice(0, 200) || 'unknown';
  }
  private unwrap<T>(result: Outcome<T>): T {
    if ('value' in result) return result.value;
    const { status, message } = result.failure;
    if (status === 401) throw new UnauthorizedException(message);
    if (status === 429) throw new HttpException(message, 429);
    throw new BadRequestException(message);
  }
}
