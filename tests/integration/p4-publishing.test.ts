import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import type {
  Article,
  ArticleInput,
  Delivery,
  DeliveryCheck,
  DocumentNode,
} from '@tattoo/contracts';
import { Client } from 'pg';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AccountsService } from '../../apps/server/src/accounts/accounts.module';
import { AssetsService } from '../../apps/server/src/assets/assets.module';
import { loadConfig, type Config } from '../../apps/server/src/config';
import type { Database } from '../../apps/server/src/database';
import { WechatService } from '../../apps/server/src/platforms/wechat.module';
import { renderDocument } from '../../apps/server/src/platforms/wechat/renderer';
import { PublishingExecutor } from '../../apps/server/src/publishing/publishing.executor';
import { PublishingService } from '../../apps/server/src/publishing/publishing.service';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/test/i.test(new URL(databaseUrl).pathname))
  throw new Error('P4 投递集成测试只允许专用测试库');
const schema = `tattoo_p4_publishing_${randomUUID().replaceAll('-', '')}`;
const scopedUrl = new URL(databaseUrl);
scopedUrl.searchParams.set('schema', schema);
const connection = new Client({ connectionString: databaseUrl });
const email = 'p4-publishing@example.com';
const password = 'p4-publishing-test-password';
let database: PrismaClient;
let config: Config;
let accounts: AccountsService;
let assets: AssetsService;
let platform: WechatService;
let publishing: PublishingService;
let executor: PublishingExecutor;
let apiProcess: ChildProcess | undefined;
let apiLogs = '';
let mock: Server | undefined;
let createdSchema = false;
let storage = '';
let temporaryRoot = '';
let origin = '';
let cookie = '';
let assetId = '';
let original: Buffer;
let draftMode: 'success' | 'invalid_cover' | 'disconnect' = 'success';
let longBodyUrl = false;
let tokenHook: (() => Promise<void>) | null = null;
let bodyHook: (() => Promise<void>) | null = null;
const releases = new Set<() => void>();
const processing = new Set<Promise<boolean>>();
const uploads: { account: string; kind: 'COVER' | 'BODY'; bytes: number }[] = [];
const unknownPaths: string[] = [];
type Payload = {
  articles: {
    title: string;
    author: string;
    digest: string;
    content_source_url: string;
    thumb_media_id: string;
    content: string;
  }[];
};
const drafts: { account: string; payload: Payload }[] = [];

function document(text = '正文中的图片来自本地素材。'): DocumentNode {
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text }] },
      { type: 'image', attrs: { assetId, alt: '正文配图' } },
      { type: 'image', attrs: { assetId, alt: '同图再次引用' } },
    ],
  };
}

function fields(text?: string): ArticleInput {
  return {
    title: `P4 ${randomUUID().slice(0, 8)}`,
    author: 'Tattoo 作者',
    digest: '来源、封面与正文图片验证',
    sourceUrl: 'https://example.com/original',
    coverId: assetId,
    document: document(text),
  };
}

