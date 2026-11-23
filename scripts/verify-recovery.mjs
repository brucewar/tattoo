import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const repository = fileURLToPath(new URL('../', import.meta.url));
const version = process.env.TATTOO_VERSION || 'local';
assert.match(version, /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, '无效的验证镜像标签');
const identifier = randomUUID().replaceAll('-', '').slice(0, 12);
const sourceProject = 'tattoo-p5-src-' + identifier;
const targetProject = 'tattoo-p5-dst-' + identifier;
const applicationEnvironment = [
  'APP_ENCRYPTION_KEY',
  'POSTGRES_PASSWORD',
  'APP_ORIGIN',
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD',
  'REMOTE_WRITES_ENABLED',
  'WEB_PORT',
  'TATTOO_VERSION',
  'COOKIE_SECURE',
  'DATABASE_URL',
  'STORAGE_PATH',
  'NODE_ENV',
  'PORT',
  'WECHAT_API_BASE',
  'ALLOW_MOCK_WECHAT',
];
const isolatedEnvironment = { ...process.env };
for (const key of Object.keys(isolatedEnvironment)) {
  if (
    applicationEnvironment.includes(key.toUpperCase()) ||
    key.toUpperCase().startsWith('COMPOSE_')
  )
    delete isolatedEnvironment[key];
}
const key = randomBytes(32).toString('base64');
const wrongKey = randomBytes(32).toString('base64');
const adminEmail = 'p5-recovery@example.com';
const adminPassword = randomBytes(24).toString('base64url');
const accountSecret = 'p5-only-fake-' + randomBytes(24).toString('hex');
const aiSecret = 'p6-only-fake-' + randomBytes(24).toString('hex');
const secrets = [key, wrongKey, adminPassword, accountSecret, aiSecret];
const cleanupErrors = [];
let temporaryRoot;
let directory;
let source;
let target;
let failure;

function redact(value) {
  let result = String(value);
  for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[redacted]');
  return result.slice(-5000);
}

function run(executable, args, { input, allowFailure = false, timeout = 300000, label } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: repository,
      env: isolatedEnvironment,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = [];
    const errors = [];
    let bytes = 0;
    let failed;
    const timer = setTimeout(() => {
      failed = new Error((label || '验证命令') + ' 超时');
      child.kill('SIGKILL');
    }, timeout);
    for (const [stream, chunks] of [
      [child.stdout, output],
      [child.stderr, errors],
    ]) {
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 2_000_000) {
          failed = new Error('验证命令输出超限');
          child.kill('SIGKILL');
        } else chunks.push(chunk);
      });
    }
    child.stdin.on('error', () => {});
    child.once('error', () => {
      failed = new Error((label || '验证命令') + ' 无法启动，请检查 Node 与 Docker CLI');
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(output).toString('utf8').trim();
      const stderr = Buffer.concat(errors).toString('utf8').trim();
      if (failed) reject(failed);
      else if (code !== 0 && !allowFailure)
        reject(new Error((label || '验证命令') + ' 失败：' + redact(stderr)));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

function compose(stack, args, options) {
  assert.ok([sourceProject, targetProject].includes(stack.project), '项目不属于本次验证');
  return run(
    'docker',
    [
      'compose',
      '--file',
      join(repository, 'compose.yaml'),
      '--env-file',
      stack.envFile,
      '--project-name',
      stack.project,
      ...args,
    ],
    { ...options, label: options?.label || '隔离 Compose ' + args[0] },
  );
}

function containerNode(stack, script) {
  return compose(
    stack,
    ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'api', '--input-type=module'],
    { input: script, label: '隔离容器数据断言' },
  );
}

function execNode(stack, script) {
  return compose(stack, ['exec', '-T', 'api', 'node', '--input-type=module'], {
    input: script,
    label: '隔离源数据准备',
  });
}

async function port() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const selected = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return selected;
}

