import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountsService } from '../../apps/server/src/accounts/accounts.module';
import { loadConfig } from '../../apps/server/src/config';
import type { Database } from '../../apps/server/src/database';
import { SecretBox } from '../../apps/server/src/security';
import { WechatService } from '../../apps/server/src/platforms/wechat.module';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(new URL(url).pathname)) throw new Error('账号测试必须使用独立测试库');
const database = new PrismaClient({ datasources: { db: { url } } });
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: url,
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 12).toString('base64'),
  WECHAT_API_BASE: 'http://localhost:9999',
  ALLOW_MOCK_WECHAT: 'true',
});
const box = new SecretBox(config.APP_ENCRYPTION_KEY);
const ids = new Set<string>();
const secret = 'account-fixture-secret-value';
const token = 'account-fixture-access-token';
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const fetcher = vi.fn<typeof fetch>();
const wechat = new WechatService(database as Database, config, fetcher);
const accounts = new AccountsService(database as Database, config, wechat);

async function create() {
  const created = await accounts.create({
    name: '账号接入测试',
    appId: `wx${randomUUID().replaceAll('-', '').slice(0, 16)}`,
    appSecret: secret,
  });
  ids.add(created.id);
  return created;
}

beforeAll(() => database.$connect());
afterAll(async () => {
  await database.account.deleteMany({ where: { id: { in: [...ids] } } });
  await database.$disconnect();
});

describe('公众号配置与能力验证', () => {
  it('账号密钥加密保存，任何公开 DTO 都不包含明文、密文或缓存 token', async () => {
    const created = await create();
    const stored = await database.account.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.secretEncrypted).not.toContain(secret);
    expect(box.decrypt(stored.secretEncrypted)).toBe(secret);
    expect(JSON.stringify(created)).not.toContain(secret);
    expect(created).not.toHaveProperty('secretEncrypted');
    expect(created.capabilities.saveDraft.status).toBe('unverified');
    await expect(
      accounts.create({ name: '重复账号', appId: created.appId, appSecret: secret }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      accounts.update(created.id, { appId: 'wxchangedaccount1234' }),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('只读验证仅获取 token 和草稿计数，不能证明新增草稿能力', async () => {
    const created = await create();
    fetcher
      .mockReset()
      .mockResolvedValueOnce(json({ access_token: token, expires_in: 7200 }))
      .mockResolvedValueOnce(json({ total_count: 3 }));
    const result = await accounts.verify(created.id);
    expect(result.draftCount).toBe(3);
    expect(result.account.capabilities.readDraft.status).toBe('supported');
    expect(result.account.capabilities.saveDraft.status).toBe('unverified');
    expect(fetcher.mock.calls.map((call) => new URL(String(call[0])).pathname)).toEqual([
      '/cgi-bin/stable_token',
      '/cgi-bin/draft/count',
    ]);
    const list = await accounts.list({ page: 1, pageSize: 100 });
    const output = JSON.stringify(list.items.find((account) => account.id === created.id));
    expect(output).not.toContain(secret);
    expect(output).not.toContain(token);
    expect(output).not.toContain('tokenEncrypted');
    expect(output).not.toContain('secretEncrypted');
  });
  it('轮换密钥清理缓存和能力；已有远程操作的账号不可同时修改', async () => {
    const created = await create();
    await database.account.update({
      where: { id: created.id },
      data: {
        tokenEncrypted: box.encrypt(token),
        tokenExpiresAt: new Date(Date.now() + 7200000),
        capabilities: { readDraft: { status: 'supported' }, saveDraft: { status: 'supported' } },
      },
    });
    await accounts.withLockedAccount(created.id, async () => {
      await expect(
        accounts.update(created.id, { appSecret: 'another-fixture-secret' }),
      ).rejects.toMatchObject({ status: 409 });
    });
    const updated = await accounts.update(created.id, {
      name: '新名称',
      appSecret: 'another-fixture-secret',
    });
    expect(updated.credentialVersion).toBe(2);
    expect(updated.capabilities.readDraft.status).toBe('unverified');
    expect(updated.capabilities.saveDraft.status).toBe('unverified');
    const stored = await database.account.findUniqueOrThrow({ where: { id: created.id } });
    expect(stored.tokenEncrypted).toBeNull();
    expect(stored.tokenExpiresAt).toBeNull();
    expect(box.decrypt(stored.secretEncrypted)).toBe('another-fixture-secret');
  });
  it('权限拒绝与网络故障分开，原始错误里的凭证不出公开响应', async () => {
    const created = await create();
    await database.account.update({
      where: { id: created.id },
      data: { tokenEncrypted: box.encrypt(token), tokenExpiresAt: new Date(Date.now() + 7200000) },
    });
    fetcher
      .mockReset()
      .mockResolvedValueOnce(
        json({ errcode: 48001, errmsg: `unauthorized secret=${secret} access_token=${token}` }),
      );
    const refused = await accounts.verify(created.id);
    expect(refused.account.capabilities.readDraft.status).toBe('unsupported');
    expect(JSON.stringify(refused)).not.toContain(secret);
    expect(JSON.stringify(refused)).not.toContain(token);
    fetcher.mockReset().mockRejectedValueOnce(new Error(`connection failed token=${token}`));
    const offline = await accounts.verify(created.id);
    expect(offline.account.capabilities.readDraft.status).toBe('unverified');
    expect(offline.account.capabilities.saveDraft.status).toBe('unverified');
    expect(JSON.stringify(offline)).not.toContain(token);
  });
  it('过期凭证版本的验证不能覆盖较新的账号状态', async () => {
    const created = await create();
    await database.account.update({
      where: { id: created.id },
      data: { tokenEncrypted: box.encrypt(token), tokenExpiresAt: new Date(Date.now() + 7200000) },
    });
    fetcher.mockReset().mockImplementationOnce(async () => {
      // Simulate an out-of-band administrative change while a read request is in flight.
      await database.account.update({
        where: { id: created.id },
        data: {
          credentialVersion: { increment: 1 },
          capabilities: {
            readDraft: { status: 'unverified' },
            saveDraft: { status: 'unverified' },
          },
        },
      });
      return json({ total_count: 8 });
    });
    await expect(accounts.verify(created.id)).rejects.toMatchObject({ status: 409 });
    const current = await database.account.findUniqueOrThrow({ where: { id: created.id } });
    expect(current.credentialVersion).toBe(2);
    expect(current.capabilities).toMatchObject({ readDraft: { status: 'unverified' } });
  });
});
