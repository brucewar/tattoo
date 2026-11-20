import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(new URL(url).pathname)) throw new Error('集成测试只允许专用测试库');
const database = new PrismaClient({ datasources: { db: { url } } });
const accountId = randomUUID();
const articleId = randomUUID();
const revisionId = randomUUID();
const assetId = randomUUID();

beforeAll(async () => {
  await database.$connect();
  await database.asset.create({
    data: {
      id: assetId,
      name: 'test.png',
      mime: 'image/png',
      size: 1,
      width: 1,
      height: 1,
      sha256: randomUUID(),
      path: randomUUID(),
    },
  });
  await database.article.create({ data: { id: articleId } });
  await database.revision.create({
    data: {
      id: revisionId,
      articleId,
      version: 1,
      title: 'P1 fixture',
      document: { type: 'doc' },
      contentHash: 'test-hash',
      coverId: assetId,
      assets: { create: { assetId } },
    },
  });
  await database.article.update({
    where: { id: articleId },
    data: { currentRevisionId: revisionId },
  });
  await database.account.create({
    data: {
      id: accountId,
      name: 'fixture',
      appId: `wx${randomUUID()}`,
      secretEncrypted: 'test-only',
    },
  });
});

afterAll(async () => {
  await database.delivery.deleteMany({ where: { accountId } });
  await database.article.updateMany({
    where: { id: articleId },
    data: { currentRevisionId: null },
  });
  await database.revisionAsset.deleteMany({ where: { revisionId } });
  await database.revision.deleteMany({ where: { articleId } });
  await database.article.deleteMany({ where: { id: articleId } });
  await database.account.deleteMany({ where: { id: accountId } });
  await database.asset.deleteMany({ where: { id: assetId } });
  await database.$disconnect();
});

describe('初始迁移的业务约束', () => {
  it('账号、修订和动作的唯一约束阻止重复投递意图', async () => {
    const data = { accountId, revisionId, renderVersion: 'test-v1' };
    await database.delivery.create({ data });
    await expect(database.delivery.create({ data })).rejects.toMatchObject({ code: 'P2002' });
    expect(await database.delivery.count({ where: { accountId, revisionId } })).toBe(1);
    const claimed = await Promise.all(
      [1, 2].map(() =>
        database.delivery.updateMany({
          where: { accountId, revisionId, state: 'QUEUED' },
          data: { state: 'RUNNING', executionId: randomUUID() },
        }),
      ),
    );
    expect(claimed.reduce((total, result) => total + result.count, 0)).toBe(1);
  });
  it('历史修订引用的素材不能被删除', async () => {
    await expect(database.asset.delete({ where: { id: assetId } })).rejects.toMatchObject({
      code: 'P2003',
    });
    expect(await database.asset.findUnique({ where: { id: assetId } })).not.toBeNull();
  });
  it('同一文章不能写入相同版本的两份修订', async () => {
    await expect(
      database.revision.create({
        data: {
          articleId,
          version: 1,
          title: 'duplicate',
          document: { type: 'doc' },
          contentHash: 'different',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
  it('会话级锁阻止两个 Worker 同时持有执行权', async () => {
    const first = new Client({ connectionString: url });
    const second = new Client({ connectionString: url });
    await Promise.all([first.connect(), second.connect()]);
    try {
      expect(
        (await first.query('SELECT pg_try_advisory_lock(8472901) AS acquired')).rows[0].acquired,
      ).toBe(true);
      expect(
        (await second.query('SELECT pg_try_advisory_lock(8472901) AS acquired')).rows[0].acquired,
      ).toBe(false);
      await first.query('SELECT pg_advisory_unlock(8472901)');
      expect(
        (await second.query('SELECT pg_try_advisory_lock(8472901) AS acquired')).rows[0].acquired,
      ).toBe(true);
    } finally {
      await Promise.all([first.end(), second.end()]);
    }
  });
});
