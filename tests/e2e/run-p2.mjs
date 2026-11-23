import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Client } from 'pg';
import sharp from 'sharp';
import { createAiMock } from '../helpers/ai-mock.mjs';

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
const calls = { token: 0, count: 0, cover: 0, body: 0, draft: 0 };
const draftPayloads = [];
let nextDraftMode = 'success';
const unexpected = [];
const executeFile = promisify(execFile);
const cleanupErrors = [];
let failed = false;
let primaryError;
let createdSchema = false;
let storage;
let temporaryRoot;
let mock;
let aiMock;

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
    detached: process.platform !== 'win32',
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
      reject(new Error('浏览器测试超过十分钟'));
    }, 600000);
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
  if (child.exitCode !== null || child.signalCode !== null || !Number.isInteger(child.pid)) return;
  const label = `${logs.get(child).name} (PID ${child.pid})`;
  // Windows process startup/exit notifications can be slow under host load.
  // Reserve the last five seconds for reclaiming our taskkill helper itself.
  const stopMilliseconds = process.platform === 'win32' ? 45000 : 15000;
  const deadlineAt = Date.now() + stopMilliseconds;
  let onExit;
  const exited = new Promise((resolve) => {
    onExit = resolve;
    child.once('exit', onExit);
  });
  let terminationError;
  let taskkillChild;
  let timeout;
  const terminate = async () => {
    try {
      if (process.platform === 'win32') {
        const taskkill = process.env.SystemRoot
          ? join(process.env.SystemRoot, 'System32', 'taskkill.exe')
          : 'taskkill.exe';
        const killing = executeFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          timeout: stopMilliseconds - 5000,
        });
        taskkillChild = killing.child;
        await killing;
      } else {
        // start() creates an isolated POSIX process group for each owned child.
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
          child.kill('SIGKILL');
        }
      }
    } catch (error) {
      terminationError = error;
    }
    await exited;
  };
  try {
    await Promise.race([
      terminate(),
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} 未在 ${stopMilliseconds / 1000} 秒内结束`)),
          stopMilliseconds,
        );
      }),
    ]);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null)
      throw new Error(`${label} 清理失败`, { cause: terminationError ?? error });
  } finally {
    clearTimeout(timeout);
    child.removeListener('exit', onExit);
    if (taskkillChild && taskkillChild.exitCode === null && taskkillChild.signalCode === null) {
      let helperTimer;
      let onHelperExit;
      const helperExited = new Promise((resolve) => {
        onHelperExit = resolve;
        taskkillChild.once('exit', onHelperExit);
      });
      taskkillChild.kill('SIGKILL');
      try {
        await Promise.race([
          helperExited,
          new Promise((_, reject) => {
            helperTimer = setTimeout(
              () => reject(new Error(`${label} 的 taskkill 助手未结束 (PID ${taskkillChild.pid})`)),
              Math.max(1, deadlineAt - Date.now()),
            );
          }),
        ]);
      } finally {
        clearTimeout(helperTimer);
        taskkillChild.removeListener('exit', onHelperExit);
      }
    }
  }
}

async function cleanup(label, operation) {
  try {
    await operation();
  } catch (error) {
    cleanupErrors.push(
      new Error(`${label}：${redact(error instanceof Error ? error.message : String(error))}`),
    );
  }
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
  aiMock = createAiMock(
    await sharp({ create: { width: 360, height: 200, channels: 3, background: '#476b5a' } })
      .png()
      .toBuffer(),
  );
  mock = createServer(async (incoming, outgoing) => {
    const pathname = new URL(incoming.url ?? '/', 'http://mock.local').pathname;
    const chunks = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    outgoing.setHeader('Content-Type', 'application/json');
    if (await aiMock.handle(incoming, outgoing, pathname, body)) return;
    if (pathname === '/__tattoo_control' && incoming.method === 'POST') {
      const input = JSON.parse(body.toString('utf8'));
      assert.ok(['success', 'disconnect', 'refused'].includes(input.nextDraft));
      nextDraftMode = input.nextDraft;
      outgoing.end(JSON.stringify({ ok: true }));
    } else if (pathname === '/__tattoo_audit' && incoming.method === 'GET') {
      outgoing.end(JSON.stringify({ calls, draftPayloads, unexpected }));
    } else if (pathname === '/cgi-bin/stable_token') {
      calls.token++;
      outgoing.end(JSON.stringify({ access_token: token, expires_in: 7200 }));
    } else if (pathname === '/cgi-bin/draft/count') {
      calls.count++;
      outgoing.end(JSON.stringify({ total_count: 2 }));
    } else if (pathname === '/cgi-bin/material/add_material') {
      calls.cover++;
      outgoing.end(JSON.stringify({ media_id: `tattoo-e2e-cover-${calls.cover}` }));
    } else if (pathname === '/cgi-bin/media/uploadimg') {
      calls.body++;
      outgoing.end(
        JSON.stringify({ url: `https://mmbiz.qpic.cn/tattoo-e2e-body-${calls.body}.jpg` }),
      );
    } else if (pathname === '/cgi-bin/draft/add') {
      calls.draft++;
      draftPayloads.push(JSON.parse(body.toString('utf8')));
      const mode = nextDraftMode;
      nextDraftMode = 'success';
      if (mode === 'disconnect') incoming.socket.destroy();
      else if (mode === 'refused')
        outgoing.end(JSON.stringify({ errcode: 48001, errmsg: 'api unauthorized' }));
      else outgoing.end(JSON.stringify({ media_id: `p2-e2e-draft-${calls.draft}` }));
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
    TATTOO_E2E_WECHAT_CONTROL_URL: `http://127.0.0.1:${mockAddress.port}`,
    TATTOO_E2E_AI_BASE_URL: `http://127.0.0.1:${mockAddress.port}/v1`,
    TATTOO_E2E_AI_CONTROL_URL: `http://127.0.0.1:${mockAddress.port}`,
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
    // Keep server-side mocks in test mode, but use the real browser component runtime.
    // rc-util deliberately gives every dialog the same ID in NODE_ENV=test.
    { ...env, NODE_ENV: 'development' },
    join(root, 'apps/web'),
  );
  await ready(webOrigin, vite);
  console.info('浏览器验证：独立 API、Worker、Vite、模拟微信与模型接口已就绪');
  const playwright = start(
    'Playwright',
    [join(root, 'node_modules/@playwright/test/cli.js'), 'test', ...process.argv.slice(2)],
    env,
    root,
    true,
  );
  await wait(playwright);
  assert.ok(calls.token >= 1);
  assert.ok(calls.count >= 1);
  assert.ok(calls.cover >= 1);
  assert.ok(calls.draft >= 1);
  assert.equal(
    draftPayloads.filter((payload) => payload.articles?.[0]?.title === 'Tattoo 接入测试').length,
    1,
  );
  assert.deepEqual(unexpected, []);
  assert.ok(aiMock.calls.text >= 1);
  assert.ok(aiMock.calls.image >= 1);
} catch (error) {
  failed = true;
  primaryError = error;
  for (const entry of logs.values())
    if (entry.name !== 'Playwright') console.error(`${entry.name} 日志：${redact(entry.text)}`);
} finally {
  for (const child of [...children].reverse())
    await cleanup(`停止 ${logs.get(child).name}`, () => stop(child));
  if (mock) {
    aiMock?.releaseAll();
    await cleanup('关闭模拟微信', async () => {
      mock.closeAllConnections();
      if (mock.listening)
        await new Promise((resolve, reject) =>
          mock.close((error) => (error ? reject(error) : resolve())),
        );
    });
  }
  if (createdSchema) {
    await cleanup('删除本次验证 schema', async () => {
      if (!/^tattoo_p2_e2e_[0-9a-f]{32}$/.test(schema)) throw new Error('验证 schema 范围校验失败');
      await database.query({ text: 'SET statement_timeout = 15000', query_timeout: 15000 });
      await database.query({ text: `DROP SCHEMA "${schema}" CASCADE`, query_timeout: 15000 });
    });
  }
  await cleanup('关闭验证数据库连接', () => database.end());
  if (storage) {
    await cleanup('删除本次临时素材目录', async () => {
      if (dirname(storage) !== temporaryRoot || !basename(storage).startsWith('tattoo-p2-e2e-'))
        throw new Error('临时素材目录范围校验失败');
      await rm(storage, { recursive: true });
    });
  }
}

if (failed) {
  for (const error of cleanupErrors) console.error(`额外清理错误：${error.message}`);
  throw primaryError;
}
if (cleanupErrors.length) throw new AggregateError(cleanupErrors, '浏览器验证后的资源清理失败');
console.info(
  'PASS: 账号、文章编辑及投递浏览器验证完成，固定测试草稿仅创建一次，没有发表或群发调用',
);
