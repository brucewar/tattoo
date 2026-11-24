import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import {
  sourceJobInput,
  type Source,
  type SourceFeed,
  type SourceJob,
  type SourceSearchConfig,
  type SourceSummary,
} from '@tattoo/contracts';
import type { z } from 'zod';
import { Client } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/server/src/config';
import type { Database } from '../../apps/server/src/database';
import { SecretBox } from '../../apps/server/src/security';
import { SourcesService } from '../../apps/server/src/sources/service';
import { createSourcesMock } from '../helpers/sources-mock.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/test/i.test(new URL(databaseUrl).pathname))
  throw new Error('Sources 集成测试只允许专用测试库');
const schema = `tattoo_sources_${randomUUID().replaceAll('-', '')}`;
const scopedUrl = new URL(databaseUrl);
scopedUrl.searchParams.set('schema', schema);
const connection = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
const email = 'sources-integration@example.com';
const password = 'sources-integration-test-password';
const key = 'tavily-test-key-never-real';
const encryptionKey = Buffer.alloc(32, 27).toString('base64');
let database: PrismaClient;
let sources: SourcesService;
let mock: Server | undefined;
let fixture: ReturnType<typeof createSourcesMock>;
let api: ChildProcess | undefined;
let apiLogs = '';
let origin = '';
let sourceOrigin = '';
let cookie = '';
let createdSchema = false;
let storage = '';
let temporaryRoot = '';
const processing = new Set<Promise<boolean>>();
type Page<T> = { items: T[]; total: number; page: number; pageSize: number };
type NewSourceJob<T> = T extends unknown ? Omit<T, 'requestKey'> & { requestKey?: string } : never;

