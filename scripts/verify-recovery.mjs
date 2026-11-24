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
let imageRef;
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
  'TATTOO_IMAGE',
  'COOKIE_SECURE',
  'DATABASE_URL',
  'STORAGE_PATH',
  'NODE_ENV',
  'PORT',
  'WECHAT_API_BASE',
  'ALLOW_MOCK_WECHAT',
  'SOURCES_TEST_ORIGIN',
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
const searchSecret = 'p9-only-fake-' + randomBytes(24).toString('hex');
const secrets = [key, wrongKey, adminPassword, accountSecret, aiSecret, searchSecret];
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

function run(
  executable,
  args,
  { input, allowFailure = false, timeout = 300000, label, env = isolatedEnvironment } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: repository,
      env,
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
      'TATTOO_IMAGE=' + imageRef,
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

async function checkRestored(fixture, expectedSessions = 0) {
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
        assert.equal(await db.session.count(), ${expectedSessions});
        const account = await db.account.findUniqueOrThrow({ where: { id: fixture.accountId } });
        assert.equal(new SecretBox(process.env.APP_ENCRYPTION_KEY).decrypt(account.secretEncrypted), fixture.secret);
        const model = await db.aiModel.findUniqueOrThrow({ where: { capability: 'text' } });
        assert.equal(new SecretBox(process.env.APP_ENCRYPTION_KEY).decrypt(model.apiKeyEncrypted), fixture.aiSecret);
        assert.equal(model.protocol, 'anthropic-messages');
        assert.equal(model.anthropicMaxTokens, 8192);
        const searchConfig = await db.sourceSearchConfig.findUniqueOrThrow({ where: { id: 'default' } });
        assert.notEqual(searchConfig.apiKeyEncrypted, fixture.searchSecret);
        assert.equal(new SecretBox(process.env.APP_ENCRYPTION_KEY).decrypt(searchConfig.apiKeyEncrypted), fixture.searchSecret);
        assert.equal(searchConfig.baseUrl, 'https://api.tavily.com');
        assert.equal(searchConfig.version, fixture.searchVersion);
        const feed = await db.sourceFeed.findUniqueOrThrow({ where: { id: fixture.feed.id } });
        assert.equal(feed.url, fixture.feed.url);
        assert.equal(feed.title, fixture.feed.title);
        assert.equal(feed.lastFetchedAt.toISOString(), fixture.material.fetchedAt);
        assert.equal(feed.lastError, null);
        const material = await db.source.findUniqueOrThrow({ where: { id: fixture.material.id } });
        for (const field of ['url', 'resolvedUrl', 'title', 'text', 'contentKind', 'origin', 'contentHash', 'feedId', 'feedUrl'])
          assert.equal(material[field], fixture.material[field]);
        assert.equal(material.publishedAt.toISOString(), fixture.material.publishedAt);
        assert.equal(material.fetchedAt.toISOString(), fixture.material.fetchedAt);
        assert.equal(createHash('sha256').update(material.text).digest('hex'), material.contentHash);
        const sourceJobs = await db.sourceJob.findMany({ orderBy: { id: 'asc' } });
        assert.equal(sourceJobs.length, fixture.sourceJobs.length);
        for (const expected of fixture.sourceJobs) {
          const actual = sourceJobs.find((row) => row.id === expected.id);
          assert.ok(actual);
          assert.equal(actual.kind, 'SEARCH');
          assert.equal(actual.configVersion, fixture.searchVersion);
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
        const generationJobs = await db.generationJob.findMany({ where: { modelId: model.id, topicId: null } });
        assert.equal(generationJobs.length, fixture.generationJobs.length);
        for (const expected of fixture.generationJobs) {
          const actual = generationJobs.find((row) => row.id === expected.id);
          assert.ok(actual);
          assert.equal(actual.model, 'recovery-text-fixture');
          assert.equal(actual.protocol, 'anthropic-messages');
          assert.equal(actual.sourceText, fixture.referenceText);
          assert.deepEqual(actual.sourceReferences, fixture.sourceReferences);
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
        const imageModel = await db.aiModel.findUniqueOrThrow({ where: { capability: 'image' } });
        assert.equal(new SecretBox(process.env.APP_ENCRYPTION_KEY).decrypt(imageModel.apiKeyEncrypted), fixture.aiSecret);
        const topicTasks = await db.topicCreation.findMany({ orderBy: { id: 'asc' } });
        assert.equal(topicTasks.length, fixture.topicTasks.length);
        for (const expected of fixture.topicTasks) {
          const actual = topicTasks.find((row) => row.id === expected.id);
          assert.ok(actual);
          for (const field of ['requestKey', 'topic', 'stage', 'articleJobId', 'coverJobId', 'coverRequestKey', 'articleId'])
            assert.equal(actual[field], expected[field]);
          assert.equal(actual.textModelId, model.id);
          assert.equal(actual.imageModelId, imageModel.id);
          const articleJob = await db.generationJob.findUniqueOrThrow({ where: { id: actual.articleJobId } });
          assert.equal(articleJob.topicId, actual.id);
          assert.equal(articleJob.state, 'SUCCEEDED');
          assert.deepEqual(articleJob.result, fixture.generationJobs.at(-1).result);
          const coverJob = await db.generationJob.findUniqueOrThrow({ where: { id: actual.coverJobId } });
          assert.equal(coverJob.topicId, actual.id);
          assert.equal(coverJob.state, ['QUEUED', 'RUNNING'].includes(expected.state) ? 'UNCERTAIN' : expected.state);
          if (expected.state === 'SUCCEEDED')
            assert.deepEqual(coverJob.result, { type: 'image', asset: fixture.generatedCover });
          if (['QUEUED', 'RUNNING'].includes(expected.state)) {
            assert.equal(actual.state, 'UNCERTAIN');
            assert.match(actual.error, /恢复/);
          } else {
            assert.equal(actual.state, expected.state);
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
        console.log(JSON.stringify({ article: article.id, revisions: article.revisions.map(({ id, title, version }) => ({ id, title, version })), asset: { id: asset.id, sha256: createHash('sha256').update(bytes).digest('hex') }, mappings, deliveries: deliveries.map(({ id, state, stage, remoteId, executionId, events, attempts }) => ({ id, state, stage, remoteId, executionId, events, attempts })), generationJobs: generationJobs.map(({ id, state, model, sourceText, sourceReferences }) => ({ id, state, model, sourceText, sourceReferences })), topicTasks: topicTasks.map(({ id, state, stage, articleJobId, coverJobId, articleId }) => ({ id, state, stage, articleJobId, coverJobId, articleId })), material: { id: material.id, text: material.text, hash: material.contentHash, feedId: material.feedId }, feed: { id: feed.id, url: feed.url, title: feed.title }, searchConfig: { version: searchConfig.version, baseUrl: searchConfig.baseUrl }, sourceJobs: sourceJobs.map(({ id, state, result }) => ({ id, state, result })) }));
      } finally { await db.$disconnect(); }
    `,
  );
  return JSON.parse(result.stdout);
}

try {
  console.info('本验收要求 Docker 发布端口可由当前管理机通过 127.0.0.1 访问。');
  const resolved = await run(
    'docker',
    [
      'compose',
      '--file',
      join(repository, 'compose.yaml'),
      '--file',
      join(repository, 'compose.build.yaml'),
      'config',
      '--images',
    ],
    {
      env: {
        ...isolatedEnvironment,
        ...(process.env.TATTOO_VERSION ? { TATTOO_VERSION: process.env.TATTOO_VERSION } : {}),
        ...(process.env.TATTOO_IMAGE ? { TATTOO_IMAGE: process.env.TATTOO_IMAGE } : {}),
      },
      label: '解析源码构建镜像引用',
    },
  );
  const applications = [
    ...new Set(
      resolved.stdout.split(/\r?\n/).filter((image) => image && image !== 'postgres:16-alpine'),
    ),
  ];
  assert.equal(applications.length, 1, 'API 与 Worker 必须使用同一个应用镜像');
  imageRef = applications[0];
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
    ['image', 'inspect', imageRef, '--format', '{{.Os}}/{{.Architecture}} {{.Id}}'],
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
  assert.deepEqual(await runningServices(source), ['api', 'postgres', 'worker']);
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
  // Model/search calls are independent of the WeChat write switch. Stop this
  // owned Worker before seeding tasks so no real model or search service is used.
  await compose(source, ['stop', '--timeout', '45', 'worker']);
  await http(source, '/ai/models/text', {
    method: 'PUT',
    cookie: sourceCookie,
    json: {
      protocol: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'recovery-text-fixture',
      anthropicMaxTokens: 8192,
      apiKey: aiSecret,
    },
  });
  await http(source, '/ai/models/image', {
    method: 'PUT',
    cookie: sourceCookie,
    json: {
      protocol: 'images-generations',
      baseUrl: 'https://api.openai.com/v1',
      model: 'recovery-image-fixture',
      apiKey: aiSecret,
    },
  });
  const searchConfig = (
    await (
      await http(source, '/sources/search-config', {
        method: 'PUT',
        cookie: sourceCookie,
        json: { baseUrl: 'https://api.tavily.com', apiKey: searchSecret },
      })
    ).json()
  ).data;
  const feed = (
    await (
      await http(source, '/sources/feeds', {
        method: 'POST',
        status: 201,
        cookie: sourceCookie,
        json: { url: 'https://example.com/p9-recovery/feed.xml', title: 'P9 恢复资料订阅' },
      })
    ).json()
  ).data;
  const materialText = '恢复前采集的公开资料正文。\n\n来源和完整文字应在恢复与重建后保持一致。';
  const material = {
    id: randomUUID(),
    url: 'https://example.com/p9-recovery/article',
    resolvedUrl: 'https://example.com/p9-recovery/final',
    title: 'P9 恢复资料正文',
    text: materialText,
    contentHash: createHash('sha256').update(materialText).digest('hex'),
    contentKind: 'article',
    origin: 'rss',
    feedId: feed.id,
    feedUrl: feed.url,
    publishedAt: '2026-11-23T00:00:00.000Z',
    fetchedAt: new Date().toISOString(),
  };
  const sourceReferences = [
    {
      id: material.id,
      title: material.title,
      url: material.url,
      contentHash: material.contentHash,
      fetchedAt: material.fetchedAt,
    },
  ];
  const referenceText =
    '参考资料：' + material.title + '\n来源：' + material.url + '\n\n' + material.text;
  const sourceJobs = ['QUEUED', 'RUNNING', 'UNCERTAIN', 'FAILED', 'SUCCEEDED'].map((state) => ({
    id: randomUUID(),
    state,
    result:
      state === 'SUCCEEDED'
        ? {
            sourceIds: [material.id],
            items: [
              {
                title: '恢复前的搜索候选',
                url: 'https://example.com/p9-recovery/candidate',
                snippet: '这是一份恢复前的搜索摘要。',
              },
            ],
            created: 0,
            updated: 0,
          }
        : null,
  }));
  const generationJobs = ['QUEUED', 'RUNNING', 'UNCERTAIN', 'FAILED', 'SUCCEEDED'].map((state) => ({
    id: randomUUID(),
    state,
    result:
      state === 'SUCCEEDED'
        ? {
            type: 'article',
            title: '恢复前的生成结果',
            digest: '资料快照恢复验证',
            document: {
              type: 'doc',
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: '恢复前的生成正文。' }] },
              ],
            },
          }
        : null,
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
  const topicTasks = ['QUEUED', 'RUNNING', 'UNCERTAIN', 'FAILED', 'SUCCEEDED'].map((state) => ({
    id: randomUUID(),
    requestKey: randomUUID(),
    topic: '主题恢复验收：文章已生成，不得恢复后自动调用封面模型',
    state,
    stage: state === 'SUCCEEDED' ? 'DONE' : 'COVER',
    articleJobId: randomUUID(),
    coverJobId: randomUUID(),
    coverRequestKey: randomUUID(),
    articleId: state === 'SUCCEEDED' ? articles[0].id : null,
  }));
  const fixture = {
    accountId: account.id,
    secret: accountSecret,
    aiSecret,
    searchSecret,
    searchVersion: searchConfig.version,
    feed: { id: feed.id, url: feed.url, title: feed.title },
    material,
    sourceReferences,
    referenceText,
    sourceJobs,
    generationJobs,
    topicTasks,
    articleId: articles[0].id,
    assetId: asset.id,
    generatedCover: asset,
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
      import { createHash, randomUUID } from 'node:crypto';
      import { PrismaClient } from '@prisma/client';
      import { RENDER_VERSION } from './apps/server/dist/platforms/wechat/renderer.js';
      const fixture = ${JSON.stringify(fixture)};
      const db = new PrismaClient();
      try {
        await db.sourceFeed.update({ where: { id: fixture.feed.id }, data: { lastFetchedAt: new Date(fixture.material.fetchedAt), lastError: null } });
        await db.source.create({ data: {
          ...fixture.material,
          urlHash: createHash('sha256').update(fixture.material.url).digest('hex'),
          publishedAt: new Date(fixture.material.publishedAt),
          fetchedAt: new Date(fixture.material.fetchedAt),
        } });
        const searchConfig = await db.sourceSearchConfig.findUniqueOrThrow({ where: { id: 'default' } });
        if (searchConfig.version !== fixture.searchVersion) throw new Error('search config fixture changed');
        for (const row of fixture.sourceJobs) {
          await db.sourceJob.create({ data: {
            id: row.id, requestKey: randomUUID(), kind: 'SEARCH', state: row.state,
            query: '恢复验收，仅准备旧搜索任务，不向服务发出请求', origin: 'search',
            configVersion: searchConfig.version, inputHash: 'p9-recovery-fixture',
            executionId: row.state === 'RUNNING' ? randomUUID() : null,
            heartbeatAt: row.state === 'RUNNING' ? new Date() : null,
            completedAt: ['UNCERTAIN', 'FAILED', 'SUCCEEDED'].includes(row.state) ? new Date() : null,
            ...(row.result ? { result: row.result } : {}),
          } });
        }
        const model = await db.aiModel.findUniqueOrThrow({ where: { capability: 'text' } });
        const imageModel = await db.aiModel.findUniqueOrThrow({ where: { capability: 'image' } });
        for (const row of fixture.generationJobs) {
          await db.generationJob.create({ data: {
            id: row.id, requestKey: randomUUID(), kind: 'ARTICLE', capability: 'text',
              modelId: model.id, model: model.model, protocol: model.protocol, configVersion: model.version,
            inputHash: 'recovery-fixture', prompt: '恢复验收，仅准备旧任务，不发出模型请求',
            sourceText: fixture.referenceText, sourceReferences: fixture.sourceReferences,
            state: row.state,
            executionId: row.state === 'RUNNING' ? randomUUID() : null,
            heartbeatAt: row.state === 'RUNNING' ? new Date() : null,
            completedAt: ['UNCERTAIN', 'FAILED', 'SUCCEEDED'].includes(row.state) ? new Date() : null,
            ...(row.result ? { result: row.result } : {}),
          } });
        }
        for (const row of fixture.topicTasks) {
          await db.topicCreation.create({ data: {
            ...row,
            textModelId: model.id, textConfigVersion: model.version,
            imageModelId: imageModel.id, imageConfigVersion: imageModel.version,
            completedAt: ['UNCERTAIN', 'FAILED', 'SUCCEEDED'].includes(row.state) ? new Date() : null,
          } });
          await db.generationJob.create({ data: {
            id: row.articleJobId, requestKey: randomUUID(), topicId: row.id,
            kind: 'ARTICLE', capability: 'text', modelId: model.id, model: model.model,
            protocol: model.protocol, configVersion: model.version,
            inputHash: 'topic-recovery-article', prompt: row.topic,
            state: 'SUCCEEDED', result: fixture.generationJobs.at(-1).result, completedAt: new Date(),
          } });
          await db.generationJob.create({ data: {
            id: row.coverJobId, requestKey: row.coverRequestKey, topicId: row.id,
            kind: 'COVER', capability: 'image', modelId: imageModel.id, model: imageModel.model,
            protocol: imageModel.protocol, configVersion: imageModel.version,
            inputHash: 'topic-recovery-cover', prompt: row.topic,
            state: row.state,
            executionId: row.state === 'RUNNING' ? randomUUID() : null,
            heartbeatAt: row.state === 'RUNNING' ? new Date() : null,
            completedAt: ['UNCERTAIN', 'FAILED', 'SUCCEEDED'].includes(row.state) ? new Date() : null,
            ...(row.state === 'SUCCEEDED' ? { result: { type: 'image', asset: fixture.generatedCover } } : {}),
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
    'PASS: 真实 HTTP 创建账号、图片、6 份修订、模型与搜索配置和订阅；停止 Worker 后准备资料、快照及五种投递/生成/搜索/主题状态，无真实服务调用',
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
  assert.equal(manifest.application.imageRef, imageRef);
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
    'PASS: 空实例恢复后公众号、模型及搜索密钥可解密，会话撤销，图文/资料/订阅/快照完整，旧投递、生成、搜索和主题任务冻结；拒绝覆盖非空目标',
  );

  await compose(target, ['up', '-d', '--wait', '--wait-timeout', '180', 'api']);
  assert.deepEqual(await runningServices(target), ['api', 'postgres']);
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
  assert.equal(restoredModels.text.protocol, 'anthropic-messages');
  assert.equal(restoredModels.text.anthropicMaxTokens, 8192);
  const restoredSearchText = await (
    await http(target, '/sources/search-config', { cookie: targetCookie })
  ).text();
  assert.ok(!restoredSearchText.includes(searchSecret));
  const restoredSearch = JSON.parse(restoredSearchText).data;
  assert.equal(restoredSearch.baseUrl, 'https://api.tavily.com');
  assert.equal(restoredSearch.hasApiKey, true);
  assert.equal(restoredSearch.version, fixture.searchVersion);
  assert.equal(Object.hasOwn(restoredSearch, 'apiKeyEncrypted'), false);
  assert.equal(Object.hasOwn(restoredSearch, 'apiKey'), false);
  const restoredMaterial = (
    await (await http(target, '/sources/' + fixture.material.id, { cookie: targetCookie })).json()
  ).data;
  assert.equal(restoredMaterial.text, fixture.material.text);
  assert.equal(restoredMaterial.contentHash, fixture.material.contentHash);
  assert.equal(restoredMaterial.feedId, fixture.feed.id);
  assert.equal(restoredMaterial.feedUrl, fixture.feed.url);
  const restoredFeeds = (
    await (await http(target, '/sources/feeds', { cookie: targetCookie })).json()
  ).data;
  assert.ok(
    restoredFeeds.items.some((row) => row.id === fixture.feed.id && row.url === fixture.feed.url),
  );
  const restoredJob = (
    await (
      await http(target, '/ai/jobs/' + fixture.generationJobs.at(-1).id, { cookie: targetCookie })
    ).json()
  ).data;
  assert.equal(restoredJob.sourceText, fixture.referenceText);
  assert.deepEqual(restoredJob.sourceReferences, fixture.sourceReferences);
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
  ]);
  assert.deepEqual(await runningServices(target), ['api', 'postgres']);
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
  assert.deepEqual(await checkRestored(fixture, 1), restored);
  console.info(
    'PASS: 旧会话失效，新登录可读图片、资料、订阅和快照；恢复后投递被禁用，容器重建后全部数据仍保留',
  );
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
