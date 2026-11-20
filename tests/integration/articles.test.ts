import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import type { Article, ArticleInput, DocumentNode } from '@tattoo/contracts';
import { Client } from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/test/i.test(new URL(databaseUrl).pathname))
  throw new Error('文章集成测试只允许专用测试库');
const schema = `tattoo_p3_articles_${randomUUID().replaceAll('-', '')}`;
const url = new URL(databaseUrl);
url.searchParams.set('schema', schema);
const connection = new Client({ connectionString: databaseUrl });
const email = 'p3-articles@example.com';
const password = 'p3-articles-test-password';
let database: PrismaClient;
let createdSchema = false;
let child: ChildProcess | undefined;
let logs = '';
let origin = '';
let cookie = '';
let storage = '';
let temporaryRoot = '';
let assetId = '';

const draft = (
  title = '',
  document: DocumentNode = { type: 'doc', content: [{ type: 'paragraph' }] },
): ArticleInput => ({
  title,
  document,
  author: '',
  digest: '',
  sourceUrl: '',
  coverId: null,
});
const textDocument = (text: string): DocumentNode => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

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
    signal: AbortSignal.timeout(10000),
  });
}

async function data<T = Article>(response: Response): Promise<T> {
  const result = (await response.json()) as { data: T; error?: unknown };
  expect(response.ok, JSON.stringify(result)).toBe(true);
  return result.data;
}

beforeAll(async () => {
  await connection.connect();
  await connection.query(`CREATE SCHEMA "${schema}"`);
  createdSchema = true;
  await connection.query(`SET search_path TO "${schema}"`);
  const migrations = resolve('apps/server/prisma/migrations');
  for (const entry of (await readdir(migrations, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    await connection.query(
      await readFile(resolve(migrations, entry.name, 'migration.sql'), 'utf8'),
    );
  }
  database = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  await database.$connect();
  temporaryRoot = await realpath(tmpdir());
  storage = await mkdtemp(join(temporaryRoot, 'tattoo-p3-articles-'));
  const listener = createServer();
  await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('无法分配文章测试端口');
  const port = address.port;
  await new Promise<void>((done) => listener.close(() => done()));
  origin = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [resolve('apps/server/dist/main.js')], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: url.toString(),
      APP_ENCRYPTION_KEY: Buffer.alloc(32, 13).toString('base64'),
      APP_ORIGIN: origin,
      PORT: String(port),
      STORAGE_PATH: storage,
      ADMIN_EMAIL: email,
      ADMIN_PASSWORD: password,
      COOKIE_SECURE: 'false',
      REMOTE_WRITES_ENABLED: 'false',
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr])
    stream?.on('data', (chunk: Buffer) => {
      logs = `${logs}${chunk.toString('utf8')}`.slice(-32768);
    });
  const deadline = Date.now() + 45000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`文章 API 启动失败：${logs}`);
    try {
      ready = (await fetch(`${origin}/api/v1/health/ready`, { signal: AbortSignal.timeout(1000) }))
        .ok;
      if (ready) break;
    } catch {
      /* The child may still be initializing its administrator. */
    }
    await sleep(150);
  }
  if (!ready) throw new Error(`文章 API 启动超时：${logs}`);
  const login = await request('/auth/login', 'POST', { email, password }, '');
  await data(login);
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const picture = await sharp({
    create: { width: 17, height: 13, channels: 3, background: '#3b6f58' },
  })
    .png()
    .toBuffer();
  const upload = await fetch(`${origin}/api/v1/assets`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'X-Tattoo-Request': '1',
      'Content-Type': 'image/png',
      'X-Filename': 'article.png',
    },
    body: picture,
    signal: AbortSignal.timeout(10000),
  });
  assetId = (await data<{ id: string }>(upload)).id;
}, 90000);

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((done) => child!.once('exit', () => done()));
    child.kill('SIGKILL');
    await Promise.race([
      exited,
      sleep(5000).then(() => {
        throw new Error('文章测试 API 未及时退出');
      }),
    ]);
  }
  await database?.$disconnect();
  if (createdSchema) {
    if (!/^tattoo_p3_articles_[0-9a-f]{32}$/.test(schema))
      throw new Error('文章测试 schema 范围校验失败');
    await connection.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
  await connection.end();
  if (storage) {
    if (dirname(storage) !== temporaryRoot || !basename(storage).startsWith('tattoo-p3-articles-'))
      throw new Error('文章测试临时目录范围校验失败');
    await rm(storage, { recursive: true });
  }
}, 15000);

