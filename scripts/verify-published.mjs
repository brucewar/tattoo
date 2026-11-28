import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const { values } = parseArgs({
  options: { image: { type: 'string' }, anonymous: { type: 'boolean', default: false } },
});
const image = values.image;
assert.match(
  image ?? '',
  /^ghcr\.io\/brucewar\/tattoo@sha256:[0-9a-f]{64}$/,
  '请提供待验收的 GHCR 镜像 digest',
);
const repository = fileURLToPath(new URL('../', import.meta.url));
const project = 'tattoo-ghcr-probe-' + randomUUID().replaceAll('-', '').slice(0, 12);
const environment = { ...process.env };
for (const name of Object.keys(environment)) {
  if (
    /^(?:COMPOSE_|TATTOO_|APP_|ADMIN_|POSTGRES_|DATABASE_URL$|REMOTE_WRITES_ENABLED$|WEB_PORT$|COOKIE_SECURE$|NODE_ENV$|PORT$|STORAGE_PATH$)/i.test(
      name,
    )
  )
    delete environment[name];
}
const password = randomBytes(24).toString('hex');
const adminPassword = randomBytes(24).toString('base64url');
const encryptionKey = randomBytes(32).toString('base64');
const secrets = [password, adminPassword, encryptionKey];
let directory;
let temporaryRoot;
let envFile;
let origin;
let failure;
let composeStarted = false;
let cleanupFailed = false;
let anonymousDirectory;

function redact(value) {
  let output = String(value);
  for (const secret of secrets) output = output.replaceAll(secret, '[redacted]');
  return output.slice(-5000);
}

function docker(args, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      cwd: repository,
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = [];
    const errors = [];
    let bytes = 0;
    let error;
    const timer = setTimeout(() => {
      error = new Error('Docker 验收操作超时');
      child.kill('SIGKILL');
    }, timeout);
    for (const [stream, chunks] of [
      [child.stdout, output],
      [child.stderr, errors],
    ])
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 2_000_000) {
          error = new Error('Docker 验收输出超限');
          child.kill('SIGKILL');
        } else chunks.push(chunk);
      });
    child.once('error', () => {
      error = new Error('无法运行 Docker CLI');
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (error || code !== 0)
        reject(
          error ?? new Error('Docker 操作失败：' + redact(Buffer.concat(errors).toString('utf8'))),
        );
      else resolve(Buffer.concat(output).toString('utf8').trim());
    });
  });
}

function compose(args) {
  assert.match(project, /^tattoo-ghcr-probe-[a-f0-9]{12}$/);
  return docker([
    'compose',
    '--project-name',
    project,
    '--env-file',
    envFile,
    '--file',
    join(repository, 'compose.yaml'),
    ...args,
  ]);
}

async function prepareAnonymousDocker() {
  const value = (name) =>
    Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1];
  const contextName = await docker(['context', 'show']);
  const context = JSON.parse(await docker(['context', 'inspect', contextName]))[0];
  const explicitHost = !value('DOCKER_CONTEXT') && value('DOCKER_HOST');
  const host = explicitHost || context?.Endpoints?.docker?.Host;
  assert.ok(typeof host === 'string' && host.length, '无法解析当前 Docker 引擎地址');
  if (!explicitHost && context?.TLSMaterial?.docker?.length && !value('DOCKER_CERT_PATH'))
    throw new Error('当前 Docker context 依赖专用 TLS 资料；匿名验收需使用显式 Docker 连接环境');
  const before = JSON.parse(
    await docker([
      'info',
      '--format',
      '{"id":{{json .ID}},"plugins":{{json .ClientInfo.Plugins}}}',
    ]),
  );
  const plugin = before.plugins?.find((item) => item.Name === 'compose');
  assert.ok(plugin?.Path && isAbsolute(plugin.Path), '无法定位当前可信 Docker Compose 插件');
  const pluginDirectory = await realpath(dirname(plugin.Path));
  temporaryRoot = await realpath(tmpdir());
  anonymousDirectory = await mkdtemp(join(temporaryRoot, 'tattoo-ghcr-anonymous-'));
  await writeFile(
    join(anonymousDirectory, 'config.json'),
    // An empty registry entry prevents Docker from auto-discovering a native credential store.
    JSON.stringify({ auths: { 'ghcr.io': {} }, cliPluginsExtraDirs: [pluginDirectory] }),
    { mode: 0o600, flag: 'wx' },
  );
  // Keep the current engine, but do not inherit registry credentials or credential helpers.
  for (const name of Object.keys(environment))
    if (
      ['DOCKER_CONTEXT', 'DOCKER_CONFIG', 'DOCKER_AUTH_CONFIG', 'DOCKER_HOST'].includes(
        name.toUpperCase(),
      )
    )
      delete environment[name];
  environment.DOCKER_HOST = host;
  environment.DOCKER_CONFIG = anonymousDirectory;
  assert.equal(
    await docker(['info', '--format', '{{.ID}}']),
    before.id,
    '匿名配置不得切换 Docker 引擎',
  );
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