function request(path: string, method = 'GET', body?: unknown, session = cookie) {
  return fetch(`${origin}/api/v1${path}`, {
    method,
    headers: {
      ...(session ? { Cookie: session } : {}),
      ...(method !== 'GET'
        ? { Origin: origin, 'X-Tattoo-Request': '1', 'Content-Type': 'application/json' }
        : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15000),
  });
}

async function data<T>(response: Response): Promise<T> {
  const result = (await response.json()) as { data: T; error?: unknown };
  expect(response.ok, JSON.stringify(result)).toBe(true);
  return result.data;
}

async function account() {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  return data<{ id: string; appId: string }>(
    await request('/accounts', 'POST', {
      name: `P4-${suffix}`,
      appId: `wx${suffix}`,
      appSecret: `mock-only-p4-secret-${suffix}`,
    }),
  );
}

async function article(input = fields()) {
  return data<Article>(await request('/articles', 'POST', input));
}

async function enqueue(revisionId: string, accountId: string) {
  return data<Delivery>(
    await request('/deliveries', 'POST', { revisionId, accountId, confirmed: true }),
  );
}

function processNext(assertActive: () => Promise<void> = async () => undefined) {
  const result = publishing.processNext(assertActive);
  processing.add(result);
  void result.finally(() => processing.delete(result)).catch(() => undefined);
  return result;
}

function barrier() {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((done) => {
    entered = done;
  });
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  releases.add(release);
  return {
    reached,
    release,
    hook: async () => {
      entered();
      await blocked;
    },
  };
}

async function port() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配测试端口');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

beforeAll(async () => {
  await connection.connect();
  await connection.query(`CREATE SCHEMA "${schema}"`);
  createdSchema = true;
  await connection.query(`SET search_path TO "${schema}"`);
  const migrations = resolve('apps/server/prisma/migrations');
  for (const entry of (await readdir(migrations, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name)))
    await connection.query(await readFile(join(migrations, entry.name, 'migration.sql'), 'utf8'));
  database = new PrismaClient({ datasources: { db: { url: scopedUrl.toString() } } });
  await database.$connect();
  temporaryRoot = await realpath(tmpdir());
  storage = await mkdtemp(join(temporaryRoot, 'tattoo-p4-publishing-'));
  mock = createServer(async (incoming, outgoing) => {
    const url = new URL(incoming.url ?? '/', 'http://mock.local');
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    outgoing.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/cgi-bin/stable_token') {
      const input = JSON.parse(body.toString('utf8')) as { appid: string };
      if (tokenHook) await tokenHook();
      outgoing.end(JSON.stringify({ access_token: `p4-${input.appid}`, expires_in: 7200 }));
      return;
    }
    const account = (url.searchParams.get('access_token') ?? '').replace(/^p4-/, '');
    if (url.pathname === '/cgi-bin/material/add_material') {
      uploads.push({ account, kind: 'COVER', bytes: body.length });
      outgoing.end(JSON.stringify({ media_id: `cover-${account}-${uploads.length}` }));
    } else if (url.pathname === '/cgi-bin/media/uploadimg') {
      uploads.push({ account, kind: 'BODY', bytes: body.length });
      if (bodyHook) await bodyHook();
      outgoing.end(
        JSON.stringify({
          url: `http://mmbiz.qpic.cn/mmbiz_jpg/${account}-${uploads.length}${longBodyUrl ? 'x'.repeat(1200) : ''}/0`,
        }),
      );
    } else if (url.pathname === '/cgi-bin/draft/add') {
      drafts.push({ account, payload: JSON.parse(body.toString('utf8')) as Payload });
      if (draftMode === 'disconnect') incoming.socket.destroy();
      else if (draftMode === 'invalid_cover')
        outgoing.end(JSON.stringify({ errcode: 40007, errmsg: 'invalid media_id' }));
      else outgoing.end(JSON.stringify({ media_id: `draft-${drafts.length}` }));
    } else {
      unknownPaths.push(url.pathname);
      outgoing.statusCode = 404;
      outgoing.end(JSON.stringify({ errcode: 404 }));
    }
  });
  await new Promise<void>((done) => mock!.listen(0, '127.0.0.1', done));
  const mockAddress = mock.address();
  if (!mockAddress || typeof mockAddress === 'string') throw new Error('模拟微信监听失败');
  const apiPort = await port();
  origin = `http://127.0.0.1:${apiPort}`;
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: scopedUrl.toString(),
    APP_ENCRYPTION_KEY: Buffer.alloc(32, 14).toString('base64'),
    APP_ORIGIN: origin,
    PORT: String(apiPort),
    STORAGE_PATH: storage,
    ADMIN_EMAIL: email,
    ADMIN_PASSWORD: password,
    COOKIE_SECURE: 'false',
    REMOTE_WRITES_ENABLED: 'true',
    ALLOW_MOCK_WECHAT: 'true',
    WECHAT_API_BASE: `http://127.0.0.1:${mockAddress.port}`,
  };
  config = loadConfig(env);
  platform = new WechatService(database as Database, config);
  accounts = new AccountsService(database as Database, config, platform);
  assets = new AssetsService(database as Database, config);
  executor = new PublishingExecutor(database as Database, accounts, assets, platform, config);
  publishing = new PublishingService(
    database as Database,
    accounts,
    assets,
    platform,
    config,
    executor,
  );
  apiProcess = spawn(process.execPath, [resolve('apps/server/dist/main.js')], {
    cwd: resolve('.'),
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const output of [apiProcess.stdout, apiProcess.stderr])
    output?.on('data', (chunk: Buffer) => {
      apiLogs = `${apiLogs}${chunk.toString('utf8')}`.slice(-32768);
    });
  const end = Date.now() + 45000;
  let ready = false;
  while (Date.now() < end) {
    if (apiProcess.exitCode !== null) throw new Error(`P4 API 提前退出：${apiLogs}`);
    try {
      ready = (await fetch(`${origin}/api/v1/health/ready`, { signal: AbortSignal.timeout(1000) }))
        .ok;
    } catch {}
    if (ready) break;
    await sleep(150);
  }
  if (!ready) throw new Error(`P4 API 启动超时：${apiLogs}`);
  const login = await request('/auth/login', 'POST', { email, password }, '');
  await data(login);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const image = await sharp({
    create: { width: 61, height: 37, channels: 3, background: '#35785c' },
  })
    .png()
    .toBuffer();
  assetId = (
    await data<{ id: string }>(
      await fetch(`${origin}/api/v1/assets`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: origin,
          'X-Tattoo-Request': '1',
          'Content-Type': 'image/png',
          'X-Filename': 'p4-image.png',
        },
        body: image,
      }),
    )
  ).id;
  original = await readFile((await assets.getFile(assetId)).path);
}, 90000);

