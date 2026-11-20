import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityService } from '../../apps/server/src/identity/service';
import { loadConfig } from '../../apps/server/src/config';
import type { Database } from '../../apps/server/src/database';
import { hashToken, verifyPassword } from '../../apps/server/src/security';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(new URL(url).pathname)) throw new Error('身份集成测试只允许专用测试库');
const schema = `tattoo_identity_${randomUUID().replaceAll('-', '')}`;
const isolatedUrl = new URL(url);
isolatedUrl.searchParams.set('schema', schema);
const connectionString = isolatedUrl.toString();
const bootstrapPassword = 'initial-admin-password';
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: connectionString,
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  ADMIN_EMAIL: 'identity-test@example.com',
  ADMIN_PASSWORD: bootstrapPassword,
});
const setupConnection = new Client({ connectionString: url });
let createdSchema = false;
let database: PrismaClient;
let identity: IdentityService;

beforeAll(async () => {
  await setupConnection.connect();
  await setupConnection.query(`CREATE SCHEMA "${schema}"`);
  createdSchema = true;
  await setupConnection.query(`SET search_path TO "${schema}"`);
  const migrations = resolve('apps/server/prisma/migrations');
  const directories = (await readdir(migrations, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const directory of directories)
    await setupConnection.query(
      await readFile(resolve(migrations, directory.name, 'migration.sql'), 'utf8'),
    );
  database = new PrismaClient({ datasources: { db: { url: connectionString } } });
  await database.$connect();
  identity = new IdentityService(database as Database, config);
}, 30000);

afterAll(async () => {
  await database?.$disconnect();
  if (createdSchema) {
    if (!/^tattoo_identity_[0-9a-f]{32}$/.test(schema)) throw new Error('测试 schema 范围校验失败');
    await setupConnection.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
  await setupConnection.end();
});

describe('管理员与数据库会话', () => {
  it('首次缺少管理员密码时拒绝初始化且不创建半成品账号', async () => {
    const missingPassword = new IdentityService(database as Database, {
      ...config,
      ADMIN_PASSWORD: undefined,
    });
    await expect(missingPassword.initialize()).rejects.toThrow('ADMIN_PASSWORD');
    expect(await database.user.count()).toBe(0);
  });

  it('首个管理员并发初始化只创建一次，重复启动不覆盖已有密码', async () => {
    await Promise.all([identity.initialize(), identity.initialize()]);
    const users = await database.user.findMany();
    expect(users).toHaveLength(1);
    expect(verifyPassword(bootstrapPassword, users[0]!.passwordHash)).toBe(true);
    const replacement = new IdentityService(database as Database, {
      ...config,
      ADMIN_PASSWORD: 'replacement-admin-password',
      ADMIN_EMAIL: 'different@example.com',
    });
    await replacement.initialize();
    const current = await database.user.findUniqueOrThrow({ where: { id: users[0]!.id } });
    expect(current.email).toBe(config.ADMIN_EMAIL);
    expect(current.passwordHash).toBe(users[0]!.passwordHash);
    await new IdentityService(database as Database, {
      ...config,
      ADMIN_PASSWORD: undefined,
    }).initialize();
  });

  it('不存在的账号与错误密码返回相同错误，正确密码创建仅存哈希的会话', async () => {
    await expect(identity.login('unknown@example.com', 'wrong', 'unknown-fixture')).rejects.toThrow(
      '邮箱或密码错误',
    );
    await expect(identity.login(config.ADMIN_EMAIL, 'wrong', 'wrong-fixture')).rejects.toThrow(
      '邮箱或密码错误',
    );
    const result = await identity.login(
      config.ADMIN_EMAIL.toUpperCase(),
      bootstrapPassword,
      'success-fixture',
    );
    expect(result.user).toEqual(expect.objectContaining({ email: config.ADMIN_EMAIL }));
    expect(result.user).not.toHaveProperty('passwordHash');
    const session = await database.session.findUniqueOrThrow({
      where: { id: hashToken(result.token) },
    });
    expect(session.id).not.toBe(result.token);
    expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await identity.authenticate(`tattoo_session=${result.token}`)).toEqual(result.user);
    await identity.logout(`tattoo_session=${result.token}`);
    expect(await identity.authenticate(`tattoo_session=${result.token}`)).toBeNull();
    await expect(identity.logout(`tattoo_session=${result.token}`)).resolves.toBeUndefined();
  });

  it('数据库过期会话立即失效，密码重置撤销所有旧会话', async () => {
    const expired = await identity.login(config.ADMIN_EMAIL, bootstrapPassword, 'expiry-fixture');
    await database.session.update({
      where: { id: hashToken(expired.token) },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    expect(await identity.authenticate(`tattoo_session=${expired.token}`)).toBeNull();
    const first = await identity.login(config.ADMIN_EMAIL, bootstrapPassword, 'reset-first');
    const second = await identity.login(config.ADMIN_EMAIL, bootstrapPassword, 'reset-second');
    await identity.resetPassword('changed-admin-password');
    expect(await identity.authenticate(`tattoo_session=${first.token}`)).toBeNull();
    expect(await identity.authenticate(`tattoo_session=${second.token}`)).toBeNull();
    await expect(
      identity.login(config.ADMIN_EMAIL, bootstrapPassword, 'old-password'),
    ).rejects.toThrow('邮箱或密码错误');
    await expect(
      identity.login(config.ADMIN_EMAIL, 'changed-admin-password', 'new-password'),
    ).resolves.toHaveProperty('token');
  });

  it('部署侧重置命令采用同一密码格式并撤销现有会话，不输出新密码', async () => {
    const session = await identity.login(config.ADMIN_EMAIL, 'changed-admin-password', 'cli-reset');
    const replacement = 'cli-changed-admin-password';
    const result = spawnSync(process.execPath, [resolve('scripts/reset-admin.mjs')], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: connectionString, TATTOO_NEW_PASSWORD: replacement },
      windowsHide: true,
      timeout: 20000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(replacement);
    expect(await identity.authenticate(`tattoo_session=${session.token}`)).toBeNull();
    await expect(
      identity.login(config.ADMIN_EMAIL, replacement, 'cli-new-password'),
    ).resolves.toHaveProperty('token');
  }, 30000);
});
