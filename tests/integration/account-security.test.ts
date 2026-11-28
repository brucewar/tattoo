import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { generate } from 'otplib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AccountSecurityStatus, RecoveryCodesResult, TotpSetup } from '@tattoo/contracts';
import { hashPassword, hashToken, SecretBox, verifyPassword } from '../../apps/server/src/security';
import { restoredTasksSql } from '../../scripts/lib/backup.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/test/i.test(new URL(databaseUrl).pathname))
  throw new Error('账户安全 HTTP 测试只允许专用测试库');
const schema = `tattoo_security_http_${randomUUID().replaceAll('-', '')}`;
const isolatedUrl = new URL(databaseUrl);
isolatedUrl.searchParams.set('schema', schema);
const connectionString = isolatedUrl.toString();
const email = 'security-http@example.com';
const password = 'security-http-test-password';
const masterKey = Buffer.alloc(32, 31).toString('base64');
const connection = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
let database: PrismaClient;
let apiProcess: ChildProcess | undefined;
let processEnv: NodeJS.ProcessEnv;
let origin = '';
let storage = '';
let temporaryRoot = '';
let createdSchema = false;
let apiLogs = '';

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配测试端口');
  const port = address.port;
  await new Promise<void>((done, reject) =>
    server.close((error) => (error ? reject(error) : done())),
  );
  return port;
}

async function stopApi() {
  if (!apiProcess || apiProcess.exitCode !== null || apiProcess.signalCode !== null) return;
  const child = apiProcess;
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  child.kill('SIGKILL');
  await Promise.race([
    exited,
    sleep(5000).then(() => {
      throw new Error('账户安全测试 API 未退出');
    }),
  ]);
}

async function startApi() {
  const child = spawn(process.execPath, [resolve('apps/server/dist/main.js')], {
    cwd: resolve('.'),
    env: processEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  apiProcess = child;
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk: Buffer) => {
      apiLogs = (apiLogs + chunk.toString('utf8')).slice(-65536);
    });
  const end = Date.now() + 45000;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`账户安全测试 API 启动失败：${apiLogs}`);
    try {
      if ((await fetch(origin + '/api/v1/health/ready', { signal: AbortSignal.timeout(1000) })).ok)
        return;
    } catch {
      /* Wait only for this isolated API process. */
    }
    await sleep(100);
  }
  throw new Error(`账户安全测试 API 启动超时：${apiLogs}`);
}

function request(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = '',
  extraHeaders: Record<string, string> = {},
) {
  return fetch(origin + '/api/v1' + path, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET'
        ? { Origin: origin, 'X-Tattoo-Request': '1', 'Content-Type': 'application/json' }
        : {}),
      ...extraHeaders,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  });
}

async function data<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as { data?: T; error?: unknown };
  expect(response.ok, JSON.stringify(payload)).toBe(true);
  return payload.data as T;
}

function cookieLine(response: Response, name: string) {
  return response.headers.getSetCookie().find((value) => value.startsWith(name + '='));
}
function sessionCookie(response: Response) {
  const value = cookieLine(response, 'tattoo_session')?.split(';')[0];
  expect(value).toMatch(/^tattoo_session=[0-9a-f]{64}$/);
  return value!;
}
function challengeCookie(response: Response) {
  const value = cookieLine(response, 'tattoo_login_challenge')?.split(';')[0];
  expect(value).toMatch(/^tattoo_login_challenge=[0-9a-f]{64}$/);
  return value!;
}
function token(cookie: string) {
  return cookie.slice(cookie.indexOf('=') + 1);
}

async function login(credential = password) {
  const response = await request('/auth/login', 'POST', { email, password: credential });
  await data(response);
  return sessionCookie(response);
}

async function beginLogin(credential = password) {
  const response = await request('/auth/login', 'POST', { email, password: credential });
  const result = await data<{ mfaRequired: true; challengeExpiresAt: string }>(response);
  expect(result.mfaRequired).toBe(true);
  expect(new Date(result.challengeExpiresAt).getTime()).toBeGreaterThan(Date.now());
  expect(new Date(result.challengeExpiresAt).getTime()).toBeLessThanOrEqual(
    Date.now() + 5 * 60 * 1000,
  );
  expect(cookieLine(response, 'tattoo_session')).toBeUndefined();
  return { cookie: challengeCookie(response), response };
}

async function totp(secret: string, offsetSeconds = 0) {
  return generate({
    strategy: 'totp',
    secret,
    algorithm: 'sha1',
    digits: 6,
    period: 30,
    epoch: Math.floor(Date.now() / 1000) + offsetSeconds,
  });
}

async function setup(cookie: string) {
  return data<TotpSetup>(
    await request('/auth/totp/setup', 'POST', { currentPassword: password }, cookie),
  );
}

