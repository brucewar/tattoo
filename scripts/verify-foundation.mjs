import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = 'tattoo-p1-smoke';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env, WEB_PORT: '18080', APP_ORIGIN: 'http://localhost:18080' };
const prefix = ['compose', '-f', 'compose.yaml', '-f', 'compose.build.yaml', '-p', project];
const marker = randomUUID();
const temporaryRoot = await realpath(tmpdir());
const legacyDirectory = await mkdtemp(join(temporaryRoot, 'tattoo-legacy-web-'));

function compose(args, input, allowFailure = false) {
  const result = spawnSync('docker', [...prefix, ...args], {
    cwd,
    env,
    input,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (!allowFailure && result.status !== 0) {
    console.error(result.stdout, result.stderr);
    throw new Error(`部署验证命令失败：${args[0]}`);
  }
  return result;
}

function execute(script) {
  return compose(['exec', '-T', 'api', 'node', '--input-type=module'], script);
}

try {
  compose(['config', '--quiet']);
  // A former web service owns the same port. --remove-orphans must release it first.
  const legacyFile = join(legacyDirectory, 'compose.json');
  const legacyConfiguration = JSON.parse(compose(['config', '--format', 'json']).stdout);
  delete legacyConfiguration.services.api.ports;
  legacyConfiguration.services.web = {
    image: legacyConfiguration.services.api.image,
    command: [
      'node',
      '-e',
      "require('node:http').createServer((q,s)=>s.end('legacy-web')).listen(8080,'0.0.0.0')",
    ],
    ports: ['18080:8080'],
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
  await writeFile(legacyFile, JSON.stringify(legacyConfiguration), { mode: 0o600 });
  const legacy = spawnSync(
    'docker',
    ['compose', '-p', project, '--file', legacyFile, 'up', '-d', '--wait'],
    {
      cwd,
      env,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  assert.equal(legacy.status, 0, legacy.stderr);
  assert.equal(await (await fetch('http://127.0.0.1:18080/')).text(), 'legacy-web');
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
  const services = compose(['ps', '--format', 'json'])
    .stdout.trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(services.length, 3);
  for (const service of services) {
    assert.equal(service.Health, 'healthy', service.Service);
    const published = (service.Publishers ?? []).filter((port) => port.PublishedPort > 0);
    if (service.Service === 'api')
      assert.ok(published.some((port) => port.PublishedPort === 18080));
    else assert.equal(published.length, 0, `${service.Service} 不应发布宿主端口`);
  }
  assert.equal(
    services.find((service) => service.Service === 'api').Image,
    services.find((service) => service.Service === 'worker').Image,
  );
  const page = await fetch('http://127.0.0.1:18080/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Tattoo/);
  const ready = await fetch('http://127.0.0.1:18080/api/v1/health/ready');
  assert.equal(ready.status, 200);
  assert.equal((await ready.json()).data.status, 'ready');
  const refreshed = await fetch('http://127.0.0.1:18080/articles');
  assert.equal(refreshed.status, 200);
  assert.match(refreshed.headers.get('Content-Type'), /text\/html/);
  assert.equal(refreshed.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(refreshed.headers.get('Cache-Control'), 'no-cache');
  const missing = await fetch('http://127.0.0.1:18080/api/v1/missing');
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('Content-Type'), /application\/json/);
  assert.equal((await fetch('http://127.0.0.1:18080/assets/missing.js')).status, 404);
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
} finally {
  // This fixed project is reserved for disposable verification, never the user's deployment.
  compose(['down', '--remove-orphans']);
  if (
    dirname(legacyDirectory) !== temporaryRoot ||
    !basename(legacyDirectory).startsWith('tattoo-legacy-web-')
  )
    throw new Error('旧部署验证临时目录范围无效');
  await rm(legacyDirectory, { recursive: true });
}
