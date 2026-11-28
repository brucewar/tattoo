import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const identifier = randomUUID().replaceAll('-', '').slice(0, 12);
const project = 'tattoo-p1-smoke-' + identifier;
const cwd = fileURLToPath(new URL('../', import.meta.url));
const image = process.env.TATTOO_IMAGE || 'tattoo-app:local';
assert.ok(image.length <= 300 && !/[\s\u0000-\u001f]/.test(image), '测试镜像引用无效');
const env = { ...process.env };
for (const name of Object.keys(env)) {
  if (
    /^(?:COMPOSE_|TATTOO_|APP_|ADMIN_|POSTGRES_|DATABASE_URL$|REMOTE_WRITES_ENABLED$|WEB_PORT$|COOKIE_SECURE$|NODE_ENV$|PORT$|STORAGE_PATH$|WECHAT_|ALLOW_MOCK_WECHAT$|SOURCES_TEST_ORIGIN$)/i.test(
      name,
    )
  )
    delete env[name];
}
const databasePassword = randomBytes(24).toString('hex');
const encryptionKey = randomBytes(32).toString('base64');
const adminPassword = randomBytes(24).toString('base64url');
const secrets = [databasePassword, encryptionKey, adminPassword];
const marker = randomUUID();
const webPort = await unusedPort();
const origin = 'http://127.0.0.1:' + webPort;
const temporaryRoot = await realpath(tmpdir());
const directoryPrefix = 'tattoo-foundation-' + identifier + '-';
const directory = await mkdtemp(join(temporaryRoot, directoryPrefix));
const envFile = join(directory, 'test.env');
const prefix = [
  'compose',
  '--env-file',
  envFile,
  '-f',
  'compose.yaml',
  '-f',
  'compose.build.yaml',
  '-p',
  project,
];
let failure;
const cleanupErrors = [];

function redact(value) {
  let result = String(value);
  for (const secret of secrets) result = result.replaceAll(secret, '[redacted]');
  return result.slice(-5000);
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function docker(args, input, allowFailure = false) {
  assert.match(project, /^tattoo-p1-smoke-[a-f0-9]{12}$/);
  const result = spawnSync('docker', args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      '部署验证命令失败：' + redact(result.stderr || result.error?.message || 'Docker 执行失败'),
    );
  }
  return result;
}

function compose(args, input, allowFailure = false) {
  return docker([...prefix, ...args], input, allowFailure);
}

function execute(script) {
  return compose(['exec', '-T', 'api', 'node', '--input-type=module'], script);
}