async function enable(cookie?: string) {
  const original = cookie ?? (await login());
  const pending = await setup(original);
  const code = await totp(pending.secret);
  const response = await request(
    '/auth/totp/enable',
    'POST',
    { setupId: pending.setupId, code },
    original,
  );
  const result = await data<RecoveryCodesResult>(response);
  expect(result.totpEnabled).toBe(true);
  expect(result.recoveryCodesRemaining).toBe(10);
  expect(result.recoveryCodes).toHaveLength(10);
  return { cookie: sessionCookie(response), original, pending, result, code };
}

async function verifyLogin(challenge: string, code: string) {
  const response = await request('/auth/login/verify', 'POST', { code }, challenge);
  await data(response);
  return { cookie: sessionCookie(response), response };
}

function verifyFromAddress(challenge: string, code: string, address: string) {
  return new Promise<number>((done, reject) => {
    const outgoing = httpRequest(
      new URL(origin + '/api/v1/auth/login/verify'),
      {
        method: 'POST',
        localAddress: address,
        headers: {
          Cookie: challenge,
          Origin: origin,
          'X-Tattoo-Request': '1',
          'Content-Type': 'application/json',
        },
      },
      (response) => {
        response.resume();
        response.once('end', () => done(response.statusCode ?? 0));
      },
    );
    outgoing.once('error', reject);
    outgoing.setTimeout(10000, () => outgoing.destroy(new Error('跨 IP 因子请求超时')));
    outgoing.end(JSON.stringify({ code }));
  });
}

beforeAll(async () => {
  await connection.connect();
  await connection.query(`CREATE SCHEMA "${schema}"`);
  createdSchema = true;
  await connection.query(`SET search_path TO "${schema}"`);
  const migrations = resolve('apps/server/prisma/migrations');
  for (const entry of (await readdir(migrations, { withFileTypes: true }))
    .filter((value) => value.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name)))
    await connection.query(
      await readFile(resolve(migrations, entry.name, 'migration.sql'), 'utf8'),
    );
  database = new PrismaClient({ datasources: { db: { url: connectionString } } });
  await database.$connect();
  temporaryRoot = await realpath(tmpdir());
  storage = await mkdtemp(join(temporaryRoot, 'tattoo-security-http-'));
  origin = `http://127.0.0.1:${await unusedPort()}`;
  processEnv = {
    ...process.env,
    NODE_ENV: 'test',
    TEST_BIND_LOOPBACK: 'true',
    DATABASE_URL: connectionString,
    APP_ENCRYPTION_KEY: masterKey,
    APP_ORIGIN: origin,
    PORT: new URL(origin).port,
    STORAGE_PATH: storage,
    ADMIN_EMAIL: email,
    ADMIN_PASSWORD: password,
    COOKIE_SECURE: 'false',
    REMOTE_WRITES_ENABLED: 'false',
    ALLOW_MOCK_WECHAT: 'false',
    WECHAT_API_BASE: 'https://api.weixin.qq.com',
  };
  await startApi();
}, 90000);

beforeEach(async () => {
  await database.recoveryCode.deleteMany();
  await database.loginChallenge.deleteMany();
  await database.session.deleteMany();
  await database.user.updateMany({
    data: {
      passwordHash: hashPassword(password),
      securityVersion: { increment: 1 },
      totpSecretEncrypted: null,
      totpLastStep: null,
      pendingTotpEncrypted: null,
      pendingTotpExpiresAt: null,
      pendingTotpSessionHash: null,
      pendingTotpSetupId: null,
      factorFailureCount: 0,
      factorFailureStartedAt: null,
      factorBlockedUntil: null,
    },
  });
});

