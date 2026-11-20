import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretBox } from '../../apps/server/src/security';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/test/i.test(new URL(databaseUrl).pathname))
  throw new Error('P2 HTTP 测试只允许专用测试库');
const schema = `tattoo_p2_http_${randomUUID().replaceAll('-', '')}`;
const url = new URL(databaseUrl);
url.searchParams.set('schema', schema);
const key = Buffer.alloc(32, 11).toString('base64');
const adminEmail = 'p2-http@example.com';
const adminPassword = 'p2-http-test-password';
const appSecret = 'mock-app-secret-never-real';
const accessToken = 'mock-access-token-never-real';
const databaseConnection = new Client({ connectionString: databaseUrl });
let database: PrismaClient;
let createdSchema = false;
let mock: Server;
let apiProcess: ChildProcess;
let workerProcess: ChildProcess | undefined;
let origin = '';
let mockOrigin = '';
let temporaryRoot = '';
let storage = '';
let processEnv: NodeJS.ProcessEnv;
let cookie = '';
let accountId = '';
let coverId = '';
let initialRequestId = '';
let uncertainDeliveryId = '';
let draftMode: 'success' | 'disconnect' | 'hang' | 'refused' = 'success';
const calls = { token: 0, count: 0, cover: 0, draft: 0 };
const draftPayloads: unknown[] = [];
const logs = new Map<ChildProcess, string>();

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配测试端口');
  const port = address.port;
  await new Promise<void>((resolveClose, reject) =>
    server.close((error) => (error ? reject(error) : resolveClose())),
  );
  return port;
}

function startProcess(entry: string) {
  const child = spawn(process.execPath, [resolve(entry)], {
    cwd: resolve('.'),
    env: processEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  logs.set(child, '');
  for (const output of [child.stdout, child.stderr])
    output?.on('data', (chunk: Buffer) =>
      logs.set(child, `${logs.get(child) ?? ''}${chunk.toString('utf8')}`.slice(-65536)),
    );
  return child;
}

async function stopProcess(child: ChildProcess | undefined) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()));
  child.kill('SIGKILL');
  await Promise.race([
    exited,
    sleep(5000).then(() => {
      throw new Error('测试子进程未及时退出');
    }),
  ]);
}

async function poll<T>(
  read: () => Promise<T>,
  accepted: (value: T) => boolean,
  label: string,
  milliseconds = 30000,
): Promise<T> {
  const end = Date.now() + milliseconds;
  let latest: T | undefined;
  while (Date.now() < end) {
    latest = await read();
    if (accepted(latest)) return latest;
    await sleep(150);
  }
  throw new Error(
    `${label}超时；API日志：${logs.get(apiProcess) ?? ''}；Worker日志：${workerProcess ? (logs.get(workerProcess) ?? '') : ''}`,
  );
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
    signal: AbortSignal.timeout(10000),
  });
}

async function data(response: Response) {
  const payload = (await response.json()) as { data?: any; error?: unknown };
  expect(response.ok, JSON.stringify(payload)).toBe(true);
  return payload.data;
}

async function delivery(id: string) {
  return database.delivery.findUniqueOrThrow({ where: { id } });
}