describe('P3 文章与不可变修订 HTTP / PostgreSQL', () => {
  it('所有内容、历史和预览接口要求登录；写请求执行 CSRF 检查', async () => {
    const id = randomUUID(),
      revisionId = randomUUID();
    for (const [path, method, body] of [
      ['/articles', 'GET', undefined],
      ['/articles', 'POST', draft()],
      [`/articles/${id}`, 'GET', undefined],
      [`/articles/${id}`, 'PATCH', { ...draft(), expectedVersion: 1 }],
      [`/articles/${id}/revisions`, 'GET', undefined],
      [`/articles/${id}/revisions/${revisionId}`, 'GET', undefined],
      [`/articles/${id}/preview`, 'POST', { revisionId }],
    ] as const)
      expect((await request(path, method, body, '')).status).toBe(401);
    expect(
      (
        await fetch(`${origin}/api/v1/articles`, {
          method: 'POST',
          headers: {
            Cookie: cookie,
            Origin: 'https://foreign.example',
            'Content-Type': 'application/json',
            'X-Tattoo-Request': '1',
          },
          body: JSON.stringify(draft()),
        })
      ).status,
    ).toBe(403);
  });

  it('允许空标题、空正文、缺少封面的草稿保存与刷新，并将完整性问题留给预览提示', async () => {
    const created = await data(await request('/articles', 'POST', draft('  ')));
    expect(created.title).toBe('未命名文章');
    expect(created.version).toBe(1);
    expect(created.coverId).toBeNull();
    expect(await data(await request(`/articles/${created.id}`))).toEqual(created);
    const preview = await data<{
      html: string;
      warnings: string[];
      revisionId: string;
      platformLimitsVerified: boolean;
    }>(
      await request(`/articles/${created.id}/preview`, 'POST', { revisionId: created.revisionId }),
    );
    expect(preview.revisionId).toBe(created.revisionId);
    expect(preview.platformLimitsVerified).toBe(false);
    expect(preview.warnings.join('；')).toMatch(/封面.*正文.*待核验/);
    expect(preview.html).toContain('<section');
    const unfinished = await data(
      await request('/articles', 'POST', {
        ...draft('长'.repeat(300)),
        digest: '摘要'.repeat(350),
        author: '作者'.repeat(40),
      }),
    );
    expect(unfinished.title).toHaveLength(300);
    expect(unfinished.digest).toHaveLength(700);
    expect(unfinished.author).toHaveLength(80);
  });

  it('无变化保存保留版本、修订和更新时间，字段对象键顺序不制造新修订', async () => {
    const body = draft('稳定内容', {
      type: 'doc',
      content: [{ type: 'image', attrs: { assetId, alt: '本地图片' } }],
    });
    body.coverId = assetId;
    const created = await data(await request('/articles', 'POST', body));
    const equivalent = {
      ...body,
      document: { content: [{ attrs: { alt: '本地图片', assetId }, type: 'image' }], type: 'doc' },
    };
    const unchanged = await data(
      await request(`/articles/${created.id}`, 'PATCH', { ...equivalent, expectedVersion: 1 }),
    );
    expect(unchanged).toEqual(created);
    const preview = await data<{ html: string }>(
      await request(`/articles/${created.id}/preview`, 'POST', { revisionId: created.revisionId }),
    );
    expect(preview.html).toContain(`src="/api/v1/assets/${assetId}"`);
    expect(await database.revision.count({ where: { articleId: created.id } })).toBe(1);
    expect(await database.revisionAsset.count({ where: { revisionId: created.revisionId } })).toBe(
      1,
    );
  });

  it('有变化保存形成新快照，历史内容和图片引用保持不变且不可跨文章读取', async () => {
    const body = { ...draft('初稿', textDocument('第一份正文')), coverId: assetId };
    const created = await data(await request('/articles', 'POST', body));
    const original = await database.revision.findUniqueOrThrow({
      where: { id: created.revisionId },
    });
    const saved = await data(
      await request(`/articles/${created.id}`, 'PATCH', {
        ...draft('二稿', textDocument('第二份正文')),
        expectedVersion: 1,
      }),
    );
    expect(saved.version).toBe(2);
    expect(saved.revisionId).not.toBe(created.revisionId);
    expect(
      await database.revision.findUniqueOrThrow({ where: { id: created.revisionId } }),
    ).toEqual(original);
    const old = await data<{ id: string; title: string; coverId: string | null }>(
      await request(`/articles/${created.id}/revisions/${created.revisionId}`),
    );
    expect(old).toMatchObject({ id: created.revisionId, title: '初稿', coverId: assetId });
    const revisions = await data<{ items: { version: number }[]; total: number }>(
      await request(`/articles/${created.id}/revisions?pageSize=1`),
    );
    expect(revisions.total).toBe(2);
    expect(revisions.items.map((revision) => revision.version)).toEqual([2]);
    const other = await data(await request('/articles', 'POST', draft('另一稿件')));
    expect((await request(`/articles/${other.id}/revisions/${created.revisionId}`)).status).toBe(
      404,
    );
    expect(
      (await request(`/articles/${other.id}/preview`, 'POST', { revisionId: created.revisionId }))
        .status,
    ).toBe(404);
    await expect(database.asset.delete({ where: { id: assetId } })).rejects.toMatchObject({
      code: 'P2003',
    });
  });

  it('同版本并发保存仅一个成功，冲突保留当前快照；过期无变化保存也不能绕过冲突', async () => {
    const created = await data(await request('/articles', 'POST', draft('并发稿件')));
    const results = await Promise.all(
      ['窗口甲', '窗口乙'].map((title) =>
        request(`/articles/${created.id}`, 'PATCH', { ...draft(title), expectedVersion: 1 }),
      ),
    );
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = await data(results.find((response) => response.ok)!);
    const loser = (await results.find((response) => response.status === 409)!.json()) as {
      error: { code: string; details: { currentVersion: number } };
    };
    expect(loser.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { currentVersion: 2 } });
    expect(await database.revision.count({ where: { articleId: created.id } })).toBe(2);
    const stale = await request(`/articles/${created.id}`, 'PATCH', {
      ...draft(winner.title),
      expectedVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(await data(await request(`/articles/${created.id}`))).toEqual(winner);
  });

  it('缺失的正文图或封面不能形成孤立文章、修订、素材引用或推进当前版本', async () => {
    const before = await database.article.count();
    const invalid = draft('无效图片', {
      type: 'doc',
      content: [{ type: 'image', attrs: { assetId: randomUUID(), alt: '' } }],
    });
    expect((await request('/articles', 'POST', invalid)).status).toBe(400);
    expect(await database.article.count()).toBe(before);
    const created = await data(await request('/articles', 'POST', draft('保留当前版本')));
    expect(
      (
        await request(`/articles/${created.id}`, 'PATCH', {
          ...draft('不能保存'),
          coverId: randomUUID(),
          expectedVersion: 1,
        })
      ).status,
    ).toBe(400);
    expect(await data(await request(`/articles/${created.id}`))).toEqual(created);
    expect(await database.revision.count({ where: { articleId: created.id } })).toBe(1);
  });

  it('未知节点、危险链接、远程图片和额外字段明确拒绝；安全文本在预览中转义', async () => {
    const invalidDocuments: DocumentNode[] = [
      { type: 'doc', content: [{ type: 'script', text: 'alert(1)' }] },
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: '链接',
                marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
              },
            ],
          },
        ],
      },
      {
        type: 'doc',
        content: [{ type: 'image', attrs: { src: 'https://external.example/image.png' } }],
      },
    ];
    for (const document of invalidDocuments)
      expect((await request('/articles', 'POST', draft('拒绝不安全内容', document))).status).toBe(
        400,
      );
    for (const value of ['含\u0000空字符', '孤立代理项\ud800']) {
      expect((await request('/articles', 'POST', draft(value))).status).toBe(400);
      expect(
        (await request('/articles', 'POST', draft('不可存储字符', textDocument(value)))).status,
      ).toBe(400);
    }
    expect(
      (await request('/articles', 'POST', { ...draft('未知字段'), isTest: true })).status,
    ).toBe(400);
    expect(
      (
        await request('/articles', 'POST', {
          ...draft('来源链接'),
          sourceUrl: 'data:text/html,unsafe',
        })
      ).status,
    ).toBe(400);
    const created = await data(
      await request(
        '/articles',
        'POST',
        draft('安全预览', textDocument('<img src=x onerror=alert(1)>')),
      ),
    );
    const preview = await data<{ html: string }>(
      await request(`/articles/${created.id}/preview`, 'POST', { revisionId: created.revisionId }),
    );
    expect(preview.html).toContain('&lt;img');
    expect(preview.html).not.toContain('<img');
    expect((await request(`/articles/${created.id}/preview`, 'POST', {})).status).toBe(400);
  });

  it('普通列表有确定分页且不暴露 P2 测试稿，测试稿也不能通过内容接口访问', async () => {
    const fixture = await database.article.create({ data: { isTest: true } });
    const revision = await database.revision.create({
      data: {
        articleId: fixture.id,
        version: 1,
        title: 'P2 固定测试稿',
        document: { type: 'doc', content: [{ type: 'paragraph' }] },
        contentHash: 'test-fixture-only',
      },
    });
    await database.article.update({
      where: { id: fixture.id },
      data: { currentRevisionId: revision.id },
    });
    type Page = {
      items: { id: string; title: string }[];
      total: number;
      page: number;
      pageSize: number;
    };
    const first = await data<Page>(await request('/articles?pageSize=2'));
    const again = await data<Page>(await request('/articles?pageSize=2'));
    const second = await data<Page>(await request('/articles?page=2&pageSize=2'));
    expect(first).toEqual(again);
    expect(first.page).toBe(1);
    expect(first.pageSize).toBe(2);
    expect(first.items).toHaveLength(2);
    expect(second.items.every((item) => first.items.every((prior) => item.id !== prior.id))).toBe(
      true,
    );
    expect(first.total).toBe(await database.article.count({ where: { isTest: false } }));
    expect((await request(`/articles/${fixture.id}`)).status).toBe(404);
    expect((await request(`/articles/${fixture.id}/revisions/${revision.id}`)).status).toBe(404);
    expect(
      (
        await request(`/articles/${fixture.id}`, 'PATCH', {
          ...draft('不修改测试稿'),
          expectedVersion: 1,
        })
      ).status,
    ).toBe(404);
    for (const query of ['page=0', 'pageSize=101', 'page=2147483647&pageSize=100'])
      expect((await request(`/articles?${query}`)).status).toBe(400);
    expect((await request('/articles/not-a-uuid')).status).toBe(400);
  });
});