afterEach(async () => {
  for (const release of releases) release();
  releases.clear();
  await Promise.allSettled([...processing]);
  draftMode = 'success';
  longBodyUrl = false;
  tokenHook = null;
  bodyHook = null;
  if (database)
    await database.delivery.updateMany({
      where: { state: { in: ['QUEUED', 'RUNNING'] } },
      data: { state: 'FAILED', executionId: null },
    });
}, 35000);

afterAll(async () => {
  if (apiProcess && apiProcess.exitCode === null && apiProcess.signalCode === null) {
    const exited = new Promise<void>((done) => apiProcess!.once('exit', () => done()));
    apiProcess.kill('SIGKILL');
    await Promise.race([
      exited,
      sleep(5000).then(() => {
        throw new Error('P4 API 未及时退出');
      }),
    ]);
  }
  if (mock) {
    mock.closeAllConnections();
    await new Promise<void>((done) => mock!.close(() => done()));
  }
  await database?.$disconnect();
  if (createdSchema) {
    if (!/^tattoo_p4_publishing_[0-9a-f]{32}$/.test(schema))
      throw new Error('P4 schema 清理范围无效');
    await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
  await connection.end();
  if (storage) {
    if (
      dirname(storage) !== temporaryRoot ||
      !basename(storage).startsWith('tattoo-p4-publishing-')
    )
      throw new Error('P4 素材清理范围无效');
    await rm(storage, { recursive: true });
  }
}, 15000);

describe('P4 普通文章投递 / 真实 PostgreSQL 与模拟微信', () => {
  it('预检无远程副作用，拒绝未认证、跨站、未确认及不完整修订', async () => {
    const target = await account();
    const empty = await article({
      ...fields(),
      coverId: null,
      document: { type: 'doc', content: [] },
    });
    const input = { accountId: target.id, revisionId: empty.revisionId };
    expect((await request('/deliveries/check', 'POST', input, '')).status).toBe(401);
    expect((await request('/deliveries', 'POST', { ...input, confirmed: true }, '')).status).toBe(
      401,
    );
    expect(
      (
        await fetch(`${origin}/api/v1/deliveries`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: 'https://foreign.example',
            'X-Tattoo-Request': '1',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ...input, confirmed: true }),
        })
      ).status,
    ).toBe(403);
    const before = { uploads: uploads.length, drafts: drafts.length };
    const checked = await data<DeliveryCheck>(await request('/deliveries/check', 'POST', input));
    expect(checked.canSubmit).toBe(false);
    expect(checked.limitsVerified).toBe(true);
    expect(checked.problems.join('')).toContain('封面');
    expect(checked.problems.join('')).toContain('正文');
    expect((await request('/deliveries', 'POST', { ...input, confirmed: true })).status).toBe(400);
    expect((await request('/deliveries', 'POST', { ...input, confirmed: false })).status).toBe(400);
    expect({ uploads: uploads.length, drafts: drafts.length }).toEqual(before);
    expect(await database.delivery.count()).toBe(0);
  }, 30000);

  it('明确修订和账号的重复提交只建一个意图，正文/封面分用途且后续编辑不改变排队快照', async () => {
    const target = await account();
    const saved = await article();
    const input = { accountId: target.id, revisionId: saved.revisionId };
    const checked = await data<DeliveryCheck>(await request('/deliveries/check', 'POST', input));
    expect(checked).toMatchObject({
      revisionId: saved.revisionId,
      version: 1,
      title: saved.title,
      canSubmit: true,
      existingDelivery: null,
    });
    expect(checked.savedAt).toBe(
      (
        await database.revision.findUniqueOrThrow({ where: { id: saved.revisionId } })
      ).createdAt.toISOString(),
    );
    const posted = await Promise.all(
      Array.from({ length: 5 }, () => enqueue(saved.revisionId, target.id)),
    );
    expect(new Set(posted.map((row) => row.id)).size).toBe(1);
    const changed = await data<Article>(
      await request(`/articles/${saved.id}`, 'PATCH', {
        ...fields('后续编辑的另一份正文'),
        expectedVersion: 1,
      }),
    );
    expect(changed.version).toBe(2);
    const before = { uploads: uploads.length, drafts: drafts.length };
    expect(await processNext()).toBe(true);
    const row = await database.delivery.findUniqueOrThrow({ where: { id: posted[0]!.id } });
    expect(row).toMatchObject({
      state: 'SUCCEEDED',
      revisionId: saved.revisionId,
      resultSource: 'api',
    });
    expect(drafts.length - before.drafts).toBe(1);
    const payload = drafts.at(-1)!.payload.articles[0]!;
    expect(payload).toMatchObject({
      title: saved.title,
      author: saved.author,
      digest: saved.digest,
      content_source_url: saved.sourceUrl,
    });
    expect(payload.content).toContain('正文中的图片来自本地素材');
    expect(payload.content).not.toContain('后续编辑');
    expect(payload.content).not.toContain('/api/v1/assets/');
    expect(payload.content.match(/mmbiz\.qpic\.cn/g)).toHaveLength(2);
    const mapping = await database.remoteAsset.findMany({
      where: { accountId: target.id, assetId },
    });
    expect(mapping).toHaveLength(2);
    expect(mapping.find((entry) => entry.kind === 'COVER')?.remoteId).toBe(payload.thumb_media_id);
    expect(mapping.find((entry) => entry.kind === 'BODY')?.url).toContain(target.appId);
    expect(uploads.slice(before.uploads).map((entry) => entry.kind)).toEqual(['COVER', 'BODY']);
    expect(row.artifact).toMatchObject({
      revisionId: saved.revisionId,
      accountId: target.id,
      renderVersion: platform.renderVersion,
    });
    expect(await readFile((await assets.getFile(assetId)).path)).toEqual(original);
    const existing = await data<DeliveryCheck>(await request('/deliveries/check', 'POST', input));
    expect(existing).toMatchObject({
      canSubmit: false,
      existingDelivery: { id: row.id, state: 'SUCCEEDED' },
    });
    const disabled = new PublishingService(
      database as Database,
      accounts,
      assets,
      platform,
      { ...config, REMOTE_WRITES_ENABLED: false },
      executor,
    );
    expect((await disabled.create({ ...input, confirmed: true }, email)).id).toBe(row.id);
    const sameAccountNext = await enqueue(changed.revisionId, target.id);
    const uploadCount = uploads.length;
    expect(await processNext()).toBe(true);
    expect(
      (await database.delivery.findUniqueOrThrow({ where: { id: sameAccountNext.id } })).state,
    ).toBe('SUCCEEDED');
    expect(uploads.length).toBe(uploadCount);
    const second = await account();
    await enqueue(saved.revisionId, second.id);
    await processNext();
    expect(uploads.slice(uploadCount).map((entry) => entry.kind)).toEqual(['COVER', 'BODY']);
    expect(drafts.at(-1)!.payload.articles[0]!.content).toContain(second.appId);
    expect(drafts.at(-1)!.payload.articles[0]!.content).not.toContain(target.appId);
    expect(await processNext()).toBe(false);
  }, 30000);

  it('替换微信图片地址后再次检查最终 HTML，超限产物不进入新增草稿阶段', async () => {
    const target = await account();
    const base = renderDocument(document('x')).length;
    const saved = await article(fields('x'.repeat(19_990 - base + 1)));
    const checked = await data<DeliveryCheck>(
      await request('/deliveries/check', 'POST', {
        revisionId: saved.revisionId,
        accountId: target.id,
      }),
    );
    expect(checked.canSubmit).toBe(true);
    const queued = await enqueue(saved.revisionId, target.id);
    const before = drafts.length;
    longBodyUrl = true;
    await processNext();
    const row = await database.delivery.findUniqueOrThrow({ where: { id: queued.id } });
    expect(row.state).toBe('FAILED');
    expect(row.submissionStartedAt).toBeNull();
    expect(row.error).toContain('正文');
    expect(drafts.length).toBe(before);
    expect(row.artifact).toMatchObject({ revisionId: saved.revisionId });
  }, 30000);

  it('明确无效封面或坏正文映射只清当前账号用途，显式重试复用意图并保留执行历史', async () => {
    const target = await account();
    const saved = await article();
    const queued = await enqueue(saved.revisionId, target.id);
    draftMode = 'invalid_cover';
    await processNext();
    expect((await database.delivery.findUniqueOrThrow({ where: { id: queued.id } })).state).toBe(
      'FAILED',
    );
    expect(
      await database.remoteAsset.count({ where: { accountId: target.id, kind: 'COVER' } }),
    ).toBe(0);
    expect(
      await database.remoteAsset.count({ where: { accountId: target.id, kind: 'BODY' } }),
    ).toBe(1);
    const before = uploads.length;
    draftMode = 'success';
    await data(await request(`/deliveries/${queued.id}/retry`, 'POST', { confirmed: true }));
    await processNext();
    expect(uploads.slice(before).map((entry) => entry.kind)).toEqual(['COVER']);
    expect(await database.deliveryAttempt.count({ where: { deliveryId: queued.id } })).toBe(2);
    expect((await database.delivery.findUniqueOrThrow({ where: { id: queued.id } })).state).toBe(
      'SUCCEEDED',
    );
    const changed = await article();
    await database.remoteAsset.update({
      where: { accountId_assetId_kind: { accountId: target.id, assetId, kind: 'BODY' } },
      data: { url: 'https://invalid.example/photo.jpg' },
    });
    const bad = await enqueue(changed.revisionId, target.id);
    const draftsBefore = drafts.length;
    await processNext();
    expect((await database.delivery.findUniqueOrThrow({ where: { id: bad.id } })).state).toBe(
      'FAILED',
    );
    expect(drafts.length).toBe(draftsBefore);
    expect(
      await database.remoteAsset.count({ where: { accountId: target.id, kind: 'COVER' } }),
    ).toBe(1);
    expect(
      await database.remoteAsset.count({ where: { accountId: target.id, kind: 'BODY' } }),
    ).toBe(0);
    const retryUploads = uploads.length;
    await data(await request(`/deliveries/${bad.id}/retry`, 'POST', { confirmed: true }));
    await processNext();
    expect(uploads.slice(retryUploads).map((entry) => entry.kind)).toEqual(['BODY']);
    expect((await database.delivery.findUniqueOrThrow({ where: { id: bad.id } })).state).toBe(
      'SUCCEEDED',
    );
  }, 30000);

  it('新增草稿响应丢失进入待核对，不自动重发，人工确认不会冒充接口权限验证', async () => {
    const target = await account();
    const saved = await article();
    const queued = await enqueue(saved.revisionId, target.id);
    const capabilities = (await database.account.findUniqueOrThrow({ where: { id: target.id } }))
      .capabilities;
    draftMode = 'disconnect';
    const before = drafts.length;
    await processNext();
    const row = await database.delivery.findUniqueOrThrow({ where: { id: queued.id } });
    expect(row.state).toBe('UNCERTAIN');
    expect(row.submissionStartedAt).not.toBeNull();
    expect(await processNext()).toBe(false);
    expect(drafts.length - before).toBe(1);
    expect((await request(`/deliveries/${row.id}/retry`, 'POST', { confirmed: true })).status).toBe(
      409,
    );
    const resolved = await data<Delivery>(
      await request(`/deliveries/${row.id}/resolve`, 'POST', {
        outcome: 'created',
        note: '测试人工核对已创建',
        workerStoppedConfirmed: true,
      }),
    );
    expect(resolved).toMatchObject({ state: 'SUCCEEDED', resultSource: 'manual', remoteId: null });
    expect(
      (await database.account.findUniqueOrThrow({ where: { id: target.id } })).capabilities,
    ).toEqual(capabilities);
  }, 30000);

  it('正文上传期间账号凭证不能轮换，token 等待后再次检查旧执行权再发实际上传请求', async () => {
    const target = await account();
    const saved = await article();
    const queued = await enqueue(saved.revisionId, target.id);
    const blockedBody = barrier();
    bodyHook = blockedBody.hook;
    const pending = processNext();
    await blockedBody.reached;
    expect(
      (
        await request(`/accounts/${target.id}`, 'PATCH', {
          appSecret: 'mock-replacement-secret-for-p4',
        })
      ).status,
    ).toBe(409);
    blockedBody.release();
    await pending;
    expect((await database.delivery.findUniqueOrThrow({ where: { id: queued.id } })).state).toBe(
      'SUCCEEDED',
    );
    bodyHook = null;
    const second = await account();
    const next = await enqueue(saved.revisionId, second.id);
    const blockedToken = barrier();
    tokenHook = blockedToken.hook;
    const uploadsBefore = uploads.length;
    const draftsBefore = drafts.length;
    const nextPending = processNext();
    await blockedToken.reached;
    const replacementExecution = randomUUID();
    await database.delivery.update({
      where: { id: next.id },
      data: { executionId: replacementExecution },
    });
    blockedToken.release();
    await nextPending;
    const fenced = await database.delivery.findUniqueOrThrow({ where: { id: next.id } });
    expect(fenced).toMatchObject({ state: 'RUNNING', executionId: replacementExecution });
    expect(uploads.length).toBe(uploadsBefore);
    expect(drafts.length).toBe(draftsBefore);
  }, 30000);

  it('准备阶段恢复排队，危险提交恢复为待核对，不能因恢复重复创建', async () => {
    const first = await account(),
      second = await account();
    const saved = await article();
    const safe = await enqueue(saved.revisionId, first.id),
      danger = await enqueue(saved.revisionId, second.id);
    for (const [record, marked] of [
      [safe, false],
      [danger, true],
    ] as const) {
      const executionId = randomUUID();
      await database.delivery.update({
        where: { id: record.id },
        data: { state: 'RUNNING', executionId, submissionStartedAt: marked ? new Date() : null },
      });
      await database.deliveryAttempt.create({
        data: { id: executionId, deliveryId: record.id, number: 1, stage: '中断前阶段' },
      });
    }
    await publishing.recover();
    expect((await database.delivery.findUniqueOrThrow({ where: { id: safe.id } })).state).toBe(
      'QUEUED',
    );
    expect((await database.delivery.findUniqueOrThrow({ where: { id: danger.id } })).state).toBe(
      'UNCERTAIN',
    );
    const before = drafts.length;
    await processNext();
    expect(drafts.length - before).toBe(1);
    expect((await database.delivery.findUniqueOrThrow({ where: { id: safe.id } })).state).toBe(
      'SUCCEEDED',
    );
    expect(await processNext()).toBe(false);
    expect(unknownPaths).toEqual([]);
  }, 30000);
});
