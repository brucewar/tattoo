import { createHash, randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import type {
  AiGenerationInput,
  AiGenerationJob,
  AiModelConfig,
  AiModels,
  AiTextProtocol,
  Article,
  TopicCreationTask,
} from '@tattoo/contracts';
import { Client } from 'pg';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AiService } from '../../apps/server/src/ai/service';
import { TopicCreationService } from '../../apps/server/src/ai/topics';
import { ContentService } from '../../apps/server/src/content/service';
import { AssetsService } from '../../apps/server/src/assets/service';
import { loadConfig, type Config } from '../../apps/server/src/config';
import type { Database } from '../../apps/server/src/database';
import { SecretBox } from '../../apps/server/src/security';
import { createAiMock, type AiMockMode } from '../helpers/ai-mock.mjs';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/test/i.test(new URL(databaseUrl).pathname))
  throw new Error('AI 集成测试只允许专用测试库');
const schema = `tattoo_ai_${randomUUID().replaceAll('-', '')}`;
const scopedUrl = new URL(databaseUrl);
scopedUrl.searchParams.set('schema', schema);
const connection = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
const email = 'ai-integration@example.com';
const password = 'ai-integration-test-password';
const textKey = 'ai-text-test-key-never-real';
const imageKey = 'ai-image-test-key-never-real';
const encryptionKey = Buffer.alloc(32, 21).toString('base64');
let database: PrismaClient;
let ai: AiService;
let topics: TopicCreationService;
let content: ContentService;
let config: Config;
let mock: Server | undefined;
let model: ReturnType<typeof createAiMock>;
let api: ChildProcess | undefined;
let apiLogs = '';
let origin = '';
let modelBaseUrl = '';
let cookie = '';
let createdSchema = false;
let storage = '';
let temporaryRoot = '';
const processing = new Set<Promise<boolean>>();

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

async function configure(capability: 'text' | 'image', overrides: Record<string, unknown> = {}) {
  return data<AiModelConfig>(
    await request('/ai/models/' + capability, 'PUT', {
      baseUrl: modelBaseUrl,
      model: `test-${capability}-model`,
      apiKey: capability === 'text' ? textKey : imageKey,
      imageSize: capability === 'image' ? '1536x1024' : '',
      imageResponseFormat: 'auto',
      ...overrides,
    }),
  );
}

async function enqueue(kind: AiGenerationInput['kind'], overrides: Record<string, unknown> = {}) {
  return data<AiGenerationJob>(
    await request('/ai/jobs', 'POST', {
      requestKey: randomUUID(),
      kind,
      prompt: kind.startsWith('TEST_') ? '' : '请生成一份可编辑的本地测试内容',
      ...(kind === 'REWRITE' ? { sourceText: '等待改写的原文。' } : {}),
      ...overrides,
    }),
  );
}

async function getJob(id: string) {
  return data<AiGenerationJob>(await request('/ai/jobs/' + id));
}

function processNext() {
  const running = ai.processNext(async () => undefined);
  processing.add(running);
  void running.finally(() => processing.delete(running)).catch(() => undefined);
  return running;
}

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配 AI 测试端口');
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
  storage = await mkdtemp(join(temporaryRoot, 'tattoo-ai-integration-'));
  model = createAiMock(
    await sharp({ create: { width: 240, height: 140, channels: 3, background: '#476b5a' } })
      .png()
      .toBuffer(),
  );
  mock = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const pathname = new URL(incoming.url ?? '/', 'http://mock.local').pathname;
    outgoing.setHeader('Content-Type', 'application/json');
    if (!(await model.handle(incoming, outgoing, pathname, Buffer.concat(chunks)))) {
      outgoing.statusCode = 404;
      outgoing.end(JSON.stringify({ error: 'unexpected model path' }));
    }
  });
  await new Promise<void>((done) => mock!.listen(0, '127.0.0.1', done));
  const address = mock.address();
  if (!address || typeof address === 'string') throw new Error('模型接口未监听');
  modelBaseUrl = `http://127.0.0.1:${address.port}/v1`;
  const apiPort = await unusedPort();
  origin = `http://127.0.0.1:${apiPort}`;
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: scopedUrl.toString(),
    APP_ENCRYPTION_KEY: encryptionKey,
    APP_ORIGIN: origin,
    PORT: String(apiPort),
    STORAGE_PATH: storage,
    ADMIN_EMAIL: email,
    ADMIN_PASSWORD: password,
    COOKIE_SECURE: 'false',
    REMOTE_WRITES_ENABLED: 'false',
  };
  config = loadConfig(env);
  ai = new AiService(database as Database, config, new AssetsService(database as Database, config));
  content = new ContentService(database as Database);
  topics = new TopicCreationService(database as Database, content);
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
    if (api.exitCode !== null) throw new Error('AI API 提前退出：' + apiLogs);
    try {
      ready = (await fetch(origin + '/api/v1/health/ready', { signal: AbortSignal.timeout(1000) }))
        .ok;
    } catch {}
    if (ready) break;
    await sleep(100);
  }
  if (!ready) throw new Error('AI API 就绪超时：' + apiLogs);
  const login = await request('/auth/login', 'POST', { email, password }, '');
  await data(login);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
}, 90000);

afterEach(async () => {
  model?.releaseAll();
  await Promise.allSettled([...processing]);
  model?.setNext({ nextText: 'success', nextImage: 'success' });
  await database?.generationJob.updateMany({
    where: { state: { in: ['QUEUED', 'RUNNING'] } },
    data: { state: 'FAILED', executionId: null },
  });
  await database?.topicCreation.updateMany({
    where: { state: { in: ['QUEUED', 'RUNNING'] } },
    data: { state: 'FAILED' },
  });
}, 35000);

