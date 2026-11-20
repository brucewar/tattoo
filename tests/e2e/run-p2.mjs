import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';

const root = fileURLToPath(new URL('../../', import.meta.url));
const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !/test/i.test(new URL(databaseUrl).pathname)) {
  throw new Error('浏览器验证只允许显式 TEST_DATABASE_URL，数据库名称必须包含 test');
}
const schema = `tattoo_p2_e2e_${randomUUID().replaceAll('-', '')}`;
const scopedUrl = new URL(databaseUrl);
scopedUrl.searchParams.set('schema', schema);
const database = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 10000 });
const adminEmail = 'p2-e2e@example.com';
const adminPassword = 'p2-e2e-test-password';
const encryptionKey = Buffer.alloc(32, 13).toString('base64');
const token = 'p2-e2e-token-never-real';
const secrets = [
  databaseUrl,
  scopedUrl.toString(),
  decodeURIComponent(new URL(databaseUrl).password),
  adminPassword,
  encryptionKey,
  token,
].filter(Boolean);
const children = [];
const logs = new Map();
const calls = { token: 0, count: 0, cover: 0, draft: 0 };
const unexpected = [];
let createdSchema = false;
let storage;
let temporaryRoot;
let mock;

function redact(value) {
  let result = value;
  for (const secret of secrets) result = result.replaceAll(secret, '[redacted]');
  return result;
}

async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法分配验证端口');
  const value = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return value;
}

function start(name, args, env, cwd = root, visible = false) {
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(child);
  logs.set(child, { name, text: '' });
  for (const output of [child.stdout, child.stderr])
    output.on('data', (data) => {
      const chunk = redact(data.toString('utf8'));
      logs.get(child).text = (logs.get(child).text + chunk).slice(-32768);
      if (visible) process.stdout.write(chunk);
    });
  return child;
}

async function ready(url, child) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`${logs.get(child).name} 提前退出：${logs.get(child).text}`);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`${logs.get(child).name} 就绪超时：${logs.get(child).text}`);
}

async function wait(child) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('浏览器测试超过五分钟'));
    }, 300000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(new Error(`浏览器测试失败，退出码 ${code}`));
    });
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('验证子进程未按时结束')), 5000);
    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill('SIGKILL');
  });
}

try {
  await database.connect();
  await database.query(`CREATE SCHEMA "${schema}"`);
  createdSchema = true;
  await database.query(`SET search_path TO "${schema}"`);
  const migrations = join(root, 'apps/server/prisma/migrations');
  for (const entry of (await readdir(migrations, { withFileTypes: true }))
    .filter((item) => item.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    await database.query(await readFile(join(migrations, entry.name, 'migration.sql'), 'utf8'));
  }
  temporaryRoot = await realpath(tmpdir());
  storage = await mkdtemp(join(temporaryRoot, 'tattoo-p2-e2e-'));
  mock = createServer(async (incoming, outgoing) => {
    const pathname = new URL(incoming.url ?? '/', 'http://mock.local').pathname;
    for await (const _chunk of incoming) {
      /* Consume request bytes without logging credentials. */
    }
    outgoing.setHeader('Content-Type', 'application/json');
    if (pathname === '/cgi-bin/stable_token') {
      calls.token++;
      outgoing.end(JSON.stringify({ access_token: token, expires_in: 7200 }));
    } else if (pathname === '/cgi-bin/draft/count') {
      calls.count++;
      outgoing.end(JSON.stringify({ total_count: 2 }));
    } else if (pathname === '/cgi-bin/material/add_material') {
      calls.cover++;
      outgoing.end(JSON.stringify({ media_id: 'p2-e2e-cover' }));
    } else if (pathname === '/cgi-bin/draft/add') {
      calls.draft++;
      outgoing.end(JSON.stringify({ media_id: `p2-e2e-draft-${calls.draft}` }));
    } else {
      unexpected.push(pathname);
      outgoing.statusCode = 404;
      outgoing.end(JSON.stringify({ errcode: 404 }));
    }
  });
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const mockAddress = mock.address();
  if (!mockAddress || typeof mockAddress === 'string') throw new Error('模拟微信未能监听');
  const apiPort = await port();
  const webPort = await port();
  const apiOrigin = `http://127.0.0.1:${apiPort}`;
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: scopedUrl.toString(),
    APP_ENCRYPTION_KEY: encryptionKey,
    APP_ORIGIN: webOrigin,
    PORT: String(apiPort),
    STORAGE_PATH: storage,
    ADMIN_EMAIL: adminEmail,
    ADMIN_PASSWORD: adminPassword,
    COOKIE_SECURE: 'false',
    ALLOW_MOCK_WECHAT: 'true',
    WECHAT_API_BASE: `http://127.0.0.1:${mockAddress.port}`,
    REMOTE_WRITES_ENABLED: 'true',
    TATTOO_API_PROXY: apiOrigin,
    TATTOO_E2E_TEST_MODE: '1',
    TATTOO_E2E_BASE_URL: webOrigin,
    TATTOO_E2E_EMAIL: adminEmail,
    TATTOO_E2E_PASSWORD: adminPassword,
  };
  const api = start('API', [join(root, 'apps/server/dist/main.js')], env);
  await ready(`${apiOrigin}/api/v1/health/ready`, api);
  start('Worker', [join(root, 'apps/server/dist/worker.js')], env);
  const vite = start(
    'Vite',
    [
      join(root, 'node_modules/vite/bin/vite.js'),
      '--host',
      '127.0.0.1',
      '--port',
      String(webPort),
      '--strictPort',
    ],
    env,
    join(root, 'apps/web'),
  );
  await ready(webOrigin, vite);
  console.info('P2 浏览器验证：独立 API、Worker、Vite 和模拟微信已就绪');
  const playwright = start(
    'Playwright',
    [join(root, 'node_modules/@playwright/test/cli.js'), 'test'],
    env,
    root,
    true,
  );
  await wait(playwright);
  assert.ok(calls.token >= 1);
  assert.ok(calls.count >= 1);
  assert.equal(calls.cover, 1);
  assert.equal(calls.draft, 1);
  assert.deepEqual(unexpected, []);
  console.info(
    'PASS: 浏览器真实操作完成，模拟微信仅创建一个封面素材和一篇草稿，没有发表或群发调用',
  );
} catch (error) {
  for (const entry of logs.values())
    if (entry.name !== 'Playwright') console.error(`${entry.name} 日志：${redact(entry.text)}`);
  throw error;
} finally {
  for (const child of [...children].reverse()) await stop(child);
  if (mock) {
    mock.closeAllConnections();
    await new Promise((resolve) => mock.close(resolve));
  }
  if (createdSchema) {
    if (!/^tattoo_p2_e2e_[0-9a-f]{32}$/.test(schema)) throw new Error('验证 schema 范围校验失败');
    await database.query(`DROP SCHEMA "${schema}" CASCADE`);
  }
  await database.end();
  if (storage) {
    if (dirname(storage) !== temporaryRoot || !basename(storage).startsWith('tattoo-p2-e2e-'))
      throw new Error('临时素材目录范围校验失败');
    await rm(storage, { recursive: true });
  }
}