async function environmentFile(name, portNumber, encryptionKey = key, remoteWrites = false) {
  const password = randomBytes(24).toString('hex');
  secrets.push(password);
  const filename = join(directory, name);
  await writeFile(
    filename,
    [
      'POSTGRES_PASSWORD=' + password,
      'APP_ENCRYPTION_KEY=' + encryptionKey,
      'APP_ORIGIN=http://127.0.0.1:' + portNumber,
      'ADMIN_EMAIL=' + adminEmail,
      'ADMIN_PASSWORD=' + adminPassword,
      'REMOTE_WRITES_ENABLED=' + remoteWrites,
      'WEB_PORT=' + portNumber,
      'TATTOO_VERSION=' + version,
      '',
    ].join('\n'),
    { mode: 0o600, flag: 'wx' },
  );
  return filename;
}

function rows(stdout) {
  if (!stdout) return [];
  return stdout.startsWith('[')
    ? JSON.parse(stdout)
    : stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

async function runningServices(stack) {
  const result = await compose(stack, ['ps', '--all', '--format', 'json']);
  return rows(result.stdout)
    .filter((row) => row.State === 'running')
    .map((row) => row.Service)
    .sort();
}

async function noTargetResources() {
  assert.deepEqual(rows((await compose(target, ['ps', '--all', '--format', 'json'])).stdout), []);
  const volumes = await run(
    'docker',
    [
      'volume',
      'ls',
      '--filter',
      'label=com.docker.compose.project=' + targetProject,
      '--format',
      '{{.Name}}',
    ],
    { label: '空目标卷检查' },
  );
  assert.equal(volumes.stdout, '', '恢复校验失败时不应创建目标数据卷');
}

async function http(stack, path, { method = 'GET', json, binary, cookie, status = 200 } = {}) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  if (method !== 'GET') {
    headers.Origin = stack.origin;
    headers['X-Tattoo-Request'] = '1';
  }
  let body;
  if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (binary) {
    headers['Content-Type'] = 'image/png';
    headers['X-Filename'] = 'p5-recovery.png';
    body = binary;
  }
  const response = await fetch(stack.origin + '/api/v1' + path, {
    method,
    headers,
    body,
    signal: AbortSignal.timeout(35000),
  });
  assert.equal(
    response.status,
    status,
    method + ' ' + path + ' 状态异常，预期 ' + status + '，实际 ' + response.status,
  );
  return response;
}

async function login(stack) {
  const response = await http(stack, '/auth/login', {
    method: 'POST',
    json: { email: adminEmail, password: adminPassword },
  });
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0];
  assert.ok(cookie?.startsWith('tattoo_session='));
  secrets.push(cookie, cookie.slice(cookie.indexOf('=') + 1));
  const result = await response.json();
  assert.equal(result.data.remoteWritesEnabled, false);
  return cookie;
}

async function digest(filename) {
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { bytes, sha256: hash.digest('hex') };
}

function backupCommand(stack, backupDirectory, allowFailure = false) {
  return run(
    process.execPath,
    [
      join(repository, 'scripts/backup.mjs'),
      '--output',
      backupDirectory,
      '--project',
      stack.project,
      '--env-file',
      stack.envFile,
    ],
    { allowFailure, timeout: 600000, label: '实际备份 CLI' },
  );
}

function restoreCommand(backupDirectory, envFile = target.envFile, allowFailure = false) {
  return run(
    process.execPath,
    [
      join(repository, 'scripts/restore.mjs'),
      '--input',
      backupDirectory,
      '--project',
      target.project,
      '--env-file',
      envFile,
    ],
    { allowFailure, timeout: 600000, label: '实际恢复 CLI' },
  );
}