try {
  await writeFile(
    envFile,
    [
      'TATTOO_IMAGE=' + image,
      'POSTGRES_PASSWORD=' + databasePassword,
      'APP_ENCRYPTION_KEY=' + encryptionKey,
      'ADMIN_EMAIL=foundation-' + identifier + '@example.com',
      'ADMIN_PASSWORD=' + adminPassword,
      'APP_ORIGIN=' + origin,
      'WEB_PORT=127.0.0.1:' + webPort,
      'REMOTE_WRITES_ENABLED=false',
      '',
    ].join('\n'),
    { mode: 0o600, flag: 'wx' },
  );
  compose(['config', '--quiet']);
  // A former web service owns the same port. --remove-orphans must release it first.
  const legacyFile = join(directory, 'compose.json');
  const legacyConfiguration = JSON.parse(compose(['config', '--format', 'json']).stdout);
  delete legacyConfiguration.services.api.ports;
  legacyConfiguration.services.web = {
    image: legacyConfiguration.services.api.image,
    command: [
      'node',
      '-e',
      "require('node:http').createServer((q,s)=>s.end('legacy-web')).listen(8080,'0.0.0.0')",
    ],
    ports: ['127.0.0.1:' + webPort + ':8080'],
    healthcheck: {
      test: [
        'CMD',
        'node',
        '-e',
        "fetch('http://127.0.0.1:8080/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      ],
      interval: '1s',
      timeout: '3s',
      retries: 15,
    },
  };
  await writeFile(legacyFile, JSON.stringify(legacyConfiguration), { mode: 0o600, flag: 'wx' });
  docker([
    'compose',
    '--env-file',
    envFile,
    '-p',
    project,
    '--file',
    legacyFile,
    'up',
    '-d',
    '--wait',
  ]);
  assert.equal(await (await fetch(origin + '/')).text(), 'legacy-web');
  execute(`
    import { Client } from 'pg';
    import { writeFile } from 'node:fs/promises';
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('CREATE TABLE IF NOT EXISTS tattoo_p1_probe (id text PRIMARY KEY)');
      await client.query('INSERT INTO tattoo_p1_probe (id) VALUES ($1)', [${JSON.stringify(marker)}]);
      await writeFile('/data/assets/.tattoo-p1-probe', ${JSON.stringify(marker)});
    } finally { await client.end(); }
  `);
  compose(['up', '-d', '--remove-orphans', '--wait', '--wait-timeout', '150']);
  const raw = compose(['ps', '--format', 'json']).stdout.trim();
  const services = raw.startsWith('[')
    ? JSON.parse(raw)
    : raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
  assert.equal(services.length, 3);
  for (const service of services) {
    assert.equal(service.Health, 'healthy', service.Service);
    const published = (service.Publishers ?? []).filter((port) => port.PublishedPort > 0);
    if (service.Service === 'api') {
      assert.equal(published.length, 1);
      assert.equal(published[0].PublishedPort, webPort);
      assert.equal(published[0].URL, '127.0.0.1');
    } else assert.equal(published.length, 0, `${service.Service} 不应发布宿主端口`);
  }
  assert.equal(
    services.find((service) => service.Service === 'api').Image,
    services.find((service) => service.Service === 'worker').Image,
  );
  const page = await fetch(origin + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Tattoo/);
  const ready = await fetch(origin + '/api/v1/health/ready');
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).data.status, 'ready');
  const refreshed = await fetch(origin + '/articles');
  assert.equal(refreshed.status, 200);
  assert.match(refreshed.headers.get('Content-Type'), /text\/html/);
  assert.equal(refreshed.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(refreshed.headers.get('Cache-Control'), 'no-cache');
  const missing = await fetch(origin + '/api/v1/missing');
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('Content-Type'), /application\/json/);
  assert.equal((await fetch(origin + '/assets/missing.js')).status, 404);
  console.info(
    'PASS: 旧 Web 端口成功接管；三服务健康、单应用镜像、仅 API 发布端口、页面深链接与 API 可访问',
  );

  const missingKey = compose(
    ['run', '--rm', '--no-deps', '-e', 'APP_ENCRYPTION_KEY=', 'api'],
    undefined,
    true,
  );
  assert.notEqual(missingKey.status, 0, '缺少主密钥时 API 必须拒绝启动');
  assert.match(missingKey.stderr, /APP_ENCRYPTION_KEY/);
  const migrationFailure = compose(
    [
      'run',
      '--rm',
      '--no-deps',
      '-e',
      'DATABASE_URL=postgresql://invalid:invalid@postgres:5432/does_not_exist?connect_timeout=3',
      'api',
    ],
    undefined,
    true,
  );
  assert.notEqual(migrationFailure.status, 0, '迁移失败时必须拒绝启动');
  assert.doesNotMatch(migrationFailure.stdout, /Tattoo API 已启动/);
  const duplicate = compose(['run', '--rm', '--no-deps', 'worker'], undefined, true);
  assert.notEqual(duplicate.status, 0, '第二个 Worker 不应取得执行权');
  assert.match(duplicate.stderr, /Worker 停止/);
  console.info('PASS: 缺密钥拒启、迁移失败阻止启动、重复 Worker 被拒绝');

  compose(['up', '-d', '--force-recreate', '--wait', '--wait-timeout', '150']);
  execute(`
    import assert from 'node:assert/strict';
    import { Client } from 'pg';
    import { readFile, unlink } from 'node:fs/promises';
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      const result = await client.query('SELECT id FROM tattoo_p1_probe WHERE id=$1', [${JSON.stringify(marker)}]);
      assert.equal(result.rowCount, 1);
      assert.equal(await readFile('/data/assets/.tattoo-p1-probe', 'utf8'), ${JSON.stringify(marker)});
      await client.query('DROP TABLE tattoo_p1_probe');
      await unlink('/data/assets/.tattoo-p1-probe');
    } finally { await client.end(); }
  `);
  console.info('PASS: 重建三个容器后数据库和素材卷数据均保留，重复迁移成功');
} catch (error) {
  failure = error;
} finally {
  try {
    // Only this invocation's random project and volumes are disposable.
    assert.equal(project, 'tattoo-p1-smoke-' + identifier);
    compose(['down', '--volumes', '--remove-orphans']);
  } catch (error) {
    cleanupErrors.push(redact(error.message));
  }
  try {
    const resolved = await realpath(directory);
    const metadata = await lstat(directory);
    assert.equal(dirname(resolved), temporaryRoot);
    assert.ok(basename(resolved).startsWith(directoryPrefix));
    assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
    await rm(resolved, { recursive: true });
  } catch (error) {
    cleanupErrors.push(redact(error.message));
  }
}
if (failure) console.error('部署验收失败：' + redact(failure.message));
for (const error of cleanupErrors) console.error('隔离资源清理失败：' + error);
if (failure || cleanupErrors.length) process.exitCode = 1;
