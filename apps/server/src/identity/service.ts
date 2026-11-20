import { Inject, Injectable, OnApplicationBootstrap, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { Database } from '../database';
import type { Config } from '../config';
import { hashPassword, hashToken, verifyPassword } from '../security';
import { LoginRateLimiter } from './rate-limit';

export const sessionCookieName = 'tattoo_session';
export const sessionDurationMilliseconds = 7 * 24 * 60 * 60 * 1000;
const identityLock = 8472902;
export type Principal = { id: string; email: string };

export function readSessionToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader || cookieHeader.length > 16384) return null;
  const matches = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${sessionCookieName}=`));
  if (matches.length !== 1) return null;
  const token = matches[0]!.slice(sessionCookieName.length + 1);
  return /^[0-9a-f]{64}$/.test(token) ? token : null;
}

@Injectable()
export class IdentityService implements OnApplicationBootstrap {
  private readonly dummyPasswordHash = hashPassword(randomBytes(32).toString('hex'));
  private readonly limiter = new LoginRateLimiter();

  constructor(
    private readonly database: Database,
    @Inject('APP_CONFIG') private readonly config: Config,
  ) {}

  async onApplicationBootstrap() {
    await this.initialize();
  }

  async initialize() {
    await this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT pg_advisory_xact_lock(${identityLock})::text AS locked`;
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

  async login(email: string, password: string, ip: string) {
    const key = ip.slice(0, 200) || 'unknown';
    this.limiter.consume(key);
    const user = await this.database.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });
    const accepted = verifyPassword(password, user?.passwordHash ?? this.dummyPasswordHash);
    if (!user || !accepted) throw new UnauthorizedException('邮箱或密码错误');
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + sessionDurationMilliseconds);
    await this.database.$transaction(async (transaction) => {
      // Password reset and login serialize so a reset cannot leave a freshly issued old-password session.
      await transaction.$queryRaw`SELECT pg_advisory_xact_lock(${identityLock})::text AS locked`;
      const current = await transaction.user.findUnique({
        where: { id: user.id },
        select: { passwordHash: true },
      });
      if (!current || current.passwordHash !== user.passwordHash)
        throw new UnauthorizedException('邮箱或密码错误');
      await transaction.session.create({
        data: { id: hashToken(token), userId: user.id, expiresAt },
      });
    });
    this.limiter.clear(key);
    return { token, expiresAt, user: { id: user.id, email: user.email } };
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
    if (token) await this.database.session.deleteMany({ where: { id: hashToken(token) } });
  }

  async resetPassword(password: string) {
    if (password.length < 12 || password.length > 256)
      throw new Error('新密码长度必须为 12 至 256 个字符');
    const passwordHash = hashPassword(password);
    await this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT pg_advisory_xact_lock(${identityLock})::text AS locked`;
      const users = await transaction.user.findMany({ select: { id: true }, take: 2 });
      if (users.length !== 1) throw new Error('实例必须已有且只有一个管理员');
      await transaction.user.update({ where: { id: users[0]!.id }, data: { passwordHash } });
      await transaction.session.deleteMany({ where: { userId: users[0]!.id } });
    });
  }
}