async function checkRestored(fixture) {
  const result = await containerNode(
    target,
    `
      import assert from 'node:assert/strict';
      import { createHash } from 'node:crypto';
      import { readFile } from 'node:fs/promises';
      import { PrismaClient } from '@prisma/client';
      import { SecretBox } from './apps/server/dist/security.js';
      const fixture = ${JSON.stringify(fixture)};
      const db = new PrismaClient();
      try {
        assert.equal(process.env.REMOTE_WRITES_ENABLED, 'false');
        assert.equal(await db.session.count(), 0);
        const account = await db.account.findUniqueOrThrow({ where: { id: fixture.accountId } });
        assert.equal(new SecretBox(process.env.APP_ENCRYPTION_KEY).decrypt(account.secretEncrypted), fixture.secret);
        const model = await db.aiModel.findUniqueOrThrow({ where: { capability: 'text' } });
        assert.equal(new SecretBox(process.env.APP_ENCRYPTION_KEY).decrypt(model.apiKeyEncrypted), fixture.aiSecret);
        const generationJobs = await db.generationJob.findMany({ where: { modelId: model.id } });
        assert.equal(generationJobs.length, fixture.generationJobs.length);
        for (const expected of fixture.generationJobs) {
          const actual = generationJobs.find((row) => row.id === expected.id);
          assert.ok(actual);
          assert.equal(actual.model, 'recovery-text-fixture');
          if (['QUEUED', 'RUNNING'].includes(expected.state)) {
            assert.equal(actual.state, 'UNCERTAIN');
            assert.equal(actual.executionId, null);
            assert.equal(actual.heartbeatAt, null);
            assert.match(actual.error, /恢复/);
          } else {
            assert.equal(actual.state, expected.state);
            assert.deepEqual(actual.result, expected.result);
          }
        }
        const article = await db.article.findUniqueOrThrow({ where: { id: fixture.articleId }, include: { revisions: { orderBy: { version: 'asc' } } } });
        assert.equal(article.version, fixture.revisions.length);
        assert.deepEqual(article.revisions.map(({ id, title, version }) => ({ id, title, version })), fixture.revisions);
        const asset = await db.asset.findUniqueOrThrow({ where: { id: fixture.assetId } });
        const bytes = await readFile('/data/assets/' + asset.path);
        assert.equal(createHash('sha256').update(bytes).digest('hex'), fixture.assetDigest);
        const mappings = await db.remoteAsset.findMany({ where: { accountId: fixture.accountId }, orderBy: { kind: 'asc' } });
        assert.equal(mappings.length, 2);
        const deliveries = await db.delivery.findMany({ orderBy: { revision: { version: 'asc' } }, include: { events: true, attempts: true } });
        assert.equal(deliveries.length, fixture.deliveries.length);
        for (const expected of fixture.deliveries) {
          const actual = deliveries.find((row) => row.id === expected.id);
          assert.ok(actual);
          assert.equal(actual.revisionId, expected.revisionId);
          assert.equal(actual.remoteId, expected.remoteId);
          if (['QUEUED', 'RUNNING'].includes(expected.state)) {
            assert.equal(actual.state, 'UNCERTAIN');
            assert.equal(actual.executionId, null);
            assert.equal(actual.heartbeatAt, null);
            assert.ok(actual.events.some((event) => event.actor === 'restore'));
            if (expected.state === 'RUNNING') {
              assert.equal(actual.attempts.length, 1);
              assert.equal(actual.attempts[0].state, 'UNCERTAIN');
            }
          } else {
            assert.equal(actual.state, expected.state);
            assert.equal(actual.stage, expected.stage);
            assert.equal(actual.events.filter((event) => event.actor === 'restore').length, 0);
          }
        }
        console.log(JSON.stringify({ article: article.id, revisions: article.revisions.map(({ id, title, version }) => ({ id, title, version })), asset: { id: asset.id, sha256: createHash('sha256').update(bytes).digest('hex') }, mappings, deliveries: deliveries.map(({ id, state, stage, remoteId, executionId, events, attempts }) => ({ id, state, stage, remoteId, executionId, events, attempts })), generationJobs: generationJobs.map(({ id, state, model }) => ({ id, state, model })) }));
      } finally { await db.$disconnect(); }
    `,
  );
  return JSON.parse(result.stdout);
}