afterAll(async () => {
  if (api && api.exitCode === null && api.signalCode === null) {
    const exited = new Promise<void>((done) => api!.once('exit', () => done()));
    api.kill('SIGKILL');
    await Promise.race([
      exited,
      sleep(5000).then(() => {
        throw new Error('AI API 未及时退出');
      }),
    ]);
  }
  model?.releaseAll();
  if (mock) {
    mock.closeAllConnections();
    await new Promise<void>((done) => mock!.close(() => done()));
  }
  await database?.$disconnect();
  if (createdSchema) {
    if (!/^tattoo_ai_[0-9a-f]{32}$/.test(schema)) throw new Error('AI schema 清理范围无效');
    await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
  await connection.end();
  if (storage) {
    if (
      dirname(storage) !== temporaryRoot ||
      !basename(storage).startsWith('tattoo-ai-integration-')
    )
      throw new Error('AI 素材清理范围无效');
    await rm(storage, { recursive: true });
  }
}, 15000);

describe('AI 配置与生成 / 真实 API、PostgreSQL 和隔离模型接口', () => {
  it('配置、生成与记录必须登录，跨站写被拒绝，未配置时不创建任务', async () => {
    expect((await request('/ai/models', 'GET', undefined, '')).status).toBe(401);
    expect((await request('/ai/jobs', 'GET', undefined, '')).status).toBe(401);
    expect((await request('/ai/models/text', 'PUT', {}, '')).status).toBe(401);
    const crossSite = await fetch(origin + '/api/v1/ai/models/text', {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        Origin: 'https://foreign.example',
        'X-Tattoo-Request': '1',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(crossSite.status).toBe(403);
    expect(
      (
        await request('/ai/models/text', 'PUT', {
          baseUrl: 'file:///secret',
          model: 'test',
          apiKey: textKey,
        })
      ).status,
    ).toBe(400);
    const missing = await request('/ai/jobs', 'POST', {
      requestKey: randomUUID(),
      kind: 'ARTICLE',
      prompt: '测试文章',
    });
    expect(missing.status).toBe(400);
    expect(await database.generationJob.count()).toBe(0);
    expect(model.calls).toEqual({ text: 0, image: 0 });
    expect((await request('/ai/topics', 'GET', undefined, '')).status).toBe(401);
    await configure('text');
    expect(
      (
        await request('/ai/topics', 'POST', {
          requestKey: randomUUID(),
          topic: '仅一个主题也需要两类模型',
        })
      ).status,
    ).toBe(400);
    expect(await database.topicCreation.count()).toBe(0);
    expect(await database.generationJob.count()).toBe(0);
    expect(model.calls).toEqual({ text: 0, image: 0 });
  });

  it('文本和图片配置分别加密、脱敏与持久保存，空密钥保留原值', async () => {
    const text = await configure('text');
    const image = await configure('image');
    expect(text.protocol).toBe('chat-completions');
    expect(text.anthropicMaxTokens).toBe(4096);
    expect(image.protocol).toBe('images-generations');
    expect(text.hasApiKey).toBe(true);
    const publicResponse = await request('/ai/models');
    const body = await publicResponse.text();
    expect(body).not.toContain(textKey);
    expect(body).not.toContain(imageKey);
    expect(body).not.toContain('apiKeyEncrypted');
    const stored = await database.aiModel.findUniqueOrThrow({ where: { capability: 'text' } });
    expect(stored.apiKeyEncrypted).not.toBe(textKey);
    expect(new SecretBox(encryptionKey).decrypt(stored.apiKeyEncrypted)).toBe(textKey);
    const updated = await configure('text', { apiKey: '', model: 'test-text-model-updated' });
    expect(updated.version).toBe(text.version + 1);
    expect(
      new SecretBox(encryptionKey).decrypt(
        (await database.aiModel.findUniqueOrThrow({ where: { capability: 'text' } }))
          .apiKeyEncrypted,
      ),
    ).toBe(textKey);
    const list = await data<AiModels>(await request('/ai/models'));
    expect(list.text?.model).toBe('test-text-model-updated');
    expect(list.image?.model).toBe('test-image-model');
  });

  it('升级旧数据库保留密钥与任务，回填协议并为历史任务初始化空资料快照', async () => {
    const migrationSchema = `tattoo_ai_migration_${randomUUID().replaceAll('-', '')}`;
    const migrations = resolve('apps/server/prisma/migrations');
    const textId = randomUUID();
    const imageId = randomUUID();
    const preservedKey = new SecretBox(encryptionKey).encrypt(textKey);
    await connection.query('BEGIN');
    try {
      await connection.query(`CREATE SCHEMA "${migrationSchema}"`);
      await connection.query(`SET LOCAL search_path TO "${migrationSchema}"`);
      for (const directory of ['20261120000000_initial', '20261123000000_ai_generation'])
        await connection.query(
          await readFile(join(migrations, directory, 'migration.sql'), 'utf8'),
        );
      for (const [id, capability] of [
        [textId, 'text'],
        [imageId, 'image'],
      ]) {
        await connection.query(
          'INSERT INTO "AiModel" ("id", "capability", "baseUrl", "model", "apiKeyEncrypted", "version", "updatedAt") VALUES ($1, $2, $3, $4, $5, 7, NOW())',
          [id, capability, modelBaseUrl, `legacy-${capability}`, preservedKey],
        );
        await connection.query(
          'INSERT INTO "GenerationJob" ("id", "requestKey", "kind", "capability", "modelId", "model", "configVersion", "inputHash", "prompt", "state", "result", "updatedAt") VALUES ($1, $2, $3, $4, $5, $6, 7, $7, $8, $9, $10, NOW())',
          [
            randomUUID(),
            randomUUID(),
            capability === 'text' ? 'REWRITE' : 'COVER',
            capability,
            id,
            `legacy-${capability}`,
            'legacy-input-hash',
            'legacy prompt',
            'SUCCEEDED',
            JSON.stringify({ type: 'text', text: 'preserved legacy result' }),
          ],
        );
      }
      await connection.query(
        await readFile(join(migrations, '20261124000000_ai_protocols', 'migration.sql'), 'utf8'),
      );
      await connection.query(
        await readFile(join(migrations, '20261124010000_sources', 'migration.sql'), 'utf8'),
      );
      await connection.query(
        await readFile(join(migrations, '20261124120000_topic_creation', 'migration.sql'), 'utf8'),
      );
      expect((await connection.query('SELECT "topicId" FROM "GenerationJob"')).rows).toEqual([
        { topicId: null },
        { topicId: null },
      ]);
      expect(
        Number(
          (await connection.query('SELECT COUNT(*) AS count FROM "TopicCreation"')).rows[0].count,
        ),
      ).toBe(0);
      const references = await connection.query('SELECT "sourceReferences" FROM "GenerationJob"');
      expect(references.rows).toEqual([{ sourceReferences: [] }, { sourceReferences: [] }]);
      for (const table of ['Source', 'SourceFeed', 'SourceSearchConfig', 'SourceJob']) {
        const rows = await connection.query(`SELECT COUNT(*) AS count FROM "${table}"`);
        expect(Number(rows.rows[0].count)).toBe(0);
      }
      const configurations = await connection.query(
        'SELECT "capability", "protocol", "anthropicMaxTokens", "version", "apiKeyEncrypted" FROM "AiModel" ORDER BY "capability"::text',
      );
      expect(configurations.rows).toEqual([
        {
          capability: 'image',
          protocol: 'images-generations',
          anthropicMaxTokens: 4096,
          version: 7,
          apiKeyEncrypted: preservedKey,
        },
        {
          capability: 'text',
          protocol: 'chat-completions',
          anthropicMaxTokens: 4096,
          version: 7,
          apiKeyEncrypted: preservedKey,
        },
      ]);
      const jobs = await connection.query(
        'SELECT "capability", "protocol", "configVersion", "state", "result" FROM "GenerationJob" ORDER BY "capability"::text',
      );
      expect(jobs.rows).toEqual([
        {
          capability: 'image',
          protocol: 'images-generations',
          configVersion: 7,
          state: 'SUCCEEDED',
          result: { type: 'text', text: 'preserved legacy result' },
        },
        {
          capability: 'text',
          protocol: 'chat-completions',
          configVersion: 7,
          state: 'SUCCEEDED',
          result: { type: 'text', text: 'preserved legacy result' },
        },
      ]);
    } finally {
      // Roll back the complete isolated schema, including fixtures and migrated tables.
      await connection.query('ROLLBACK');
    }
  });

  it.each(['chat-completions', 'responses', 'anthropic-messages'] as const)(
    '%s 配置持久保存，并通过真实 HTTP 生成可编辑文章与改写结果',
    async (protocol: AiTextProtocol) => {
      const configured = await configure('text', { protocol, anthropicMaxTokens: 6144 });
      const reloaded = (await data<AiModels>(await request('/ai/models'))).text!;
      expect(reloaded.protocol).toBe(protocol);
      expect(reloaded.version).toBe(configured.version);
      expect(reloaded.anthropicMaxTokens).toBe(protocol === 'anthropic-messages' ? 6144 : 4096);
      const before = model.calls.text;
      const article = await enqueue('ARTICLE');
      expect(article.protocol).toBe(protocol);
      await processNext();
      const completed = await getJob(article.id);
      expect(completed.state).toBe('SUCCEEDED');
      expect(completed.protocol).toBe(protocol);
      expect(completed.result).toMatchObject({ type: 'article', title: 'AI 生成测试文章' });
      expect(JSON.stringify(completed.result)).not.toContain('private reasoning');
      const rewrite = await enqueue('REWRITE');
      await processNext();
      expect((await getJob(rewrite.id)).result).toEqual({
        type: 'text',
        text: '这是模型改写后的段落。',
      });
      expect(model.calls.text).toBe(before + 2);
      const last = model.requests.at(-1)!;
      const hash = (value: string) => createHash('sha256').update(value).digest('hex');
      expect(last.protocol).toBe(protocol);
      expect(last.task).toBe('REWRITE');
      expect(last.stream).toBe(false);
      expect(last.authorizationHash).toBe(
        hash(protocol === 'anthropic-messages' ? '' : 'Bearer ' + textKey),
      );
      expect(last.xApiKeyHash).toBe(hash(protocol === 'anthropic-messages' ? textKey : ''));
      expect(last.anthropicVersion).toBe(protocol === 'anthropic-messages' ? '2023-06-01' : null);
      expect(last.maxTokens).toBe(protocol === 'anthropic-messages' ? 6144 : null);
      expect(last.store).toBe(protocol === 'responses' ? false : null);
      const history = await data<{ items: AiGenerationJob[] }>(await request('/ai/jobs'));
      expect(history.items.find((entry) => entry.id === article.id)?.protocol).toBe(protocol);
    },
  );

  it('切换协议使排队任务失效并保留历史协议，输出上限变更也产生新配置版本', async () => {
    const original = await configure('text', { protocol: 'responses' });
    const queued = await enqueue('ARTICLE');
    const before = model.calls.text;
    const changed = await configure('text', {
      apiKey: '',
      protocol: 'anthropic-messages',
      anthropicMaxTokens: 8192,
    });
    expect(changed.version).toBe(original.version + 1);
    expect(changed.hasApiKey).toBe(true);
    expect(changed.lastValidation).toBeNull();
    await processNext();
    const rejected = await getJob(queued.id);
    expect(rejected.state).toBe('FAILED');
    expect(rejected.protocol).toBe('responses');
    expect(model.calls.text).toBe(before);
    const same = await configure('text', {
      apiKey: '',
      protocol: 'anthropic-messages',
      anthropicMaxTokens: 8192,
    });
    expect(same.version).toBe(changed.version);
    const next = await configure('text', {
      apiKey: '',
      protocol: 'anthropic-messages',
      anthropicMaxTokens: 12288,
    });
    expect(next.version).toBe(changed.version + 1);
  });

  it('拒绝能力与协议不匹配和非法 Anthropic 输出上限，保留原配置', async () => {
    const original = await configure('text');
    for (const [capability, overrides] of [
      ['text', { protocol: 'images-generations' }],
      ['image', { protocol: 'responses' }],
      ['text', { protocol: 'unsupported' }],
      ['text', { protocol: 'anthropic-messages', anthropicMaxTokens: 0 }],
      ['text', { protocol: 'anthropic-messages', anthropicMaxTokens: 1.5 }],
      ['text', { protocol: 'anthropic-messages', anthropicMaxTokens: 128001 }],
    ] as const) {
      const response = await request('/ai/models/' + capability, 'PUT', {
        baseUrl: modelBaseUrl,
        model: 'invalid-change',
        ...overrides,
      });
      expect(response.status).toBe(400);
    }
    expect((await data<AiModels>(await request('/ai/models'))).text?.version).toBe(
      original.version,
    );
  });

  it.each(['responses', 'anthropic-messages'] as const)(
    '%s 可明确清除凭据连接无密钥服务，不附带其他协议的鉴权头',
    async (protocol) => {
      await configure('text');
      const cleared = await configure('text', { protocol, apiKey: '', clearApiKey: true });
      expect(cleared.hasApiKey).toBe(false);
      const job = await enqueue('TEST_TEXT');
      await processNext();
      expect((await getJob(job.id)).state).toBe('SUCCEEDED');
      const last = model.requests.at(-1)!;
      const emptyHash = createHash('sha256').update('').digest('hex');
      expect(last.authorizationHash).toBe(emptyHash);
      expect(last.xApiKeyHash).toBe(emptyHash);
    },
  );

  it.each([
    ['responses', 'truncated'],
    ['responses', 'content-refused'],
    ['responses', 'tool-output'],
    ['anthropic-messages', 'truncated'],
    ['anthropic-messages', 'content-refused'],
    ['anthropic-messages', 'tool-output'],
  ] as const)('%s %s 不产生可采用候选，也不自动重发', async (protocol, mode) => {
    await configure('text', { protocol });
    model.setNext({ nextText: mode });
    const job = await enqueue('REWRITE');
    const before = model.calls.text;
    await processNext();
    const completed = await getJob(job.id);
    expect(completed.state).toBe('FAILED');
    expect(completed.result).toBeNull();
    expect(completed.error).toBeTruthy();
    expect(await processNext()).toBe(false);
    expect(model.calls.text).toBe(before + 1);
  });

  it('分别实际验证文本和图片能力，关闭微信写入也能生成，生成结果不自动改文章或投递', async () => {
    await configure('text');
    await configure('image');
    const counts = {
      articles: await database.article.count(),
      revisions: await database.revision.count(),
      deliveries: await database.delivery.count(),
    };
    const text = await enqueue('TEST_TEXT');
    expect(text.state).toBe('QUEUED');
    expect(await processNext()).toBe(true);
    expect((await getJob(text.id)).result).toEqual({ type: 'text', text: '模型文字验证成功' });
    let list = await data<AiModels>(await request('/ai/models'));
    expect(list.text?.lastValidation?.state).toBe('SUCCEEDED');
    expect(list.image?.lastValidation).toBeNull();
    const image = await enqueue('TEST_IMAGE', { sourceText: '图片验证不应携带这段文章参考' });
    await processNext();
    const completed = await getJob(image.id);
    expect(completed.state).toBe('SUCCEEDED');
    expect(completed.result?.type).toBe('image');
    if (completed.result?.type !== 'image') throw new Error('图片结果缺失');
    const asset = await request('/assets/' + completed.result.asset.id);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('image/png');
    expect(await sharp(Buffer.from(await asset.arrayBuffer())).metadata()).toMatchObject({
      width: 240,
      height: 140,
    });
    list = await data<AiModels>(await request('/ai/models'));
    expect(list.image?.lastValidation?.state).toBe('SUCCEEDED');
    const imageRequest = model.requests.at(-1)!;
    expect(imageRequest.authorizationHash).toBe(
      createHash('sha256')
        .update('Bearer ' + imageKey)
        .digest('hex'),
    );
    expect(imageRequest.responseFormat).toBeNull();
    expect(imageRequest.size).toBe('1536x1024');
    expect(imageRequest.prompt).not.toContain('图片验证不应携带这段文章参考');
    expect({
      articles: await database.article.count(),
      revisions: await database.revision.count(),
      deliveries: await database.delivery.count(),
    }).toEqual(counts);
  });

  it('切换模型服务来源不能静默转发旧密钥，明确清除后才可保存无密钥服务', async () => {
    const original = await configure('text');
    const otherOrigin = 'https://different-model-provider.invalid/v1';
    const changed = { baseUrl: otherOrigin, model: 'other-text-model', apiKey: '' };
    expect((await request('/ai/models/text', 'PUT', changed)).status).toBe(400);
    let current = (await data<AiModels>(await request('/ai/models'))).text!;
    expect(current.baseUrl).toBe(original.baseUrl);
    expect(current.version).toBe(original.version);
    expect(current.hasApiKey).toBe(true);
    expect(
      (await request('/ai/models/text', 'PUT', { ...changed, apiKey: textKey, clearApiKey: true }))
        .status,
    ).toBe(400);
    const cleared = await data<AiModelConfig>(
      await request('/ai/models/text', 'PUT', { ...changed, clearApiKey: true }),
    );
    expect(cleared.baseUrl).toBe(otherOrigin);
    expect(cleared.hasApiKey).toBe(false);
    expect(
      (await database.aiModel.findUniqueOrThrow({ where: { capability: 'text' } })).apiKeyEncrypted,
    ).toBe('');
    current = await configure('text');
    expect(current.baseUrl).toBe(original.baseUrl);
    expect(current.hasApiKey).toBe(true);
  });

  it('重复请求只执行一次，冲突请求被拒绝，候选需要明确保存才进入文章修订', async () => {
    await configure('text');
    const input = { requestKey: randomUUID(), kind: 'ARTICLE', prompt: '写一篇关于内容创作的文章' };
    const responses = await Promise.all([
      request('/ai/jobs', 'POST', input),
      request('/ai/jobs', 'POST', input),
    ]);
    const jobs = await Promise.all(responses.map((response) => data<AiGenerationJob>(response)));
    expect(jobs[0]!.id).toBe(jobs[1]!.id);
    expect(await database.generationJob.count({ where: { requestKey: input.requestKey } })).toBe(1);
    expect(
      (await request('/ai/jobs', 'POST', { ...input, prompt: '不能偷偷替换同一请求的要求' }))
        .status,
    ).toBe(409);
    const count = await database.article.count();
    const before = model.calls.text;
    await processNext();
    const job = await getJob(jobs[0]!.id);
    expect(job.state).toBe('SUCCEEDED');
    expect(job.result?.type).toBe('article');
    expect(await database.article.count()).toBe(count);
    expect(await processNext()).toBe(false);
    expect(model.calls.text).toBe(before + 1);
    if (job.result?.type !== 'article') throw new Error('文章候选缺失');
    const article = await data<Article>(
      await request('/articles', 'POST', {
        title: job.result.title,
        digest: job.result.digest,
        document: job.result.document,
        author: 'AI 测试作者',
        sourceUrl: '',
        coverId: null,
      }),
    );
    expect(article.title).toBe('AI 生成测试文章');
    expect(article.version).toBe(1);
    expect(JSON.stringify(article.document)).toContain('人工审阅后保存');
    expect(await database.delivery.count()).toBe(0);
  });

  it.each([
    ['text', 'malformed', 'ARTICLE', 'FAILED'],
    ['text', 'refused', 'TEST_TEXT', 'FAILED'],
    ['text', 'disconnect', 'TEST_TEXT', 'UNCERTAIN'],
    ['image', 'invalid-image', 'COVER', 'FAILED'],
  ] as const)(
    '%s %s 失败可见，未显式重新生成不会再次调用',
    async (capability, mode, kind, expected) => {
      await configure(capability);
      model.setNext(
        capability === 'text'
          ? { nextText: mode as AiMockMode }
          : { nextImage: mode as AiMockMode },
      );
      const job = await enqueue(kind);
      const before = model.calls[capability];
      await processNext();
      const completed = await getJob(job.id);
      expect(completed.state).toBe(expected);
      expect(completed.error).toBeTruthy();
      expect(JSON.stringify(completed)).not.toContain(textKey);
      expect(JSON.stringify(completed)).not.toContain(imageKey);
      expect(await processNext()).toBe(false);
      expect(model.calls[capability]).toBe(before + 1);
    },
  );

  it('排队后配置发生变化时明确失败，不静默切换模型或凭据', async () => {
    await configure('text');
    const job = await enqueue('ARTICLE');
    const before = model.calls.text;
    await configure('text', { model: 'a-different-model' });
    await processNext();
    const completed = await getJob(job.id);
    expect(completed.state).toBe('FAILED');
    expect(completed.error).toMatch(/配置|变化|更改/);
    expect(model.calls.text).toBe(before);
  });

  it('显式重新生成使用新意图，保留失败结果，图片 URL 结果也保存为本地受保护素材', async () => {
    await configure('image', { imageResponseFormat: 'url' });
    model.setNext({ nextImage: 'refused' });
    const failed = await enqueue('ILLUSTRATION');
    const before = model.calls.image;
    await processNext();
    expect((await getJob(failed.id)).state).toBe('FAILED');
    model.setNext({ nextImage: 'url' });
    const retry = await enqueue('ILLUSTRATION', { sourceText: '插图应参考这段已编辑的正文内容' });
    expect(retry.id).not.toBe(failed.id);
    await processNext();
    const completed = await getJob(retry.id);
    expect(completed.state).toBe('SUCCEEDED');
    expect(completed.result?.type).toBe('image');
    expect((await getJob(failed.id)).state).toBe('FAILED');
    expect(model.calls.image).toBe(before + 2);
    expect(model.requests.at(-1)?.responseFormat).toBe('url');
    expect(model.requests.at(-1)?.prompt).toContain('插图应参考这段已编辑的正文内容');
    if (completed.result?.type !== 'image') throw new Error('插图结果缺失');
    expect(completed.result.asset.url).toBe('/api/v1/assets/' + completed.result.asset.id);
    expect(
      (await request('/assets/' + completed.result.asset.id, 'GET', undefined, '')).status,
    ).toBe(401);
  });

  it('生成执行时拒绝修改同一模型配置，完成后才能轮换', async () => {
    await configure('text');
    model.setNext({ nextText: 'hold' });
    const job = await enqueue('TEST_TEXT');
    const before = model.calls.text;
    const running = processNext();
    await expect.poll(() => model.calls.text).toBe(before + 1);
    expect((await getJob(job.id)).state).toBe('RUNNING');
    const changed = await request('/ai/models/text', 'PUT', {
      baseUrl: modelBaseUrl,
      model: 'changed-while-running',
      apiKey: textKey,
    });
    expect(changed.status).toBe(409);
    model.releaseAll();
    await running;
    expect((await getJob(job.id)).state).toBe('SUCCEEDED');
    await configure('text', { model: 'changed-after-running' });
  }, 25000);

  it('恢复把执行中生成标记待核对，迟到执行者不能再提交结果，排队任务仍可显式运行', async () => {
    await configure('text');
    model.setNext({ nextText: 'hold' });
    const first = await enqueue('TEST_TEXT');
    const before = model.calls.text;
    const running = processNext();
    await expect.poll(() => model.calls.text).toBe(before + 1);
    const queued = await enqueue('TEST_TEXT');
    await ai.recover();
    expect((await getJob(first.id)).state).toBe('UNCERTAIN');
    expect((await getJob(queued.id)).state).toBe('QUEUED');
    model.releaseAll();
    await running;
    expect((await getJob(first.id)).state).toBe('UNCERTAIN');
    expect((await getJob(first.id)).result).toBeNull();
    await processNext();
    expect((await getJob(queued.id)).state).toBe('SUCCEEDED');
    expect(model.calls.text).toBe(before + 2);
  }, 25000);
  it('选择的资料正文和来源固化到生成任务，刷新资料后同一请求仍返回原始快照', async () => {
    await configure('text');
    const url = `https://example.com/reference/${randomUUID()}`;
    const original = '已保存资料中的原始可靠正文。';
    const source = await database.source.create({
      data: {
        url,
        urlHash: createHash('sha256').update(url).digest('hex'),
        resolvedUrl: url,
        title: '原始参考资料',
        text: original,
        contentHash: createHash('sha256').update(original).digest('hex'),
        contentKind: 'article',
        origin: 'url',
      },
    });
    const input = {
      requestKey: randomUUID(),
      kind: 'ARTICLE',
      prompt: '基于选定资料写文章',
      sourceText: '另外提供的手填参考。',
      sourceIds: [source.id],
    };
    const first = await data<AiGenerationJob>(await request('/ai/jobs', 'POST', input));
    expect(first.sourceText).toContain(original);
    expect(first.sourceText).toContain(input.sourceText);
    expect(first.sourceText).toContain(url);
    expect(first.sourceReferences).toEqual([
      {
        id: source.id,
        title: source.title,
        url,
        contentHash: source.contentHash,
        fetchedAt: source.fetchedAt.toISOString(),
      },
    ]);
    await database.source.update({
      where: { id: source.id },
      data: {
        title: '后来更新的参考资料',
        text: '后来的内容不能改写原始请求。',
        contentHash: 'updated-content-hash',
        fetchedAt: new Date(),
      },
    });
    const repeated = await data<AiGenerationJob>(await request('/ai/jobs', 'POST', input));
    expect(repeated.id).toBe(first.id);
    expect(repeated.sourceText).toBe(first.sourceText);
    expect(repeated.sourceReferences).toEqual(first.sourceReferences);
    await processNext();
    expect((await getJob(first.id)).state).toBe('SUCCEEDED');
    expect(model.requests.at(-1)?.prompt).toContain(original);
    expect(model.requests.at(-1)?.prompt).toContain(url);
    expect(model.requests.at(-1)?.prompt).not.toContain('后来的内容');
    const next = await data<AiGenerationJob>(
      await request('/ai/jobs', 'POST', { ...input, requestKey: randomUUID() }),
    );
    expect(next.sourceText).toContain('后来的内容');
    expect(next.sourceReferences[0]?.title).toBe('后来更新的参考资料');
    expect((await request('/ai/jobs', 'POST', { ...input, sourceIds: [] })).status).toBe(409);
  });

  it('资料缺失、空文字、重复选择、不支持的用途或总参考超限均在模型调用前拒绝', async () => {
    await configure('text');
    const beforeCalls = model.calls.text;
    const beforeJobs = await database.generationJob.count();
    const sources = [];
    for (const [index, text] of ['', '甲'.repeat(42000), '乙'.repeat(42000)].entries()) {
      const url = `https://example.com/reference-limits/${randomUUID()}`;
      sources.push(
        await database.source.create({
          data: {
            url,
            urlHash: createHash('sha256').update(url).digest('hex'),
            resolvedUrl: url,
            title: `参考资料 ${index}`,
            text,
            contentHash: createHash('sha256').update(text).digest('hex'),
            contentKind: index ? 'article' : 'feed',
            origin: index ? 'url' : 'rss',
          },
        }),
      );
    }
    const input = { kind: 'ARTICLE', prompt: '引用资料生成' };
    expect(
      (
        await request('/ai/jobs', 'POST', {
          ...input,
          requestKey: randomUUID(),
          sourceIds: [randomUUID()],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request('/ai/jobs', 'POST', {
          ...input,
          requestKey: randomUUID(),
          sourceIds: [sources[0]!.id],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/ai/jobs', 'POST', {
          ...input,
          requestKey: randomUUID(),
          sourceIds: [sources[1]!.id, sources[1]!.id],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/ai/jobs', 'POST', {
          ...input,
          requestKey: randomUUID(),
          sourceIds: [sources[1]!.id, sources[2]!.id],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/ai/jobs', 'POST', {
          ...input,
          requestKey: randomUUID(),
          kind: 'REWRITE',
          sourceText: '仅改写这段原文',
          sourceIds: [sources[1]!.id],
        })
      ).status,
    ).toBe(400);
    expect(model.calls.text).toBe(beforeCalls);
    expect(await database.generationJob.count()).toBe(beforeJobs);
  });
});

async function createTopic(topic = '城市里的一平方米小花园') {
  await configure('text');
  await configure('image');
  return data<TopicCreationTask>(
    await request('/ai/topics', 'POST', { requestKey: randomUUID(), topic }),
  );
}

async function getTopic(id: string) {
  return data<TopicCreationTask>(await request('/ai/topics/' + id));
}

async function finishTopic(id: string) {
  for (let index = 0; index < 8; index++) {
    await topics.processNext(async () => undefined);
    await processNext();
    await topics.processNext(async () => undefined);
    const task = await getTopic(id);
    if (!['QUEUED', 'RUNNING'].includes(task.state)) return task;
  }
  throw new Error('主题创作没有结束');
}

describe('主题自动创作 / 真实 API、PostgreSQL 和隔离模型接口', () => {
  it('文章失败时停止后续封面，空主题和不支持的单独封面重试被拒绝', async () => {
    const task = await createTopic();
    const before = { ...model.calls };
    model.setNext({ nextText: 'refused' });
    const failed = await finishTopic(task.id);
    expect(failed.state).toBe('FAILED');
    expect(failed.stage).toBe('ARTICLE');
    expect(failed.articleResult).toBeNull();
    expect(failed.coverJobId).toBeNull();
    expect(failed.canRetryCover).toBe(false);
    expect(model.calls).toEqual({ text: before.text + 1, image: before.image });
    expect(
      (await request(`/ai/topics/${task.id}/retry-cover`, 'POST', { requestKey: randomUUID() }))
        .status,
    ).toBe(409);
    expect(
      (await request('/ai/topics', 'POST', { requestKey: randomUUID(), topic: '   ' })).status,
    ).toBe(400);
  });
  it('一个主题依次生成文章和关联封面，原子保存新稿并进入修订与微信预览', async () => {
    const before = { ...model.calls };
    const beforeArticles = await database.article.count();
    const beforeDeliveries = await database.delivery.count();
    const task = await createTopic();
    expect(task.state).toBe('QUEUED');
    expect(task.articleId).toBeNull();
    const same = await data<TopicCreationTask>(
      await request('/ai/topics', 'POST', { requestKey: task.requestKey, topic: task.topic }),
    );
    expect(same.id).toBe(task.id);
    expect(
      (await request('/ai/topics', 'POST', { requestKey: task.requestKey, topic: '不同的主题' }))
        .status,
    ).toBe(409);
    const ready = await finishTopic(task.id);
    expect(ready.state).toBe('SUCCEEDED');
    expect(ready.stage).toBe('DONE');
    expect(ready.articleId).toBeTruthy();
    expect(model.calls).toEqual({ text: before.text + 1, image: before.image + 1 });
    const coverPrompt = model.requests.filter((item) => item.capability === 'image').at(-1)!.prompt;
    expect(coverPrompt).toContain(task.topic);
    expect(coverPrompt).toContain('AI 生成测试文章');
    expect(coverPrompt).toContain('从灵感到文章');
    const article = await data<Article>(await request('/articles/' + ready.articleId));
    expect(article.title).toBe('AI 生成测试文章');
    expect(article.coverId).toBeTruthy();
    expect(article.version).toBe(1);
    expect(await database.article.count()).toBe(beforeArticles + 1);
    expect(await database.revision.count({ where: { articleId: article.id } })).toBe(1);
    const preview = await data<{ html: string; warnings: string[] }>(
      await request(`/articles/${article.id}/preview`, 'POST', { revisionId: article.revisionId }),
    );
    expect(preview.html).toContain('从灵感到文章');
    expect(preview.warnings).not.toContain('尚未设置封面；投递前需要补齐');
    expect(await database.delivery.count()).toBe(beforeDeliveries);
    await topics.processNext(async () => undefined);
    expect(await database.article.count()).toBe(beforeArticles + 1);
    const listing = await data<{ items: TopicCreationTask[] }>(await request('/ai/topics'));
    expect(listing.items.some((item) => item.id === task.id && item.articleId === article.id)).toBe(
      true,
    );
  });

  it('封面失败保留文章，明确重试只重新生成封面且请求去重', async () => {
    const task = await createTopic('关于专注的文章');
    const before = { ...model.calls };
    model.setNext({ nextImage: 'refused' });
    const failed = await finishTopic(task.id);
    expect(failed.state).toBe('FAILED');
    expect(failed.stage).toBe('COVER');
    expect(failed.articleResult?.title).toBe('AI 生成测试文章');
    expect(failed.articleId).toBeNull();
    expect(failed.canRetryCover).toBe(true);
    const retry = { requestKey: randomUUID() };
    const responses = await Promise.all([
      request(`/ai/topics/${task.id}/retry-cover`, 'POST', retry),
      request(`/ai/topics/${task.id}/retry-cover`, 'POST', retry),
    ]);
    const retried = await Promise.all(
      responses.map((response) => data<TopicCreationTask>(response)),
    );
    expect(retried[0]!.coverJobId).toBe(retried[1]!.coverJobId);
    expect(retried[0]!.articleJobId).toBe(task.articleJobId);
    const ready = await finishTopic(task.id);
    expect(ready.state).toBe('SUCCEEDED');
    expect(model.calls).toEqual({ text: before.text + 1, image: before.image + 2 });
    expect(
      await database.generationJob.count({ where: { topicId: task.id, kind: 'ARTICLE' } }),
    ).toBe(1);
  });

  it('阶段间图片配置变更会暂停，明确重试后才用新配置生成封面', async () => {
    const task = await createTopic();
    const before = { ...model.calls };
    await topics.processNext(async () => undefined);
    await processNext();
    await configure('image', { model: 'explicitly-changed-image-model' });
    await topics.processNext(async () => undefined);
    const paused = await getTopic(task.id);
    expect(paused.state).toBe('FAILED');
    expect(paused.canRetryCover).toBe(true);
    expect(model.calls.image).toBe(before.image);
    expect(paused.error).toContain('配置已更改');
    await data(
      await request(`/ai/topics/${task.id}/retry-cover`, 'POST', { requestKey: randomUUID() }),
    );
    expect((await finishTopic(task.id)).state).toBe('SUCCEEDED');
    expect(model.calls).toEqual({ text: before.text + 1, image: before.image + 1 });
  });

  it('重启恢复冻结父任务及待执行封面，不盲目发起收费请求', async () => {
    const task = await createTopic();
    await topics.processNext(async () => undefined);
    await processNext();
    await topics.processNext(async () => undefined);
    const before = { ...model.calls };
    await topics.recover();
    const paused = await getTopic(task.id);
    expect(paused.state).toBe('UNCERTAIN');
    expect(paused.articleResult).toBeTruthy();
    expect(paused.canRetryCover).toBe(true);
    expect((await getJob(paused.coverJobId!)).state).toBe('UNCERTAIN');
    expect(await processNext()).toBe(false);
    expect(await topics.processNext(async () => undefined)).toBe(false);
    expect(model.calls).toEqual(before);
    await data(
      await request(`/ai/topics/${task.id}/retry-cover`, 'POST', { requestKey: randomUUID() }),
    );
    expect((await finishTopic(task.id)).state).toBe('SUCCEEDED');
    expect(model.calls).toEqual({ text: before.text, image: before.image + 1 });
  });

  it('两项成功后保存中断，可明确恢复保存并幂等取回稿件，不再调用模型', async () => {
    const task = await createTopic();
    await topics.processNext(async () => undefined);
    await processNext();
    await topics.processNext(async () => undefined);
    await processNext();
    const before = { ...model.calls };
    const beforeArticles = await database.article.count();
    await topics.recover();
    const paused = await getTopic(task.id);
    expect(paused.canResumeSave).toBe(true);
    expect(paused.canRetryCover).toBe(false);
    expect(
      (await request(`/ai/topics/${task.id}/retry-cover`, 'POST', { requestKey: randomUUID() }))
        .status,
    ).toBe(409);
    const input = { requestKey: randomUUID() };
    const first = await data<TopicCreationTask>(
      await request(`/ai/topics/${task.id}/resume-save`, 'POST', input),
    );
    const second = await data<TopicCreationTask>(
      await request(`/ai/topics/${task.id}/resume-save`, 'POST', input),
    );
    expect(first.state).toBe('SUCCEEDED');
    expect(second.articleId).toBe(first.articleId);
    expect(await database.article.count()).toBe(beforeArticles + 1);
    expect(model.calls).toEqual(before);
  });

  it('保存校验失败不会打断Worker，保留图文供修复后无收费恢复', async () => {
    const task = await createTopic();
    await topics.processNext(async () => undefined);
    await processNext();
    await topics.processNext(async () => undefined);
    await processNext();
    const before = { ...model.calls };
    const row = await database.generationJob.findUniqueOrThrow({
      where: { id: task.articleJobId! },
    });
    const original = row.result!;
    await database.generationJob.update({
      where: { id: row.id },
      data: {
        result: {
          ...(original as object),
          document: { type: 'doc', content: [{ type: 'invalid-node' }] },
        },
      },
    });
    expect(await topics.processNext(async () => undefined)).toBe(true);
    const failed = await getTopic(task.id);
    expect(failed.state).toBe('FAILED');
    expect(failed.stage).toBe('SAVE');
    expect(failed.canResumeSave).toBe(true);
    await database.generationJob.update({ where: { id: row.id }, data: { result: original } });
    const saved = await data<TopicCreationTask>(
      await request(`/ai/topics/${task.id}/resume-save`, 'POST', { requestKey: randomUUID() }),
    );
    expect(saved.state).toBe('SUCCEEDED');
    expect(model.calls).toEqual(before);
  });

  it('最终保存期间失去Worker执行权回滚新稿和完成状态，恢复保存也不重复收费', async () => {
    const task = await createTopic();
    await topics.processNext(async () => undefined);
    await processNext();
    await topics.processNext(async () => undefined);
    await processNext();
    const before = { ...model.calls };
    const beforeArticles = await database.article.count();
    let active = true;
    const originalSave = content.createInTransaction.bind(content);
    const save = vi.spyOn(content, 'createInTransaction').mockImplementation(async (tx, input) => {
      const saved = await originalSave(tx, input);
      active = false;
      return saved;
    });
    try {
      await expect(
        topics.processNext(async () => {
          if (!active) throw new Error('worker lock lost');
        }),
      ).rejects.toThrow('worker lock lost');
    } finally {
      save.mockRestore();
    }
    expect(await database.article.count()).toBe(beforeArticles);
    expect((await getTopic(task.id)).state).toBe('RUNNING');
    await topics.recover();
    expect((await getTopic(task.id)).canResumeSave).toBe(true);
    const ready = await data<TopicCreationTask>(
      await request(`/ai/topics/${task.id}/resume-save`, 'POST', { requestKey: randomUUID() }),
    );
    expect(ready.state).toBe('SUCCEEDED');
    expect(await database.article.count()).toBe(beforeArticles + 1);
    expect(model.calls).toEqual(before);
  });
});