beforeAll(async () => {
  await databaseConnection.connect();
  await databaseConnection.query(`CREATE SCHEMA "${schema}"`);
  createdSchema = true;
  await databaseConnection.query(`SET search_path TO "${schema}"`);
  const migrations = resolve('apps/server/prisma/migrations');
  for (const entry of (await readdir(migrations, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    await databaseConnection.query(
      await readFile(resolve(migrations, entry.name, 'migration.sql'), 'utf8'),
    );
  }
  database = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  await database.$connect();
  temporaryRoot = await realpath(tmpdir());
  storage = await mkdtemp(join(temporaryRoot, 'tattoo-p2-http-'));
  mock = createServer(async (incoming, outgoing) => {
    const path = new URL(incoming.url ?? '/', 'http://mock.local').pathname;
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    outgoing.setHeader('Content-Type', 'application/json');
    if (path === '/cgi-bin/stable_token') {
      calls.token++;
      outgoing.end(JSON.stringify({ access_token: accessToken, expires_in: 7200 }));
    } else if (path === '/cgi-bin/draft/count') {
      calls.count++;
      outgoing.end(JSON.stringify({ total_count: 2 }));
    } else if (path === '/cgi-bin/material/add_material') {
      calls.cover++;
      outgoing.end(JSON.stringify({ media_id: 'mock-cover-id' }));
    } else if (path === '/cgi-bin/draft/add') {
      calls.draft++;
      draftPayloads.push(JSON.parse(body.toString('utf8')));
      if (draftMode === 'disconnect') incoming.socket.destroy();
      else if (draftMode === 'refused')
        outgoing.end(JSON.stringify({ errcode: 48001, errmsg: 'api unauthorized' }));
      else if (draftMode === 'success')
        outgoing.end(JSON.stringify({ media_id: `mock-draft-${calls.draft}` }));
      // Hang mode intentionally keeps the request open until its Worker process is killed.
    } else {
      outgoing.statusCode = 404;
      outgoing.end(JSON.stringify({ errcode: 404 }));
    }
  });
  await new Promise<void>((resolveListen) => mock.listen(0, '127.0.0.1', resolveListen));
  const mockAddress = mock.address();
  if (!mockAddress || typeof mockAddress === 'string') throw new Error('模拟微信监听失败');
  mockOrigin = `http://127.0.0.1:${mockAddress.port}`;
  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  processEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: url.toString(),
    APP_ENCRYPTION_KEY: key,
    APP_ORIGIN: origin,
    PORT: String(port),
    STORAGE_PATH: storage,
    ADMIN_EMAIL: adminEmail,
    ADMIN_PASSWORD: adminPassword,
    COOKIE_SECURE: 'false',
    ALLOW_MOCK_WECHAT: 'true',
    WECHAT_API_BASE: mockOrigin,
    REMOTE_WRITES_ENABLED: 'true',
  };
  apiProcess = startProcess('apps/server/dist/main.js');
  await poll(
    async () => {
      if (apiProcess.exitCode !== null)
        throw new Error(`API 启动失败：${logs.get(apiProcess) ?? ''}`);
      try {
        return (await fetch(`${origin}/api/v1/health/ready`, { signal: AbortSignal.timeout(1000) }))
          .ok;
      } catch {
        return false;
      }
    },
    Boolean,
    'API 启动',
    45000,
  );
}, 90000);

afterAll(async () => {
  await stopProcess(workerProcess);
  await stopProcess(apiProcess);
  if (mock) {
    mock.closeAllConnections();
    await new Promise<void>((resolveClose) => mock.close(() => resolveClose()));
  }
  await database?.$disconnect();
  if (createdSchema) {
    if (!/^tattoo_p2_http_[0-9a-f]{32}$/.test(schema)) throw new Error('测试 schema 范围校验失败');
    await databaseConnection.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
  await databaseConnection.end();
  if (storage) {
    if (dirname(storage) !== temporaryRoot || !basename(storage).startsWith('tattoo-p2-http-'))
      throw new Error('临时素材目录范围校验失败');
    await rm(storage, { recursive: true });
  }
}, 15000);

describe('P2 真实进程与模拟微信闭环', () => {
  it('拒绝未登录与跨站写请求，正确登录只返回安全用户字段', async () => {
    expect((await request('/accounts', 'GET', undefined, '')).status).toBe(401);
    expect(
      (
        await fetch(`${origin}/api/v1/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: adminEmail, password: adminPassword }),
        })
      ).status,
    ).toBe(403);
    expect(
      (await request('/auth/login', 'POST', { email: adminEmail, password: 'wrong' }, '')).status,
    ).toBe(401);
    const login = await request(
      '/auth/login',
      'POST',
      { email: adminEmail, password: adminPassword },
      '',
    );
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    cookie = setCookie.split(';')[0]!;
    const user = await data(login);
    expect(user.email).toBe(adminEmail);
    expect(user.remoteWritesEnabled).toBe(true);
    expect(JSON.stringify(user)).not.toContain(adminPassword);
    expect((await data(await request('/auth/me'))).id).toBe(user.id);
  });

  it('加密保存账号，读取验证不上传素材或创建草稿，真实 PNG 受认证保护', async () => {
    const account = await data(
      await request('/accounts', 'POST', {
        name: '测试公众号',
        appId: 'wx1234567890abcdef',
        appSecret,
      }),
    );
    accountId = account.id;
    expect(account.capabilities.readDraft.status).toBe('unverified');
    expect(JSON.stringify(account)).not.toContain(appSecret);
    expect(account).not.toHaveProperty('secretEncrypted');
    const stored = await database.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(stored.secretEncrypted).not.toContain(appSecret);
    expect(new SecretBox(key).decrypt(stored.secretEncrypted)).toBe(appSecret);
    const checked = await data(await request(`/accounts/${accountId}/verify`, 'POST', {}));
    expect(checked.draftCount).toBe(2);
    expect(checked.account.capabilities.readDraft.status).toBe('supported');
    expect(checked.account.capabilities.saveDraft.status).toBe('unverified');
    expect(calls).toEqual({ token: 1, count: 1, cover: 0, draft: 0 });
    const picture = await sharp({
      create: { width: 12, height: 8, channels: 3, background: '#35634e' },
    })
      .png()
      .toBuffer();
    const uploaded = await fetch(`${origin}/api/v1/assets`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: origin,
        'X-Tattoo-Request': '1',
        'Content-Type': 'image/png',
        'X-Filename': '../../cover.png',
      },
      body: new Uint8Array(picture),
    });
    const asset = await data(uploaded);
    coverId = asset.id;
    expect(asset.name).toBe('cover.png');
    expect((await request(`/assets/${coverId}`, 'GET', undefined, '')).status).toBe(401);
    expect((await request(`/assets/${coverId}`)).headers.get('content-type')).toMatch(/image\/png/);
  });

  it('重复测试请求返回同一持久任务，Worker 只创建一次草稿并验证写能力', async () => {
    const body = { coverId, requestId: randomUUID(), confirmed: true };
    initialRequestId = body.requestId;
    const [first, second] = await Promise.all([
      request(`/accounts/${accountId}/test-draft`, 'POST', body).then(data),
      request(`/accounts/${accountId}/test-draft`, 'POST', body).then(data),
    ]);
    expect(first.id).toBe(second.id);
    expect(await database.delivery.count({ where: { accountId } })).toBe(1);
    workerProcess = startProcess('apps/server/dist/worker.js');
    const result = await poll(
      () => delivery(first.id),
      (row) => row.state === 'SUCCEEDED',
      '测试投递成功',
    );
    expect(result.remoteId).toBe('mock-draft-1');
    expect(calls.cover).toBe(1);
    expect(calls.draft).toBe(1);
    expect(draftPayloads[0]).toMatchObject({
      articles: [{ title: 'Tattoo 接入测试', thumb_media_id: 'mock-cover-id' }],
    });
    const account = (await data(await request('/accounts'))).items.find(
      (item: { id: string }) => item.id === accountId,
    );
    expect(account.capabilities.saveDraft.status).toBe('supported');
    expect(JSON.stringify(await data(await request(`/deliveries/${first.id}`)))).not.toContain(
      accessToken,
    );
  }, 45000);

  it('重复请求标识不能被用于改变封面，不额外创建投递意图或远程草稿', async () => {
    const image = await sharp({
      create: { width: 10, height: 8, channels: 3, background: '#a33636' },
    })
      .png()
      .toBuffer();
    const asset = await data(
      await fetch(`${origin}/api/v1/assets`, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: origin,
          'X-Tattoo-Request': '1',
          'Content-Type': 'image/png',
        },
        body: new Uint8Array(image),
      }),
    );
    expect(asset.id).not.toBe(coverId);
    const before = calls.draft;
    const count = await database.delivery.count({ where: { accountId } });
    expect(
      (
        await request(`/accounts/${accountId}/test-draft`, 'POST', {
          coverId: asset.id,
          requestId: initialRequestId,
          confirmed: true,
        })
      ).status,
    ).toBe(409);
    expect(await database.delivery.count({ where: { accountId } })).toBe(count);
    expect(calls.draft).toBe(before);
  });

  it('新增草稿连接断开后进入待核对且不会自动重发', async () => {
    draftMode = 'disconnect';
    const result = await data(
      await request(`/accounts/${accountId}/test-draft`, 'POST', {
        coverId,
        requestId: randomUUID(),
        confirmed: true,
      }),
    );
    await poll(
      () => delivery(result.id),
      (row) => row.state === 'UNCERTAIN',
      '连接中断待核对',
    );
    const count = calls.draft;
    await sleep(1600);
    expect(calls.draft).toBe(count);
    expect(
      (await request(`/deliveries/${result.id}/retry`, 'POST', { confirmed: true })).status,
    ).toBe(409);
  }, 45000);

  it('危险提交阶段杀死 Worker 后恢复为待核对，旧任务不会再次调用微信', async () => {
    draftMode = 'hang';
    const before = calls.draft;
    const task = await data(
      await request(`/accounts/${accountId}/test-draft`, 'POST', {
        coverId,
        requestId: randomUUID(),
        confirmed: true,
      }),
    );
    uncertainDeliveryId = task.id;
    await poll(
      () => delivery(task.id),
      (row) =>
        row.state === 'RUNNING' && row.submissionStartedAt !== null && calls.draft === before + 1,
      '危险提交标记',
    );
    expect(
      (await request(`/accounts/${accountId}`, 'PATCH', { appSecret: 'rotation-must-not-happen' }))
        .status,
    ).toBe(409);
    await stopProcess(workerProcess);
    workerProcess = startProcess('apps/server/dist/worker.js');
    await poll(
      () => delivery(task.id),
      (row) => row.state === 'UNCERTAIN',
      'Worker 重启恢复',
    );
    await sleep(1600);
    expect(calls.draft).toBe(before + 1);
  }, 45000);

  it('人工核对必须先停止 Worker，无远程 ID 的人工成功也不能冒充接口能力验证', async () => {
    const reset = await data(
      await request(`/accounts/${accountId}`, 'PATCH', { appSecret: 'manual-check-secret-value' }),
    );
    expect(reset.capabilities.saveDraft.status).toBe('unverified');
    const body = {
      outcome: 'created',
      note: '已在模拟微信后台人工核对该测试草稿存在',
      workerStoppedConfirmed: true,
    };
    expect(
      (await request(`/deliveries/${uncertainDeliveryId}/resolve`, 'POST', { ...body, note: '短' }))
        .status,
    ).toBe(400);
    expect((await request(`/deliveries/${uncertainDeliveryId}/resolve`, 'POST', body)).status).toBe(
      409,
    );
    await stopProcess(workerProcess);
    const staleAccountSession = new Client({ connectionString: url.toString() });
    await staleAccountSession.connect();
    try {
      await poll(
        async () =>
          (
            await staleAccountSession.query<{ acquired: boolean }>(
              'SELECT pg_try_advisory_lock(8472901) AS acquired',
            )
          ).rows[0]?.acquired ?? false,
        Boolean,
        '旧 Worker 全局执行权释放',
        5000,
      );
      await staleAccountSession.query('SELECT pg_advisory_unlock(8472901)');
      const held = await staleAccountSession.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
        [accountId],
      );
      expect(held.rows[0]?.acquired).toBe(true);
      const blocked = await request(`/deliveries/${uncertainDeliveryId}/resolve`, 'POST', body);
      expect(blocked.status, '旧账号会话仍持有执行权时不得人工解除不确定状态').toBe(409);
      expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe(
        'ACCOUNT_BUSY',
      );
      expect((await delivery(uncertainDeliveryId)).state).toBe('UNCERTAIN');
    } finally {
      await staleAccountSession.end();
    }
    const resolved = await data(
      await request(`/deliveries/${uncertainDeliveryId}/resolve`, 'POST', body),
    );
    expect(resolved.state).toBe('SUCCEEDED');
    expect(resolved.resultSource).toBe('manual');
    expect(resolved.remoteId).toBeNull();
    expect(resolved.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actor: adminEmail, message: expect.stringContaining(body.note) }),
      ]),
    );
    const account = await database.account.findUniqueOrThrow({ where: { id: accountId } });
    expect((account.capabilities as { saveDraft: { status: string } }).saveDraft.status).toBe(
      'unverified',
    );
    draftMode = 'success';
    workerProcess = startProcess('apps/server/dist/worker.js');
  }, 45000);

  it('确定失败后显式重试复用原投递意图并新增执行记录，成功后不能再次重试', async () => {
    draftMode = 'refused';
    const count = await database.delivery.count({ where: { accountId } });
    const before = calls.draft;
    const task = await data(
      await request(`/accounts/${accountId}/test-draft`, 'POST', {
        coverId,
        requestId: randomUUID(),
        confirmed: true,
      }),
    );
    const failed = await poll(
      () => delivery(task.id),
      (row) => row.state === 'FAILED',
      '明确拒绝后失败',
    );
    expect(failed.error).toContain('48001');
    expect(await database.deliveryAttempt.count({ where: { deliveryId: task.id } })).toBe(1);
    draftMode = 'success';
    const retry = await data(
      await request(`/deliveries/${task.id}/retry`, 'POST', { confirmed: true }),
    );
    expect(retry.id).toBe(task.id);
    await poll(
      () => delivery(task.id),
      (row) => row.state === 'SUCCEEDED',
      '显式重试成功',
    );
    expect(await database.delivery.count({ where: { accountId } })).toBe(count + 1);
    expect(await database.deliveryAttempt.count({ where: { deliveryId: task.id } })).toBe(2);
    expect(calls.draft).toBe(before + 2);
    expect(
      (await request(`/deliveries/${task.id}/retry`, 'POST', { confirmed: true })).status,
    ).toBe(409);
  }, 45000);

  it('密钥轮换清除缓存和能力，退出使原会话立即失效，日志无凭证明文', async () => {
    const previous = await database.account.findUniqueOrThrow({ where: { id: accountId } });
    const changed = await data(
      await request(`/accounts/${accountId}`, 'PATCH', {
        name: '已轮换公众号',
        appSecret: 'new-mock-secret-value',
      }),
    );
    expect(changed.credentialVersion).toBe(previous.credentialVersion + 1);
    expect(changed.capabilities.readDraft.status).toBe('unverified');
    expect(changed.capabilities.saveDraft.status).toBe('unverified');
    const stored = await database.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(stored.tokenEncrypted).toBeNull();
    expect(stored.tokenExpiresAt).toBeNull();
    expect(new SecretBox(key).decrypt(stored.secretEncrypted)).toBe('new-mock-secret-value');
    expect((await request('/auth/logout', 'POST', {})).status).toBe(200);
    expect((await request('/auth/me')).status).toBe(401);
    const combinedLogs = [...logs.values()].join('\n');
    for (const secret of [
      adminPassword,
      appSecret,
      accessToken,
      'new-mock-secret-value',
      'manual-check-secret-value',
    ])
      expect(combinedLogs).not.toContain(secret);
  });
});