try {
  console.info('本验收要求 Docker 发布端口可由当前管理机通过 127.0.0.1 访问。');
  temporaryRoot = await realpath(tmpdir());
  directory = await mkdtemp(join(temporaryRoot, 'tattoo-p5-recovery-'));
  const sourcePort = await port();
  let targetPort = await port();
  while (targetPort === sourcePort) targetPort = await port();
  source = {
    project: sourceProject,
    envFile: await environmentFile('source.env', sourcePort),
    origin: 'http://127.0.0.1:' + sourcePort,
  };
  target = {
    project: targetProject,
    envFile: await environmentFile('target.env', targetPort),
    origin: 'http://127.0.0.1:' + targetPort,
  };
  const engine = await run(
    'docker',
    ['version', '--format', '{{.Server.Version}} {{.Server.Os}}/{{.Server.Arch}}'],
    { label: 'Docker 版本检查' },
  );
  const composeVersion = await run('docker', ['compose', 'version', '--short'], {
    label: 'Compose 版本检查',
  });
  const image = await run(
    'docker',
    ['image', 'inspect', 'tattoo-app:' + version, '--format', '{{.Os}}/{{.Architecture}} {{.Id}}'],
    { label: '已构建镜像检查' },
  );
  assert.match(image.stdout, /^linux\//, '本验收使用 Linux 容器');
  console.info(
    '验证环境：Docker ' +
      engine.stdout +
      '；Compose ' +
      composeVersion.stdout +
      '；镜像 ' +
      image.stdout,
  );

  await compose(source, ['up', '-d', '--wait', '--wait-timeout', '180']);
  assert.deepEqual(await runningServices(source), ['api', 'postgres', 'web', 'worker']);
  const sourceCookie = await login(source);
  const account = (
    await (
      await http(source, '/accounts', {
        method: 'POST',
        status: 201,
        cookie: sourceCookie,
        json: {
          name: 'P5 恢复验收',
          appId: 'wx' + randomBytes(8).toString('hex'),
          appSecret: accountSecret,
        },
      })
    ).json()
  ).data;
  const png = await sharp({ create: { width: 80, height: 48, channels: 3, background: '#406552' } })
    .png()
    .toBuffer();
  const asset = (
    await (
      await http(source, '/assets', {
        method: 'POST',
        status: 201,
        binary: png,
        cookie: sourceCookie,
      })
    ).json()
  ).data;
  const assetResponse = await http(source, '/assets/' + asset.id, { cookie: sourceCookie });
  const originalAsset = Buffer.from(await assetResponse.arrayBuffer());
  const assetDigest = createHash('sha256').update(originalAsset).digest('hex');
  const articles = [];
  for (let versionNumber = 1; versionNumber <= 6; versionNumber++) {
    const fields = {
      title: 'P5 恢复修订 v' + versionNumber,
      author: 'P5 验收',
      digest: '数据库、图片、历史修订和投递状态恢复验收',
      sourceUrl: 'https://example.com/recovery',
      coverId: asset.id,
      document: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '恢复测试正文 v' + versionNumber }],
          },
          { type: 'image', attrs: { assetId: asset.id, alt: '恢复验收图片' } },
        ],
      },
    };
    const previous = articles.at(-1);
    const response = await http(source, previous ? '/articles/' + previous.id : '/articles', {
      method: previous ? 'PATCH' : 'POST',
      status: previous ? 200 : 201,
      cookie: sourceCookie,
      json: { ...fields, ...(previous ? { expectedVersion: previous.version } : {}) },
    });
    articles.push((await response.json()).data);
  }
  // AI is independent of the WeChat write switch. Stop this owned Worker before
  // seeding old generation jobs so this recovery exercise never calls a real model.
  await compose(source, ['stop', '--timeout', '45', 'worker']);
  await http(source, '/ai/models/text', {
    method: 'PUT',
    cookie: sourceCookie,
    json: {
      baseUrl: 'https://api.openai.com/v1',
      model: 'recovery-text-fixture',
      apiKey: aiSecret,
    },
  });
  const generationJobs = ['QUEUED', 'RUNNING', 'UNCERTAIN', 'FAILED', 'SUCCEEDED'].map((state) => ({
    id: randomUUID(),
    state,
    result: state === 'SUCCEEDED' ? { type: 'text', text: '恢复前的生成结果' } : null,
  }));
  const deliveries = ['QUEUED', 'RUNNING', 'UNCERTAIN', 'FAILED', 'SUCCEEDED'].map(
    (state, index) => ({
      id: randomUUID(),
      revisionId: articles[index].revisionId,
      state,
      stage: 'P5 原始状态 ' + state,
      remoteId: state === 'SUCCEEDED' ? 'p5-remote-' + identifier : null,
    }),
  );
  const fixture = {
    accountId: account.id,
    secret: accountSecret,
    aiSecret,
    generationJobs,
    articleId: articles[0].id,
    assetId: asset.id,
    assetDigest,
    revisions: articles.map((article) => ({
      id: article.revisionId,
      title: article.title,
      version: article.version,
    })),
    deliveries,
  };
  await execNode(
    source,
    `
      import { randomUUID } from 'node:crypto';
      import { PrismaClient } from '@prisma/client';
      import { RENDER_VERSION } from './apps/server/dist/platforms/wechat/renderer.js';
      const fixture = ${JSON.stringify(fixture)};
      const db = new PrismaClient();
      try {
        const model = await db.aiModel.findUniqueOrThrow({ where: { capability: 'text' } });
        for (const row of fixture.generationJobs) {
          await db.generationJob.create({ data: {
            id: row.id, requestKey: randomUUID(), kind: 'TEST_TEXT', capability: 'text',
            modelId: model.id, model: model.model, configVersion: model.version,
            inputHash: 'recovery-fixture', prompt: '恢复验收，仅准备旧任务，不发出模型请求',
            state: row.state,
            executionId: row.state === 'RUNNING' ? randomUUID() : null,
            heartbeatAt: row.state === 'RUNNING' ? new Date() : null,
            completedAt: ['UNCERTAIN', 'FAILED', 'SUCCEEDED'].includes(row.state) ? new Date() : null,
            ...(row.result ? { result: row.result } : {}),
          } });
        }
        for (const row of fixture.deliveries) {
          const attemptId = randomUUID();
          await db.delivery.create({ data: {
            ...row, accountId: fixture.accountId, renderVersion: RENDER_VERSION,
            executionId: row.state === 'RUNNING' ? attemptId : null,
            heartbeatAt: row.state === 'RUNNING' ? new Date() : null,
            submissionStartedAt: ['RUNNING', 'UNCERTAIN', 'SUCCEEDED'].includes(row.state) ? new Date() : null,
            completedAt: ['UNCERTAIN', 'SUCCEEDED', 'FAILED'].includes(row.state) ? new Date() : null,
            resultSource: row.state === 'SUCCEEDED' ? 'api' : null,
            events: { create: { actor: 'fixture', message: 'P5 隔离恢复验收数据' } },
            ...(row.state === 'QUEUED' ? {} : { attempts: { create: { id: attemptId, number: 1, state: row.state, stage: row.stage } } }),
          } });
        }
        await db.remoteAsset.createMany({ data: [
          { accountId: fixture.accountId, assetId: fixture.assetId, kind: 'COVER', remoteId: 'p5-cover-reference' },
          { accountId: fixture.accountId, assetId: fixture.assetId, kind: 'BODY', url: 'https://mmbiz.qpic.cn/p5-recovery.jpg' },
        ] });
        if (await db.session.count() !== 1) throw new Error('source session fixture missing');
        console.log('SOURCE_FIXTURES_READY');
      } finally { await db.$disconnect(); }
    `,
  );
  console.info(
    'PASS: 真实 HTTP 创建账号、图片、6 份修订和模型配置；停止 Worker 后准备五种投递与生成状态，无真实模型调用',
  );

  const backupDirectory = join(directory, 'backup');
  await backupCommand(source, backupDirectory);
  assert.deepEqual(await runningServices(source), ['postgres']);
  assert.deepEqual((await readdir(backupDirectory)).sort(), [
    'assets.tar',
    'database.dump',
    'manifest.json',
  ]);
  const manifestText = await readFile(join(backupDirectory, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.application.imageRef, 'tattoo-app:' + version);
  assert.match(manifest.application.imageId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    manifest.keyFingerprint,
    createHash('sha256').update(Buffer.from(key, 'base64')).digest('hex'),
  );
  for (const secret of secrets)
    assert.ok(!manifestText.includes(secret), 'manifest 不得包含明文凭证');
  for (const name of ['assets.tar', 'database.dump']) {
    const actual = await digest(join(backupDirectory, name));
    assert.ok(actual.bytes > 0);
    assert.deepEqual(actual, manifest.files[name]);
  }
  const duplicateBackup = await backupCommand(source, backupDirectory, true);
  assert.notEqual(duplicateBackup.code, 0);
  assert.equal(await readFile(join(backupDirectory, 'manifest.json'), 'utf8'), manifestText);
  for (const name of ['assets.tar', 'database.dump'])
    assert.deepEqual(await digest(join(backupDirectory, name)), manifest.files[name]);
  console.info('PASS: 停机一致备份包含数据库、素材和摘要，主密钥单独保管，已有备份拒绝覆盖');

  const wrongKeyFile = await environmentFile('wrong-key.env', targetPort, wrongKey);
  const unsafeFile = await environmentFile('writes-enabled.env', targetPort, key, true);
  assert.notEqual((await restoreCommand(backupDirectory, wrongKeyFile, true)).code, 0);
  await noTargetResources();
  assert.notEqual((await restoreCommand(backupDirectory, unsafeFile, true)).code, 0);
  await noTargetResources();
  const dump = await open(join(backupDirectory, 'database.dump'), 'r+');
  const firstByte = Buffer.alloc(1);
  await dump.read(firstByte, 0, 1, 0);
  try {
    await dump.write(Buffer.from([firstByte[0] ^ 255]), 0, 1, 0);
    assert.notEqual((await restoreCommand(backupDirectory, target.envFile, true)).code, 0);
    await noTargetResources();
  } finally {
    await dump.write(firstByte, 0, 1, 0);
    await dump.close();
  }
  assert.deepEqual(
    await digest(join(backupDirectory, 'database.dump')),
    manifest.files['database.dump'],
  );
  console.info('PASS: 错误主密钥、启用远程写入和损坏备份均在创建目标数据前被拒绝');

  await restoreCommand(backupDirectory);
  assert.deepEqual(await runningServices(target), ['postgres']);
  const restored = await checkRestored(fixture);
  assert.notEqual((await restoreCommand(backupDirectory, target.envFile, true)).code, 0);
  assert.deepEqual(await checkRestored(fixture), restored);
  console.info(
    'PASS: 空实例恢复后公众号及模型密钥可解密、会话撤销、图文与历史完整，旧投递和生成任务冻结；拒绝覆盖非空目标',
  );

  await compose(target, ['up', '-d', '--wait', '--wait-timeout', '180', 'api', 'web']);
  assert.deepEqual(await runningServices(target), ['api', 'postgres', 'web']);
  await (await http(target, '/auth/me', { cookie: sourceCookie, status: 401 })).arrayBuffer();
  const targetCookie = await login(target);
  const me = await (await http(target, '/auth/me', { cookie: targetCookie })).json();
  assert.equal(me.data.remoteWritesEnabled, false);
  const restoredModelsText = await (
    await http(target, '/ai/models', { cookie: targetCookie })
  ).text();
  assert.ok(!restoredModelsText.includes(aiSecret));
  const restoredModels = JSON.parse(restoredModelsText).data;
  assert.equal(restoredModels.text.model, 'recovery-text-fixture');
  assert.equal(restoredModels.text.hasApiKey, true);
  const current = (
    await (await http(target, '/articles/' + fixture.articleId, { cookie: targetCookie })).json()
  ).data;
  assert.equal(current.revisionId, articles.at(-1).revisionId);
  const history = (
    await (
      await http(target, '/articles/' + fixture.articleId + '/revisions?pageSize=100', {
        cookie: targetCookie,
      })
    ).json()
  ).data.items;
  assert.deepEqual(
    history
      .map(({ id, title, version }) => ({ id, title, version }))
      .sort((left, right) => left.version - right.version),
    fixture.revisions,
  );
  const restoredImage = Buffer.from(
    await (await http(target, '/assets/' + asset.id, { cookie: targetCookie })).arrayBuffer(),
  );
  assert.deepEqual(restoredImage, originalAsset);
  const disabled = await (
    await http(target, '/deliveries', {
      method: 'POST',
      cookie: targetCookie,
      json: { revisionId: articles.at(-1).revisionId, accountId: account.id, confirmed: true },
      status: 503,
    })
  ).json();
  assert.equal(disabled.error.code, 'REMOTE_WRITES_DISABLED');
  const records = (
    await (await http(target, '/deliveries?pageSize=100', { cookie: targetCookie })).json()
  ).data.items;
  assert.equal(records.length, 5);
  await compose(target, [
    'up',
    '-d',
    '--no-deps',
    '--force-recreate',
    '--wait',
    '--wait-timeout',
    '180',
    'api',
    'web',
  ]);
  assert.deepEqual(await runningServices(target), ['api', 'postgres', 'web']);
  assert.equal(
    (await (await http(target, '/auth/me', { cookie: targetCookie })).json()).data
      .remoteWritesEnabled,
    false,
  );
  assert.deepEqual(
    Buffer.from(
      await (await http(target, '/assets/' + asset.id, { cookie: targetCookie })).arrayBuffer(),
    ),
    originalAsset,
  );
  console.info('PASS: 旧会话失效、新登录与图片历史可读，恢复后投递被禁用，容器重建后数据仍保留');
} catch (error) {
  failure = error;
} finally {
  for (const stack of [target, source]) {
    if (!stack) continue;
    try {
      assert.match(stack.project, /^tattoo-p5-(src|dst)-[0-9a-f]{12}$/);
      assert.ok([sourceProject, targetProject].includes(stack.project));
      await compose(stack, ['down', '--volumes', '--remove-orphans', '--timeout', '45']);
    } catch (error) {
      cleanupErrors.push(redact(error.message));
    }
  }
  if (directory) {
    try {
      const resolved = await realpath(directory);
      const metadata = await lstat(directory);
      assert.equal(dirname(resolved), temporaryRoot);
      assert.ok(basename(resolved).startsWith('tattoo-p5-recovery-'));
      assert.ok(metadata.isDirectory() && !metadata.isSymbolicLink());
      await rm(resolved, { recursive: true });
    } catch (error) {
      cleanupErrors.push(redact(error.message));
    }
  }
}

if (failure) {
  console.error('P5 恢复验收失败：' + redact(failure.message));
  for (const error of cleanupErrors) console.error('额外清理错误：' + error);
  process.exitCode = 1;
} else if (cleanupErrors.length) {
  for (const error of cleanupErrors) console.error('P5 清理失败：' + error);
  process.exitCode = 1;
} else {
  console.info('PASS: P5 真实 Docker 备份恢复、禁止重放和持久化验收完成，隔离项目与临时文件已清理');
}