function request(path: string, method = 'GET', body?: unknown, session = cookie) {
  return fetch(origin + '/api/v1' + path, {
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
  const body = (await response.json()) as { data: T; error?: unknown };
  expect(response.ok, JSON.stringify(body)).toBe(true);
  return body.data;
}
async function configure(overrides: Record<string, unknown> = {}) {
  return data<SourceSearchConfig>(
    await request('/sources/search-config', 'PUT', {
      baseUrl: sourceOrigin,
      apiKey: key,
      ...overrides,
    }),
  );
}
async function enqueue(input: NewSourceJob<z.input<typeof sourceJobInput>>) {
  return data<SourceJob>(
    await request('/sources/jobs', 'POST', { requestKey: randomUUID(), ...input }),
  );
}
async function getJob(id: string) {
  return data<SourceJob>(await request('/sources/jobs/' + id));
}
async function getSource(id: string) {
  return data<Source>(await request('/sources/' + id));
}
function processNext() {
  const running = sources.processNext(async () => undefined);
  processing.add(running);
  void running.finally(() => processing.delete(running)).catch(() => undefined);
  return running;
}
async function unusedPort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配 Sources API 端口');
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

beforeAll(async () => {
  await connection.connect();
  await connection.query(`CREATE SCHEMA "${schema}"`);
  createdSchema = true;
  await connection.query(`SET search_path TO "${schema}"`);
  const migrations = resolve('apps/server/prisma/migrations');
  for (const item of (await readdir(migrations, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name)))
    await connection.query(await readFile(join(migrations, item.name, 'migration.sql'), 'utf8'));
  database = new PrismaClient({ datasources: { db: { url: scopedUrl.toString() } } });
  await database.$connect();
  temporaryRoot = await realpath(tmpdir());
  storage = await mkdtemp(join(temporaryRoot, 'tattoo-sources-integration-'));
  fixture = createSourcesMock();
  mock = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const pathname = new URL(incoming.url ?? '/', 'http://mock.invalid').pathname;
    if (!(await fixture.handle(incoming, outgoing, pathname, Buffer.concat(chunks)))) {
      outgoing.statusCode = 404;
      outgoing.end('unexpected fixture route');
    }
  });
  await new Promise<void>((done) => mock!.listen(0, '127.0.0.1', done));
  const address = mock.address();
  if (!address || typeof address === 'string') throw new Error('Sources fixture未监听');
  sourceOrigin = `http://127.0.0.1:${address.port}`;
  origin = `http://127.0.0.1:${await unusedPort()}`;
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: scopedUrl.toString(),
    APP_ENCRYPTION_KEY: encryptionKey,
    APP_ORIGIN: origin,
    PORT: new URL(origin).port,
    STORAGE_PATH: storage,
    ADMIN_EMAIL: email,
    ADMIN_PASSWORD: password,
    COOKIE_SECURE: 'false',
    REMOTE_WRITES_ENABLED: 'false',
    SOURCES_TEST_ORIGIN: sourceOrigin,
  };
  sources = new SourcesService(database as Database, loadConfig(env));
  api = spawn(process.execPath, [resolve('apps/server/dist/main.js')], {
    cwd: resolve('.'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  for (const output of [api.stdout, api.stderr])
    output?.on('data', (chunk: Buffer) => {
      apiLogs = (apiLogs + chunk.toString('utf8')).slice(-32768);
    });
  const deadline = Date.now() + 60000;
  let ready = false;
  while (Date.now() < deadline) {
    if (api.exitCode !== null) throw new Error('Sources API提前退出：' + apiLogs);
    try {
      ready = (await fetch(origin + '/api/v1/health/ready', { signal: AbortSignal.timeout(1000) }))
        .ok;
    } catch {}
    if (ready) break;
    await sleep(100);
  }
  if (!ready) throw new Error('Sources API就绪超时：' + apiLogs);
  const login = await request('/auth/login', 'POST', { email, password }, '');
  await data(login);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
}, 90000);

afterEach(async () => {
  fixture?.releaseAll();
  await Promise.allSettled([...processing]);
  fixture?.control({
    nextArticle: 'success',
    nextFeed: 'success',
    nextSearch: 'success',
    articleVersion: 1,
  });
  await database?.sourceJob.updateMany({
    where: { state: { in: ['QUEUED', 'RUNNING'] } },
    data: { state: 'FAILED', executionId: null },
  });
}, 35000);
afterAll(async () => {
  if (api && api.exitCode === null && api.signalCode === null) {
    const exited = new Promise<void>((done) => api!.once('exit', () => done()));
    api.kill('SIGKILL');
    await Promise.race([
      exited,
      sleep(5000).then(() => {
        throw new Error('Sources API未及时退出');
      }),
    ]);
  }
  fixture?.releaseAll();
  if (mock) {
    mock.closeAllConnections();
    await new Promise<void>((done) => mock!.close(() => done()));
  }
  await database?.$disconnect();
  if (createdSchema) {
    if (!/^tattoo_sources_[0-9a-f]{32}$/.test(schema))
      throw new Error('Sources schema清理范围无效');
    await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
  await connection.end();
  if (storage) {
    if (
      dirname(storage) !== temporaryRoot ||
      !basename(storage).startsWith('tattoo-sources-integration-')
    )
      throw new Error('Sources临时目录清理范围无效');
    await rm(storage, { recursive: true });
  }
}, 15000);

describe('P9 资料获取 / 真实 API、PostgreSQL 与隔离 HTTP 来源', () => {
  it('资料、订阅、配置与任务均需登录，跨站写被拒绝，未配置搜索不收费', async () => {
    for (const path of ['/sources', '/sources/feeds', '/sources/jobs', '/sources/search-config'])
      expect((await request(path, 'GET', undefined, '')).status).toBe(401);
    expect(
      (
        await request(
          '/sources/jobs',
          'POST',
          { requestKey: randomUUID(), kind: 'URL', url: sourceOrigin + '/sources/article' },
          '',
        )
      ).status,
    ).toBe(401);
    const rejected = await fetch(origin + '/api/v1/sources/feeds', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'https://foreign.example',
        'X-Tattoo-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ url: sourceOrigin + '/sources/feed' }),
    });
    expect(rejected.status).toBe(403);
    expect(
      (
        await request('/sources/jobs', 'POST', {
          requestKey: randomUUID(),
          kind: 'SEARCH',
          query: '未配置时的查询',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/sources/jobs', 'POST', {
          requestKey: randomUUID(),
          kind: 'URL',
          url: 'file:///etc/passwd',
        })
      ).status,
    ).toBe(400);
    expect(fixture.calls).toEqual({ article: 0, feed: 0, search: 0 });
  });

  it('Tavily配置加密、脱敏和持久保存，空密钥保留且跨来源不能沿用旧Key', async () => {
    const saved = await configure();
    expect(saved.hasApiKey).toBe(true);
    const stored = await database.sourceSearchConfig.findUniqueOrThrow({
      where: { id: 'default' },
    });
    expect(stored.apiKeyEncrypted).not.toBe(key);
    expect(new SecretBox(encryptionKey).decrypt(stored.apiKeyEncrypted)).toBe(key);
    const body = await (await request('/sources/search-config')).text();
    expect(body).not.toContain(key);
    expect(body).not.toContain('apiKeyEncrypted');
    const unchanged = await configure({ apiKey: '' });
    expect(unchanged.version).toBe(saved.version);
    expect(
      (await request('/sources/search-config', 'PUT', { baseUrl: 'https://other.example' })).status,
    ).toBe(400);
    expect(
      (await request('/sources/search-config', 'PUT', { baseUrl: sourceOrigin, apiKey: 'bad key' }))
        .status,
    ).toBe(400);
    await configure({ apiKey: '', clearApiKey: true });
    expect(
      (await data<SourceSearchConfig>(await request('/sources/search-config'))).hasApiKey,
    ).toBe(false);
    expect(
      (
        await request('/sources/jobs', 'POST', {
          requestKey: randomUUID(),
          kind: 'SEARCH',
          query: '密钥清除后',
        })
      ).status,
    ).toBe(400);
    await configure();
  });

  it('链接任务持久排队，重复nonce只获取一次，冲突请求拒绝，结果为纯文本并保留来源', async () => {
    const before = fixture.calls.article;
    const requestKey = randomUUID();
    const url = sourceOrigin + '/sources/article?intent=' + requestKey;
    const job = await enqueue({ kind: 'URL', requestKey, url: url + '#fragment' });
    expect(job.state).toBe('QUEUED');
    expect(job.url).toBe(url);
    expect((await enqueue({ kind: 'URL', requestKey, url })).id).toBe(job.id);
    expect(
      (
        await request('/sources/jobs', 'POST', {
          kind: 'URL',
          requestKey,
          url: url + '&different=1',
        })
      ).status,
    ).toBe(409);
    expect(fixture.calls.article).toBe(before);
    await processNext();
    const completed = await getJob(job.id);
    expect(completed.state).toBe('SUCCEEDED');
    expect(completed.result).toMatchObject({ created: 1, updated: 0, items: [] });
    const source = await getSource(completed.result!.sourceIds[0]!);
    expect(source).toMatchObject({
      url,
      resolvedUrl: url,
      title: 'Tattoo 资料测试文章',
      contentKind: 'article',
      origin: 'url',
      publishedAt: '2026-11-24T08:00:00.000Z',
    });
    expect(source.text).toContain('第 1 版已采集的正文参考');
    expect(source.text).not.toContain('<p>');
    expect(source.text).not.toContain('导航噪声');
    expect(fixture.requests.at(-1)!.authorizationHash).toBe('');
    expect(fixture.calls.article).toBe(before + 1);
    expect((await enqueue({ kind: 'URL', requestKey, url })).id).toBe(job.id);
    expect(await processNext()).toBe(false);
    expect(fixture.calls.article).toBe(before + 1);
    expect(await database.article.count()).toBe(0);
    expect(await database.generationJob.count()).toBe(0);
    expect(await database.delivery.count()).toBe(0);
  });

  it('相同URL刷新不增加资料，新正文更新hash并保留资料身份', async () => {
    const url = sourceOrigin + '/sources/article?refresh=' + randomUUID();
    const first = await enqueue({ kind: 'URL', url });
    await processNext();
    const firstSource = await getSource((await getJob(first.id)).result!.sourceIds[0]!);
    const unchanged = await enqueue({ kind: 'URL', url });
    await processNext();
    expect((await getJob(unchanged.id)).result).toMatchObject({
      created: 0,
      updated: 0,
      sourceIds: [firstSource.id],
    });
    const count = await database.source.count();
    fixture.control({ articleVersion: 2 });
    const refresh = await enqueue({ kind: 'URL', url });
    await processNext();
    expect((await getJob(refresh.id)).result).toMatchObject({
      created: 0,
      updated: 1,
      sourceIds: [firstSource.id],
    });
    const updated = await getSource(firstSource.id);
    expect(updated.contentHash).not.toBe(firstSource.contentHash);
    expect(updated.text).toContain('第 2 版');
    expect(await database.source.count()).toBe(count);
  });

  it('搜索仅保存候选，显式选择后才采集全文，实际请求关闭付费升级与图片/答案附加项', async () => {
    const configured = await configure();
    const before = await database.source.count();
    const calls = fixture.calls.search;
    const job = await enqueue({ kind: 'SEARCH', query: '面向创作者的公开资料' });
    expect(job.configVersion).toBe(configured.version);
    await processNext();
    const completed = await getJob(job.id);
    expect(completed.state).toBe('SUCCEEDED');
    expect(completed.result?.items).toHaveLength(2);
    expect(completed.result?.sourceIds).toEqual([]);
    expect(await database.source.count()).toBe(before);
    expect(fixture.calls.search).toBe(calls + 1);
    const audited = fixture.requests.at(-1)!;
    expect(audited.authorizationHash).toBe(
      createHash('sha256')
        .update('Bearer ' + key)
        .digest('hex'),
    );
    expect(audited.query).toBe('面向创作者的公开资料');
    expect(audited.payload).toEqual({
      topic: 'general',
      search_depth: 'basic',
      auto_parameters: false,
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      bodyHasApiKey: false,
    });
    const selected = await enqueue({
      kind: 'URL',
      url: completed.result!.items[1]!.url,
      origin: 'search',
    });
    await processNext();
    const material = await getSource((await getJob(selected.id)).result!.sourceIds[0]!);
    expect(material.origin).toBe('search');
    expect(material.contentKind).toBe('article');
    expect(material.text).toContain('已采集的正文参考');
    expect(material.text).not.toContain('另一篇文章的搜索摘要');
  });

  it('RSS手动拉取、订阅和条目去重，已有全文不被后续摘要降级', async () => {
    const feed = await data<SourceFeed>(
      await request('/sources/feeds', 'POST', { url: sourceOrigin + '/sources/feed' }),
    );
    const duplicate = await data<SourceFeed>(
      await request('/sources/feeds', 'POST', { url: sourceOrigin + '/sources/feed#section' }),
    );
    expect(duplicate.id).toBe(feed.id);
    const before = { ...fixture.calls };
    const job = await enqueue({ kind: 'FEED', feedId: feed.id });
    expect(fixture.calls.feed).toBe(before.feed);
    await processNext();
    const completed = await getJob(job.id);
    expect(completed.state).toBe('SUCCEEDED');
    expect(completed.result!.sourceIds).toHaveLength(2);
    expect(fixture.calls.feed).toBe(before.feed + 1);
    expect(fixture.calls.article).toBe(before.article);
    const first = await getSource(completed.result!.sourceIds[0]!);
    const second = await getSource(completed.result!.sourceIds[1]!);
    expect(first).toMatchObject({
      contentKind: 'feed',
      origin: 'rss',
      feedId: feed.id,
      feedUrl: feed.url,
    });
    expect(first.text).toBe('RSS摘要，可能不是全文。');
    expect(second.contentKind).toBe('article');
    expect(second.text).toContain('已采集的正文参考');
    const count = await database.source.count();
    const refresh = await enqueue({ kind: 'FEED', feedId: feed.id });
    await processNext();
    expect((await getJob(refresh.id)).result).toMatchObject({ created: 0, updated: 0 });
    expect(await database.source.count()).toBe(count);
    const feeds = await data<Page<SourceFeed>>(await request('/sources/feeds'));
    expect(feeds.items.find((row) => row.id === feed.id)).toMatchObject({
      title: 'RSS 测试订阅',
      lastError: null,
    });
    expect(feeds.items.find((row) => row.id === feed.id)!.lastFetchedAt).toBeTruthy();
  });

  it('RSS资料可补齐全文，继续刷新RSS仍保留正文；列表省略全文而详情可读', async () => {
    const existing = await database.source.findUniqueOrThrow({
      where: {
        urlHash: createHash('sha256')
          .update(sourceOrigin + '/sources/article')
          .digest('hex'),
      },
    });
    expect(existing.contentKind).toBe('feed');
    const full = await enqueue({ kind: 'URL', url: existing.url });
    await processNext();
    expect((await getJob(full.id)).result?.sourceIds).toEqual([existing.id]);
    const body = await getSource(existing.id);
    expect(body.contentKind).toBe('article');
    const feed = await database.sourceFeed.findUniqueOrThrow({ where: { id: existing.feedId! } });
    await enqueue({ kind: 'FEED', feedId: feed.id });
    await processNext();
    expect((await getSource(existing.id)).contentHash).toBe(body.contentHash);
    const listed = await data<Page<SourceSummary>>(
      await request('/sources?search=' + encodeURIComponent('已采集的正文参考')),
    );
    const summary = listed.items.find((row) => row.id === existing.id)!;
    expect(summary.textLength).toBe(body.text.length);
    expect(summary).not.toHaveProperty('text');
  });

  it('取消订阅保留已有资料及来源，旧排队拉取不会继续联网', async () => {
    const feed = await data<SourceFeed>(
      await request('/sources/feeds', 'POST', {
        url: sourceOrigin + '/sources/atom',
        title: '本地Atom',
      }),
    );
    const first = await enqueue({ kind: 'FEED', feedId: feed.id });
    await processNext();
    const sourceId = (await getJob(first.id)).result!.sourceIds[0]!;
    expect((await getSource(sourceId)).text).toContain('Atom提供的摘要资料');
    const queued = await enqueue({ kind: 'FEED', feedId: feed.id });
    expect((await request('/sources/feeds/' + feed.id, 'DELETE')).ok).toBe(true);
    const before = fixture.calls.feed;
    await processNext();
    expect((await getJob(queued.id)).state).toBe('FAILED');
    expect(fixture.calls.feed).toBe(before);
    expect(await getSource(sourceId)).toMatchObject({ feedId: null, feedUrl: feed.url });
  });

  it('搜索配置变化隔离旧排队任务，执行中禁止轮换或取消正在拉取的订阅', async () => {
    await configure();
    const queued = await enqueue({ kind: 'SEARCH', query: '旧配置搜索' });
    const before = fixture.calls.search;
    await configure({ apiKey: key + '-rotated' });
    await processNext();
    expect((await getJob(queued.id)).state).toBe('FAILED');
    expect(fixture.calls.search).toBe(before);
    fixture.control({ nextSearch: 'hold' });
    const running = await enqueue({ kind: 'SEARCH', query: '执行中的搜索' });
    const done = processNext();
    await expect.poll(() => fixture.calls.search).toBe(before + 1);
    expect(
      (await request('/sources/search-config', 'PUT', { baseUrl: sourceOrigin, apiKey: key }))
        .status,
    ).toBe(409);
    fixture.releaseAll();
    await done;
    expect((await getJob(running.id)).state).toBe('SUCCEEDED');
    const feed = await data<SourceFeed>(
      await request('/sources/feeds', 'POST', { url: sourceOrigin + '/sources/feed?held=1' }),
    );
    fixture.control({ nextFeed: 'hold' });
    const fetching = await enqueue({ kind: 'FEED', feedId: feed.id });
    const feedDone = processNext();
    await expect.poll(async () => (await getJob(fetching.id)).state).toBe('RUNNING');
    expect((await request('/sources/feeds/' + feed.id, 'DELETE')).status).toBe(409);
    fixture.releaseAll();
    await feedDone;
    expect((await getJob(fetching.id)).state).toBe('SUCCEEDED');
  });

  it('恢复隔离运行中的付费搜索，迟到结果不能覆盖状态或再次收费', async () => {
    await configure();
    fixture.control({ nextSearch: 'hold' });
    const requestKey = randomUUID();
    const job = await enqueue({ kind: 'SEARCH', query: '恢复不得重发', requestKey });
    const before = fixture.calls.search;
    const done = processNext();
    await expect.poll(() => fixture.calls.search).toBe(before + 1);
    await sources.recover();
    expect((await getJob(job.id)).state).toBe('UNCERTAIN');
    fixture.releaseAll();
    await done;
    const recovered = await getJob(job.id);
    expect(recovered.state).toBe('UNCERTAIN');
    expect(recovered.result).toBeNull();
    expect((await enqueue({ kind: 'SEARCH', query: '恢复不得重发', requestKey })).id).toBe(job.id);
    expect(await processNext()).toBe(false);
    expect(fixture.calls.search).toBe(before + 1);
  });

  it.each([
    ['refused', 'FAILED'],
    ['malformed', 'FAILED'],
    ['disconnect', 'UNCERTAIN'],
  ] as const)('Tavily %s 不成为成功候选，也不自动重发', async (mode, state) => {
    await configure();
    fixture.control({ nextSearch: mode });
    const before = fixture.calls.search;
    const job = await enqueue({ kind: 'SEARCH', query: '失败模拟-' + mode });
    await processNext();
    const failed = await getJob(job.id);
    expect(failed.state).toBe(state);
    expect(failed.result).toBeNull();
    expect(failed.error).toBeTruthy();
    expect(JSON.stringify(failed)).not.toContain(key);
    expect(await processNext()).toBe(false);
    expect(fixture.calls.search).toBe(before + 1);
  });

  it('重定向私网和RSS实体声明被拒绝，不生成伪成功资料', async () => {
    const count = await database.source.count();
    const redirected = await enqueue({
      kind: 'URL',
      url: sourceOrigin + '/sources/private-redirect',
    });
    await processNext();
    expect((await getJob(redirected.id)).state).toBe('FAILED');
    const feed = await data<SourceFeed>(
      await request('/sources/feeds', 'POST', { url: sourceOrigin + '/sources/entity' }),
    );
    const entity = await enqueue({ kind: 'FEED', feedId: feed.id });
    await processNext();
    expect((await getJob(entity.id)).state).toBe('FAILED');
    expect(await database.source.count()).toBe(count);
    const feeds = await data<Page<SourceFeed>>(await request('/sources/feeds'));
    expect(feeds.items.find((row) => row.id === feed.id)!.lastError).toContain('DTD');
  });
});