function picture() {
  function chunk(type, bytes) {
    const data = Buffer.concat([Buffer.from(type), bytes]);
    let crc = 0xffffffff;
    for (const byte of data) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, data, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const row = Buffer.from([0, 40, 90, 60, 255, 40, 90, 60, 255]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat([row, row]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function request(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  return fetch(origin + '/api/v1' + path, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(method !== 'GET' ? { Origin: origin, 'X-Tattoo-Request': '1' } : {}),
      ...headers,
    },
    ...(body === undefined ? {} : { body }),
    signal: AbortSignal.timeout(15000),
  });
}

async function data(response) {
  assert.ok(response.ok, '验收 HTTP 状态异常：' + response.status);
  return (await response.json()).data;
}

async function login() {
  const response = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'ghcr-probe@example.com', password: adminPassword }),
    headers: { 'Content-Type': 'application/json' },
  });
  const user = await data(response);
  assert.equal(user.remoteWritesEnabled, false);
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
  assert.ok(cookie?.startsWith('tattoo_session='));
  secrets.push(cookie, cookie.slice(cookie.indexOf('=') + 1));
  return cookie;
}

try {
  if (values.anonymous) await prepareAnonymousDocker();
  assert.match(
    await docker(['info', '--format', '{{.OSType}}/{{.Architecture}}']),
    /^linux\/(?:x86_64|amd64)$/,
  );
  // A successful build or a locally cached tag is not publication evidence.
  await docker(['pull', '--platform', 'linux/amd64', image]);
  const inspected = JSON.parse(await docker(['image', 'inspect', image]))[0];
  assert.equal(inspected.Os + '/' + inspected.Architecture, 'linux/amd64');
  assert.ok(inspected.RepoDigests.includes(image), '实际镜像的仓库 digest 不匹配');
  await docker([
    'run',
    '--rm',
    '--entrypoint',
    'node',
    image,
    '--input-type=module',
    '-e',
    `
      import assert from 'node:assert/strict';
      import { spawnSync } from 'node:child_process';
      import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { basename, dirname, join } from 'node:path';
      import { parseEnv } from 'node:util';
      const directory = await mkdtemp(join(tmpdir(), 'tattoo-config-probe-'));
      const generate = file => spawnSync(process.execPath, ['scripts/configure.mjs', '--output', file], { encoding: 'utf8' });
      try {
        const firstFile = join(directory, 'first.env');
        const secondFile = join(directory, 'second.env');
        assert.equal(generate(firstFile).status, 0, '配置生成器未能创建新文件');
        assert.equal(generate(secondFile).status, 0, '配置生成器未能创建第二份独立文件');
        const original = await readFile(firstFile, 'utf8');
        const first = parseEnv(original);
        const second = parseEnv(await readFile(secondFile, 'utf8'));
        assert.equal(first.TATTOO_VERSION, '0.1.0-rc.2');
        assert.ok(/^[A-Za-z0-9+/]{43}=$/.test(first.APP_ENCRYPTION_KEY), '主密钥格式无效');
        assert.equal(Buffer.from(first.APP_ENCRYPTION_KEY, 'base64').length, 32);
        assert.ok(/^[a-f0-9]{48}$/.test(first.POSTGRES_PASSWORD), '数据库密码格式无效');
        assert.ok(/^[A-Za-z0-9_-]{32}$/.test(first.ADMIN_PASSWORD), '管理员密码格式无效');
        for (const field of ['APP_ENCRYPTION_KEY','POSTGRES_PASSWORD','ADMIN_PASSWORD'])
          assert.ok(first[field] !== second[field], '不同文件必须使用独立随机凭据');
        assert.equal((await stat(firstFile)).mode & 0o777, 0o600);
        assert.notEqual(generate(firstFile).status, 0, '配置生成器必须拒绝覆盖');
        assert.ok((await readFile(firstFile, 'utf8')) === original, '拒绝覆盖后配置必须不变');
        console.log('PASS: 镜像内配置生成器可创建独立随机凭据，并拒绝覆盖已有文件');
      } finally {
        assert.equal(dirname(directory), tmpdir());
        assert.ok(basename(directory).startsWith('tattoo-config-probe-'));
        await rm(directory, { recursive: true });
      }
    `,
  ]);
  temporaryRoot = await realpath(tmpdir());
  directory = await mkdtemp(join(temporaryRoot, 'tattoo-ghcr-probe-'));
  const port = await unusedPort();
  origin = 'http://127.0.0.1:' + port;
  envFile = join(directory, 'probe.env');
  await writeFile(
    envFile,
    [
      'TATTOO_IMAGE=' + image,
      'POSTGRES_PASSWORD=' + password,
      'APP_ENCRYPTION_KEY=' + encryptionKey,
      'APP_ORIGIN=' + origin,
      'ADMIN_EMAIL=ghcr-probe@example.com',
      'ADMIN_PASSWORD=' + adminPassword,
      'WEB_PORT=127.0.0.1:' + port,
      'REMOTE_WRITES_ENABLED=false',
      '',
    ].join('\n'),
    { mode: 0o600, flag: 'wx' },
  );
  const configuration = JSON.parse(await compose(['config', '--format', 'json']));
  for (const name of ['api', 'worker']) {
    assert.equal(configuration.services[name].image, image);
    assert.equal(configuration.services[name].build, undefined);
  }
  // PostgreSQL is a fixture; only the application must be pulled afresh from GHCR.
  // Reuse the official local tag when present, without reusing any database volume.
  if (!(await docker(['image', 'ls', '--quiet', 'postgres:16-alpine'])))
    await compose(['pull', 'postgres']);
  composeStarted = true;
  await compose(['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180']);
  const raw = await compose(['ps', '--format', 'json']);
  const services = raw.startsWith('[')
    ? JSON.parse(raw)
    : raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
  assert.deepEqual(services.map((row) => row.Service).sort(), ['api', 'postgres', 'worker']);
  for (const service of services) {
    assert.equal(service.Health, 'healthy');
    const published = (service.Publishers ?? []).filter((value) => value.PublishedPort > 0);
    assert.equal(published.length, service.Service === 'api' ? 1 : 0);
    if (service.Service === 'api') assert.equal(published[0].URL, '127.0.0.1');
  }
  for (const name of ['api', 'worker']) {
    const id = await compose(['ps', '-q', name]);
    assert.equal(await docker(['inspect', '--format', '{{.Image}}', id]), inspected.Id);
  }
  assert.equal((await data(await request('/health/ready'))).status, 'ready');
  const page = await fetch(origin + '/articles/refresh', { signal: AbortSignal.timeout(15000) });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Tattoo/);
  assert.equal(page.headers.get('X-Frame-Options'), 'DENY');
  assert.equal((await request('/not-present')).status, 404);
  let cookie = await login();
  const asset = await data(
    await request('/assets', {
      method: 'POST',
      body: picture(),
      cookie,
      headers: { 'Content-Type': 'image/png', 'X-Filename': 'release-probe.png' },
    }),
  );
  const article = await data(
    await request('/articles', {
      method: 'POST',
      cookie,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'GHCR 部署验收',
        author: '',
        digest: '拉取发布镜像后验证持久化',
        sourceUrl: '',
        coverId: asset.id,
        document: {
          type: 'doc',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: '这是发布镜像的隔离验收稿件。' }],
            },
          ],
        },
      }),
    }),
  );
  const before = await request('/assets/' + asset.id, { cookie });
  assert.equal(before.status, 200);
  const assetHash = createHash('sha256')
    .update(Buffer.from(await before.arrayBuffer()))
    .digest('hex');
  await compose([
    'up',
    '-d',
    '--force-recreate',
    '--no-build',
    '--pull',
    'never',
    '--wait',
    '--wait-timeout',
    '180',
  ]);
  cookie = await login();
  const restored = await data(await request('/articles/' + article.id, { cookie }));
  assert.equal(restored.revisionId, article.revisionId);
  assert.equal(restored.coverId, asset.id);
  const after = await request('/assets/' + asset.id, { cookie });
  assert.equal(after.status, 200);
  assert.equal(
    createHash('sha256')
      .update(Buffer.from(await after.arrayBuffer()))
      .digest('hex'),
    assetHash,
  );
  console.info(
    `PASS: 已${values.anonymous ? '匿名' : ''}从 GHCR 拉取准确 digest；纯拉取三服务、登录、页面/API、图片和重建后文章/素材持久化通过`,
  );
} catch (error) {
  failure = error;
} finally {
  if (composeStarted) {
    try {
      await compose(['down', '--volumes', '--remove-orphans']);
    } catch (error) {
      cleanupFailed = true;
      failure ??= error;
    }
  }
  if (directory && !cleanupFailed) {
    assert.equal(dirname(directory), temporaryRoot);
    assert.ok(basename(directory).startsWith('tattoo-ghcr-probe-'));
    await rm(directory, { recursive: true });
  }
  if (anonymousDirectory && !cleanupFailed) {
    assert.equal(dirname(anonymousDirectory), temporaryRoot);
    assert.ok(basename(anonymousDirectory).startsWith('tattoo-ghcr-anonymous-'));
    await rm(anonymousDirectory, { recursive: true });
  }
  if (cleanupFailed)
    console.error('隔离资源清理失败，保留配置供排查：' + project + ' / ' + directory);
}
if (failure) {
  console.error(redact(failure.message));
  process.exitCode = 1;
}