afterAll(async () => {
  await stopApi();
  await database?.$disconnect();
  if (createdSchema) {
    if (!/^tattoo_security_http_[0-9a-f]{32}$/.test(schema))
      throw new Error('账户安全测试 schema 范围无效');
    await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
  await connection.end();
  if (storage) {
    if (
      dirname(storage) !== temporaryRoot ||
      !basename(storage).startsWith('tattoo-security-http-')
    )
      throw new Error('测试素材目录范围无效');
    await rm(storage, { recursive: true });
  }
}, 20000);

describe('P14 账户安全真实 HTTP 与 PostgreSQL', () => {
  it('未登录不能访问账户安全或修改密码，密码登录保留安全会话属性', async () => {
    expect((await request('/auth/security')).status).toBe(401);
    expect(
      (
        await request('/auth/password', 'POST', {
          currentPassword: password,
          newPassword: 'replacement-security-password',
        })
      ).status,
    ).toBe(401);
    const response = await request('/auth/login', 'POST', { email, password });
    expect(await data(response)).toEqual({
      id: expect.any(String),
      email,
      remoteWritesEnabled: false,
    });
    const cookie = sessionCookie(response);
    expect(cookieLine(response, 'tattoo_session')).toContain('HttpOnly');
    expect(cookieLine(response, 'tattoo_session')).toContain('SameSite=Strict');
    expect(cookieLine(response, 'tattoo_session')).toMatch(/; Path=\/api\/v1(?:;|$)/);
    const status = await request('/auth/security', 'GET', undefined, cookie);
    expect(status.headers.get('Cache-Control')).toBe('no-store');
    expect(await data<AccountSecurityStatus>(status)).toEqual({
      totpEnabled: false,
      recoveryCodesRemaining: 0,
      otherSessionsCount: 0,
    });
  });

  it('设置要求重新验证密码并绑定会话，过期或旧 setupId 不能启用或取消新设置', async () => {
    const first = await login();
    const second = await login();
    expect(
      (await request('/auth/totp/setup', 'POST', { currentPassword: 'wrong-password' }, first))
        .status,
    ).toBe(400);
    expect((await request('/auth/me', 'GET', undefined, first)).status).toBe(200);
    const response = await request(
      '/auth/totp/setup',
      'POST',
      { currentPassword: password },
      first,
    );
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const previous = await data<TotpSetup>(response);
    const uri = new URL(previous.otpauthUrl);
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.hostname).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toContain(email);
    expect(uri.searchParams.get('issuer')).toBe('Tattoo');
    expect(uri.searchParams.get('secret')).toBe(previous.secret);
    expect((uri.searchParams.get('algorithm') ?? 'SHA1').toUpperCase()).toBe('SHA1');
    expect(uri.searchParams.get('digits') ?? '6').toBe('6');
    expect(uri.searchParams.get('period') ?? '30').toBe('30');
    expect(new Date(previous.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(previous.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
    const current = await setup(first);
    expect(current.setupId).not.toBe(previous.setupId);
    expect(
      (
        await request(
          '/auth/totp/enable',
          'POST',
          { setupId: current.setupId, code: await totp(current.secret) },
          second,
        )
      ).status,
    ).toBe(400);
    expect(
      (await request('/auth/totp/cancel', 'POST', { setupId: previous.setupId }, first)).status,
    ).toBe(200);
    const user = await database.user.findUniqueOrThrow({ where: { email } });
    expect(user.pendingTotpSetupId).toBe(current.setupId);
    expect(user.totpSecretEncrypted).toBeNull();
    expect(user.pendingTotpEncrypted).not.toContain(current.secret);
    expect(new SecretBox(masterKey).decrypt(user.pendingTotpEncrypted!)).toContain(current.secret);
    expect(
      (
        await request(
          '/auth/totp/enable',
          'POST',
          { setupId: previous.setupId, code: await totp(previous.secret) },
          first,
        )
      ).status,
    ).toBe(400);
    // An unconfirmed setup must not lock the administrator out of password login.
    const stillPasswordOnly = await login();
    expect((await request('/auth/me', 'GET', undefined, stillPasswordOnly)).status).toBe(200);
    await database.user.update({
      where: { email },
      data: { pendingTotpExpiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      (
        await request(
          '/auth/totp/enable',
          'POST',
          { setupId: current.setupId, code: await totp(current.secret) },
          first,
        )
      ).status,
    ).toBe(400);
    expect(
      (await database.user.findUniqueOrThrow({ where: { email } })).totpSecretEncrypted,
    ).toBeNull();
  });

  it('启用只返回一次恢复码，密钥加密、恢复码哈希并撤销旧会话', async () => {
    const first = await login();
    const other = await login();
    const enabled = await enable(first);
    expect(enabled.cookie).not.toBe(first);
    expect((await request('/auth/me', 'GET', undefined, first)).status).toBe(401);
    expect((await request('/auth/me', 'GET', undefined, other)).status).toBe(401);
    expect((await request('/auth/me', 'GET', undefined, enabled.cookie)).status).toBe(200);
    expect(new Set(enabled.result.recoveryCodes).size).toBe(10);
    for (const code of enabled.result.recoveryCodes)
      expect(code.replaceAll('-', '')).toMatch(/^[0-9a-f]{32}$/i);
    const user = await database.user.findUniqueOrThrow({ where: { email } });
    expect(user.pendingTotpEncrypted).toBeNull();
    expect(user.pendingTotpSetupId).toBeNull();
    expect(user.totpSecretEncrypted).not.toContain(enabled.pending.secret);
    expect(new SecretBox(masterKey).decrypt(user.totpSecretEncrypted!)).toContain(
      enabled.pending.secret,
    );
    const rows = await database.recoveryCode.findMany();
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(enabled.result.recoveryCodes).not.toContain(row.codeHash);
    }
    const response = await request('/auth/security', 'GET', undefined, enabled.cookie);
    const state = await data<AccountSecurityStatus>(response);
    expect(state).toEqual({ totpEnabled: true, recoveryCodesRemaining: 10, otherSessionsCount: 0 });
    expect(Object.keys(state).sort()).toEqual([
      'otherSessionsCount',
      'recoveryCodesRemaining',
      'totpEnabled',
    ]);
    expect(apiLogs).not.toContain(enabled.pending.secret);
    for (const code of enabled.result.recoveryCodes) expect(apiLogs).not.toContain(code);
  });

  it('退出登录清理本会话待绑定与挑战，不撤销其他有效上下文', async () => {
    const first = await login();
    const second = await login();
    await setup(first);
    const response = await request('/auth/logout', 'POST', {}, first);
    expect(response.status).toBe(200);
    expect(cookieLine(response, 'tattoo_session')).toMatch(/^tattoo_session=;/);
    expect(
      (await database.user.findUniqueOrThrow({ where: { email } })).pendingTotpSetupId,
    ).toBeNull();
    expect((await request('/auth/me', 'GET', undefined, second)).status).toBe(200);
    const secondSetup = await setup(second);
    await request('/auth/logout', 'POST', {}, first);
    expect((await database.user.findUniqueOrThrow({ where: { email } })).pendingTotpSetupId).toBe(
      secondSetup.setupId,
    );
    const enabled = await enable(second);
    const challenge = await beginLogin();
    const cancelled = await request('/auth/logout', 'POST', {}, challenge.cookie);
    expect(cancelled.status).toBe(200);
    expect(cookieLine(cancelled, 'tattoo_login_challenge')).toMatch(/^tattoo_login_challenge=;/);
    expect(await database.loginChallenge.count()).toBe(0);
    expect(
      (
        await request(
          '/auth/login/verify',
          'POST',
          { code: enabled.result.recoveryCodes[0] },
          challenge.cookie,
        )
      ).status,
    ).toBe(401);
    expect((await request('/auth/me', 'GET', undefined, enabled.cookie)).status).toBe(200);
  });

  it('密码阶段仅签发受限挑战，错误因子可重试而完整会话只在第二阶段产生', async () => {
    const enabled = await enable();
    const before = await database.session.count();
    const challenge = await beginLogin();
    const line = cookieLine(challenge.response, 'tattoo_login_challenge')!;
    expect(line).toContain('HttpOnly');
    expect(line).toContain('SameSite=Strict');
    expect(line).toMatch(/; Path=\/api\/v1\/auth(?:;|$)/);
    expect(challenge.response.headers.get('Cache-Control')).toBe('no-store');
    expect((await request('/auth/me', 'GET', undefined, challenge.cookie)).status).toBe(401);
    expect((await request('/auth/security', 'GET', undefined, challenge.cookie)).status).toBe(401);
    expect(await database.session.count()).toBe(before);
    expect(
      (await request('/auth/login/verify', 'POST', { code: '0'.repeat(32) }, challenge.cookie))
        .status,
    ).toBe(400);
    expect(
      (
        await database.loginChallenge.findUniqueOrThrow({
          where: { id: hashToken(token(challenge.cookie)) },
        })
      ).attempts,
    ).toBe(1);
    const result = await verifyLogin(challenge.cookie, enabled.result.recoveryCodes[0]!);
    expect(cookieLine(result.response, 'tattoo_login_challenge')).toMatch(
      /^tattoo_login_challenge=;/,
    );
    expect((await request('/auth/me', 'GET', undefined, result.cookie)).status).toBe(200);
    expect(await database.session.count()).toBe(before + 1);
    expect(await database.loginChallenge.count()).toBe(0);
    expect(await database.recoveryCode.count()).toBe(9);
    expect(
      (
        await request(
          '/auth/login/verify',
          'POST',
          { code: enabled.result.recoveryCodes[1] },
          challenge.cookie,
        )
      ).status,
    ).toBe(401);
  });

  it('挑战过期、取消和五次失败后作废，不消费未使用的恢复码', async () => {
    const enabled = await enable();
    const expired = await beginLogin();
    await database.loginChallenge.update({
      where: { id: hashToken(token(expired.cookie)) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      (
        await request(
          '/auth/login/verify',
          'POST',
          { code: enabled.result.recoveryCodes[0] },
          expired.cookie,
        )
      ).status,
    ).toBe(401);
    const cancelled = await beginLogin();
    const cancel = await request('/auth/login/cancel', 'POST', {}, cancelled.cookie);
    expect(cancel.status).toBe(200);
    expect(cookieLine(cancel, 'tattoo_login_challenge')).toMatch(/^tattoo_login_challenge=;/);
    expect(
      (
        await request(
          '/auth/login/verify',
          'POST',
          { code: enabled.result.recoveryCodes[0] },
          cancelled.cookie,
        )
      ).status,
    ).toBe(401);
    const limited = await beginLogin();
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await request(
        '/auth/login/verify',
        'POST',
        { code: '0'.repeat(32) },
        limited.cookie,
      );
      expect(response.status).toBe(attempt === 4 ? 401 : 400);
    }
    expect(
      await database.loginChallenge.findUnique({ where: { id: hashToken(token(limited.cookie)) } }),
    ).toBeNull();
    expect(
      (
        await request(
          '/auth/login/verify',
          'POST',
          { code: enabled.result.recoveryCodes[0] },
          limited.cookie,
        )
      ).status,
    ).toBe(401);
    expect(await database.recoveryCode.count()).toBe(10);
    expect((await database.user.findUniqueOrThrow({ where: { email } })).factorFailureCount).toBe(
      5,
    );
  });

  it('已用于绑定或登录的 TOTP 时间步不能被第二个挑战重放', async () => {
    const enabled = await enable();
    const first = await beginLogin();
    expect(
      (await request('/auth/login/verify', 'POST', { code: enabled.code }, first.cookie)).status,
    ).toBe(400);
    const next = await totp(enabled.pending.secret, 30);
    const signedIn = await verifyLogin(first.cookie, next);
    expect((await request('/auth/me', 'GET', undefined, signedIn.cookie)).status).toBe(200);
    const second = await beginLogin();
    expect(
      (await request('/auth/login/verify', 'POST', { code: next }, second.cookie)).status,
    ).toBe(400);
    expect(await database.recoveryCode.count()).toBe(10);
  });

  it('两个挑战并发消费同一恢复码只有一次成功，失败挑战仍可用其他码完成', async () => {
    const enabled = await enable();
    const first = await beginLogin();
    const second = await beginLogin();
    const attempts = await Promise.all(
      [first, second].map(({ cookie }) =>
        request('/auth/login/verify', 'POST', { code: enabled.result.recoveryCodes[0] }, cookie),
      ),
    );
    expect(attempts.map((value) => value.status).sort()).toEqual([200, 400]);
    expect(await database.recoveryCode.count()).toBe(9);
    expect(await database.session.count()).toBe(2);
    const successIndex = attempts.findIndex((value) => value.status === 200);
    const failed = successIndex === 0 ? second : first;
    const success = successIndex === 0 ? first : second;
    expect(
      (
        await request(
          '/auth/login/verify',
          'POST',
          { code: enabled.result.recoveryCodes[1] },
          success.cookie,
        )
      ).status,
    ).toBe(401);
    await verifyLogin(failed.cookie, enabled.result.recoveryCodes[1]!);
    expect(await database.recoveryCode.count()).toBe(8);
  });

  it('同一挑战并发提交不同恢复码只能创建一次会话且只消费一个码', async () => {
    const enabled = await enable();
    const challenge = await beginLogin();
    const attempts = await Promise.all(
      enabled.result.recoveryCodes
        .slice(0, 2)
        .map((code) => request('/auth/login/verify', 'POST', { code }, challenge.cookie)),
    );
    expect(attempts.map((value) => value.status).sort()).toEqual([200, 401]);
    expect(await database.session.count()).toBe(2);
    expect(await database.recoveryCode.count()).toBe(9);
  });

  it('未启用因子时改密校验原密码、轮换当前会话并撤销其他会话与待绑定', async () => {
    const first = await login();
    const second = await login();
    await setup(first);
    const replacement = 'changed-password-only-fixture';
    expect(
      (
        await request(
          '/auth/password',
          'POST',
          { currentPassword: 'wrong-current', newPassword: replacement },
          first,
        )
      ).status,
    ).toBe(400);
    expect((await request('/auth/me', 'GET', undefined, first)).status).toBe(200);
    const response = await request(
      '/auth/password',
      'POST',
      { currentPassword: password, newPassword: replacement },
      first,
    );
    await data(response);
    const current = sessionCookie(response);
    expect(current).not.toBe(first);
    expect((await request('/auth/me', 'GET', undefined, first)).status).toBe(401);
    expect((await request('/auth/me', 'GET', undefined, second)).status).toBe(401);
    expect((await request('/auth/me', 'GET', undefined, current)).status).toBe(200);
    const user = await database.user.findUniqueOrThrow({ where: { email } });
    expect(user.pendingTotpEncrypted).toBeNull();
    expect(verifyPassword(replacement, user.passwordHash)).toBe(true);
    expect((await request('/auth/login', 'POST', { email, password })).status).toBe(401);
    expect((await request('/auth/me', 'GET', undefined, await login(replacement))).status).toBe(
      200,
    );
    expect(apiLogs).not.toContain(replacement);
  });

  it('已启用因子时改密要求密码和因子，废弃旧会话与密码阶段挑战', async () => {
    const enabled = await enable();
    const pending = await beginLogin();
    const other = await verifyLogin((await beginLogin()).cookie, enabled.result.recoveryCodes[9]!);
    const replacement = 'changed-with-factor-fixture';
    expect(
      (
        await request(
          '/auth/password',
          'POST',
          {
            currentPassword: 'wrong-current',
            newPassword: replacement,
            code: enabled.result.recoveryCodes[0],
          },
          enabled.cookie,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          '/auth/password',
          'POST',
          { currentPassword: password, newPassword: replacement },
          enabled.cookie,
        )
      ).status,
    ).toBe(400);
    expect(await database.recoveryCode.count()).toBe(9);
    const response = await request(
      '/auth/password',
      'POST',
      {
        currentPassword: password,
        newPassword: replacement,
        code: enabled.result.recoveryCodes[0],
      },
      enabled.cookie,
    );
    expect(await data<AccountSecurityStatus>(response)).toEqual({
      totpEnabled: true,
      recoveryCodesRemaining: 8,
      otherSessionsCount: 0,
    });
    const current = sessionCookie(response);
    expect((await request('/auth/me', 'GET', undefined, current)).status).toBe(200);
    expect((await request('/auth/me', 'GET', undefined, enabled.cookie)).status).toBe(401);
    expect((await request('/auth/me', 'GET', undefined, other.cookie)).status).toBe(401);
    expect(
      (
        await request(
          '/auth/login/verify',
          'POST',
          { code: enabled.result.recoveryCodes[1] },
          pending.cookie,
        )
      ).status,
    ).toBe(401);
    expect((await request('/auth/login', 'POST', { email, password })).status).toBe(401);
    await verifyLogin((await beginLogin(replacement)).cookie, enabled.result.recoveryCodes[1]!);
  });

  it('重新生成恢复码只在本次返回新码，旧集合立即失效', async () => {
    const enabled = await enable();
    const response = await request(
      '/auth/recovery-codes/regenerate',
      'POST',
      { currentPassword: password, code: enabled.result.recoveryCodes[0] },
      enabled.cookie,
    );
    const result = await data<RecoveryCodesResult>(response);
    const current = sessionCookie(response);
    expect(result.recoveryCodesRemaining).toBe(10);
    expect(result.recoveryCodes).toHaveLength(10);
    expect(result.recoveryCodes.every((code) => !enabled.result.recoveryCodes.includes(code))).toBe(
      true,
    );
    expect((await request('/auth/me', 'GET', undefined, enabled.cookie)).status).toBe(401);
    expect(await data(await request('/auth/security', 'GET', undefined, current))).toEqual({
      totpEnabled: true,
      recoveryCodesRemaining: 10,
      otherSessionsCount: 0,
    });
    const challenge = await beginLogin();
    expect(
      (
        await request(
          '/auth/login/verify',
          'POST',
          { code: enabled.result.recoveryCodes[1] },
          challenge.cookie,
        )
      ).status,
    ).toBe(400);
    await verifyLogin(challenge.cookie, result.recoveryCodes[0]!);
    expect(await database.recoveryCode.count()).toBe(9);
  });

  it('关闭 TOTP 重新验证后废弃因子、恢复码与旧挑战，恢复单密码登录', async () => {
    const enabled = await enable();
    const challenge = await beginLogin();
    expect(
      (await request('/auth/totp/disable', 'POST', { currentPassword: password }, enabled.cookie))
        .status,
    ).toBe(400);
    const response = await request(
      '/auth/totp/disable',
      'POST',
      { currentPassword: password, code: enabled.result.recoveryCodes[0] },
      enabled.cookie,
    );
    expect(await data(response)).toEqual({
      totpEnabled: false,
      recoveryCodesRemaining: 0,
      otherSessionsCount: 0,
    });
    const current = sessionCookie(response);
    expect((await request('/auth/me', 'GET', undefined, enabled.cookie)).status).toBe(401);
    expect((await request('/auth/me', 'GET', undefined, current)).status).toBe(200);
    expect(
      (
        await request(
          '/auth/login/verify',
          'POST',
          { code: enabled.result.recoveryCodes[1] },
          challenge.cookie,
        )
      ).status,
    ).toBe(401);
    expect(
      (await database.user.findUniqueOrThrow({ where: { email } })).totpSecretEncrypted,
    ).toBeNull();
    expect(await database.recoveryCode.count()).toBe(0);
    await login();
  });

  it('退出其他会话保留当前令牌，撤销其他上下文与挑战', async () => {
    const enabled = await enable();
    const second = await verifyLogin((await beginLogin()).cookie, enabled.result.recoveryCodes[0]!);
    const third = await verifyLogin((await beginLogin()).cookie, enabled.result.recoveryCodes[1]!);
    const pending = await beginLogin();
    expect(
      (
        await data<AccountSecurityStatus>(
          await request('/auth/security', 'GET', undefined, enabled.cookie),
        )
      ).otherSessionsCount,
    ).toBe(2);
    const response = await request(
      '/auth/sessions/revoke-others',
      'POST',
      { currentPassword: password, code: enabled.result.recoveryCodes[2] },
      enabled.cookie,
    );
    expect(await data(response)).toEqual({
      totpEnabled: true,
      recoveryCodesRemaining: 7,
      otherSessionsCount: 0,
    });
    const returned = cookieLine(response, 'tattoo_session')?.split(';')[0];
    expect(returned === undefined || returned === enabled.cookie).toBe(true);
    expect((await request('/auth/me', 'GET', undefined, enabled.cookie)).status).toBe(200);
    expect((await request('/auth/me', 'GET', undefined, second.cookie)).status).toBe(401);
    expect((await request('/auth/me', 'GET', undefined, third.cookie)).status).toBe(401);
    expect(
      (
        await request(
          '/auth/login/verify',
          'POST',
          { code: enabled.result.recoveryCodes[3] },
          pending.cookie,
        )
      ).status,
    ).toBe(401);
    expect(
      await database.session.findUnique({ where: { id: hashToken(token(enabled.cookie)) } }),
    ).not.toBeNull();
  });

  it('当前会话在控制器检查后被撤销，等待事务锁的改密不能继续执行', async () => {
    const cookie = await login();
    await connection.query('BEGIN');
    await connection.query('SELECT pg_advisory_xact_lock(8472902)');
    const pending = request(
      '/auth/password',
      'POST',
      { currentPassword: password, newPassword: 'revoked-session-new-password' },
      cookie,
    );
    try {
      const end = Date.now() + 5000;
      let waiting = false;
      while (Date.now() < end) {
        await connection.query('SELECT pg_stat_clear_snapshot()');
        const result = await connection.query(
          "SELECT count(*)::int AS total FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%'",
        );
        if (result.rows[0]?.total > 0) {
          waiting = true;
          break;
        }
        await sleep(30);
      }
      expect(waiting, '安全操作应在 identity 事务锁等待').toBe(true);
      await database.session.delete({ where: { id: hashToken(token(cookie)) } });
    } finally {
      await connection.query('COMMIT');
    }
    expect((await pending).status).toBe(401);
    expect(
      verifyPassword(
        password,
        (await database.user.findUniqueOrThrow({ where: { email } })).passwordHash,
      ),
    ).toBe(true);
  }, 20000);

  it('跨挑战的因子失败持久锁定账户，重启及更换 IP 不绕过或延长锁定', async () => {
    const enabled = await enable();
    const challenges = [await beginLogin(), await beginLogin(), await beginLogin()];
    for (let index = 0; index < 10; index++) {
      const status = await verifyFromAddress(
        challenges[Math.floor(index / 5)]!.cookie,
        '0'.repeat(32),
        `127.0.0.${index + 2}`,
      );
      expect(index % 5 === 4 ? [401, 429] : [400]).toContain(status);
    }
    const blocked = await database.user.findUniqueOrThrow({ where: { email } });
    expect(blocked.factorFailureCount).toBeGreaterThanOrEqual(10);
    expect(blocked.factorBlockedUntil!.getTime()).toBeGreaterThan(Date.now());
    await stopApi();
    await startApi();
    const status = await verifyFromAddress(
      challenges[2]!.cookie,
      enabled.result.recoveryCodes[0]!,
      '127.0.0.20',
    );
    expect(status).toBe(429);
    expect(await database.recoveryCode.count()).toBe(10);
    const unchanged = await database.user.findUniqueOrThrow({ where: { email } });
    expect(unchanged.factorBlockedUntil?.getTime()).toBe(blocked.factorBlockedUntil?.getTime());
    await database.user.update({
      where: { email },
      data: {
        factorBlockedUntil: new Date(Date.now() - 1000),
        factorFailureStartedAt: new Date(Date.now() - 6 * 60 * 1000),
      },
    });
    await verifyLogin(challenges[2]!.cookie, enabled.result.recoveryCodes[0]!);
  }, 70000);

  it('真实恢复 SQL 保留因子并废弃一次性认证材料，不冒充完整 Docker 恢复演练', async () => {
    const enabled = await enable();
    const challenge = await beginLogin();
    const original = await database.user.findUniqueOrThrow({ where: { email } });
    const otherToken = 'a'.repeat(64);
    await database.session.create({
      data: {
        id: hashToken(otherToken),
        userId: original.id,
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const previousStep = Math.floor(Date.now() / 30000) + 1;
    await database.user.update({
      where: { email },
      data: {
        totpLastStep: previousStep,
        pendingTotpEncrypted: original.totpSecretEncrypted,
        pendingTotpSetupId: randomUUID(),
        pendingTotpSessionHash: hashToken(token(enabled.cookie)),
        pendingTotpExpiresAt: new Date(Date.now() + 600000),
        factorFailureCount: 10,
        factorFailureStartedAt: new Date(),
        factorBlockedUntil: new Date(Date.now() + 300000),
      },
    });
    expect(await database.recoveryCode.count()).toBe(10);
    expect(await database.loginChallenge.count()).toBe(1);
    expect(await database.session.count()).toBe(2);
    await stopApi();
    const stepAtRestore = Math.floor(Date.now() / 30000);
    await connection.query(restoredTasksSql);
    const restored = await database.user.findUniqueOrThrow({ where: { email } });
    expect(restored.totpSecretEncrypted).toBe(original.totpSecretEncrypted);
    expect(new SecretBox(masterKey).decrypt(restored.totpSecretEncrypted!)).toContain(
      enabled.pending.secret,
    );
    expect(restored.securityVersion).toBe(original.securityVersion + 1);
    expect(restored.totpLastStep).toBeGreaterThanOrEqual(Math.max(previousStep, stepAtRestore));
    expect(restored.pendingTotpEncrypted).toBeNull();
    expect(restored.pendingTotpSetupId).toBeNull();
    expect(restored.pendingTotpSessionHash).toBeNull();
    expect(restored.pendingTotpExpiresAt).toBeNull();
    expect(restored.factorFailureCount).toBe(0);
    expect(restored.factorFailureStartedAt).toBeNull();
    expect(restored.factorBlockedUntil).toBeNull();
    expect(await database.session.count()).toBe(0);
    expect(await database.loginChallenge.count()).toBe(0);
    expect(await database.recoveryCode.count()).toBe(0);
    await startApi();
    expect((await request('/auth/me', 'GET', undefined, enabled.cookie)).status).toBe(401);
    expect(
      (await request('/auth/me', 'GET', undefined, `tattoo_session=${otherToken}`)).status,
    ).toBe(401);
    expect(
      (
        await request(
          '/auth/login/verify',
          'POST',
          { code: enabled.result.recoveryCodes[0] },
          challenge.cookie,
        )
      ).status,
    ).toBe(401);
    const fresh = await beginLogin();
    expect((await request('/auth/me', 'GET', undefined, fresh.cookie)).status).toBe(401);
    expect(
      (
        await request(
          '/auth/login/verify',
          'POST',
          { code: enabled.result.recoveryCodes[0] },
          fresh.cookie,
        )
      ).status,
    ).toBe(400);
    expect(await database.recoveryCode.count()).toBe(0);
  }, 70000);

  it('非法部署重置因子参数拒绝执行，不改认证状态或泄露密码与种子', async () => {
    const enabled = await enable();
    await beginLogin();
    const before = await database.user.findUniqueOrThrow({ where: { email } });
    const sessions = await database.session.findMany({ orderBy: { id: 'asc' } });
    const challenges = await database.loginChallenge.findMany({ orderBy: { id: 'asc' } });
    const codes = await database.recoveryCode.findMany({ orderBy: { id: 'asc' } });
    const replacement = 'invalid-cli-flag-password-fixture';
    const result = spawnSync(process.execPath, [resolve('scripts/reset-admin.mjs')], {
      cwd: resolve('.'),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
      env: { ...processEnv, TATTOO_NEW_PASSWORD: replacement, TATTOO_RESET_2FA: 'yes' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('TATTOO_RESET_2FA');
    expect(result.stdout + result.stderr).not.toContain(replacement);
    expect(result.stdout + result.stderr).not.toContain(enabled.pending.secret);
    expect(await database.user.findUniqueOrThrow({ where: { email } })).toEqual(before);
    expect(await database.session.findMany({ orderBy: { id: 'asc' } })).toEqual(sessions);
    expect(await database.loginChallenge.findMany({ orderBy: { id: 'asc' } })).toEqual(challenges);
    expect(await database.recoveryCode.findMany({ orderBy: { id: 'asc' } })).toEqual(codes);
    expect((await request('/auth/me', 'GET', undefined, enabled.cookie)).status).toBe(200);
  }, 30000);

  it('部署默认重置保留已启用因子，显式应急重置才清除因子且不输出秘密', async () => {
    const enabled = await enable();
    const challenge = await beginLogin();
    const replacement = 'cli-password-with-mfa-fixture';
    const reset = (nextPassword: string, resetFactor: boolean) =>
      spawnSync(process.execPath, [resolve('scripts/reset-admin.mjs')], {
        cwd: resolve('.'),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
        env: {
          ...processEnv,
          TATTOO_NEW_PASSWORD: nextPassword,
          TATTOO_RESET_2FA: String(resetFactor),
        },
      });
    const ordinary = reset(replacement, false);
    expect(ordinary.status, ordinary.stderr).toBe(0);
    expect(ordinary.stdout + ordinary.stderr).not.toContain(replacement);
    expect(ordinary.stdout + ordinary.stderr).not.toContain(enabled.pending.secret);
    expect(
      new SecretBox(masterKey).decrypt(
        (await database.user.findUniqueOrThrow({ where: { email } })).totpSecretEncrypted!,
      ),
    ).toContain(enabled.pending.secret);
    expect(await database.session.count()).toBe(0);
    expect(await database.loginChallenge.count()).toBe(0);
    expect(
      (
        await request(
          '/auth/login/verify',
          'POST',
          { code: enabled.result.recoveryCodes[1] },
          challenge.cookie,
        )
      ).status,
    ).toBe(401);
    const signedIn = await verifyLogin(
      (await beginLogin(replacement)).cookie,
      enabled.result.recoveryCodes[0]!,
    );
    const nextPassword = 'cli-emergency-reset-fixture';
    const emergency = reset(nextPassword, true);
    expect(emergency.status, emergency.stderr).toBe(0);
    expect(emergency.stdout + emergency.stderr).not.toContain(nextPassword);
    expect((await request('/auth/me', 'GET', undefined, signedIn.cookie)).status).toBe(401);
    expect(
      (await database.user.findUniqueOrThrow({ where: { email } })).totpSecretEncrypted,
    ).toBeNull();
    expect(await database.recoveryCode.count()).toBe(0);
    await login(nextPassword);
  }, 60000);
});
