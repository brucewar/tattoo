import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const commandTimeout = 30 * 60 * 1000;
const schemaVersion = 1;
const filenames = ['database.dump', 'assets.tar'];
const hashPattern = /^[0-9a-f]{64}$/;
const imagePattern = /^sha256:[0-9a-f]{64}$/;

export class BackupError extends Error {}

export function cliOptions(action, args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      input: { type: 'string' },
      output: { type: 'string' },
      project: { type: 'string' },
      'env-file': { type: 'string' },
      'compose-file': { type: 'string', multiple: true },
      help: { type: 'boolean' },
    },
  });
  if (values.help) {
    console.info(
      action === 'backup'
        ? 'node scripts/backup.mjs --output <新目录> [--project tattoo] [--env-file .env] [--compose-file <文件> ...]'
        : 'node scripts/restore.mjs --input <备份目录> --project <目标项目> --env-file <恢复配置> [--compose-file <文件> ...]',
    );
    return null;
  }
  if (action === 'backup' && (!values.output || values.input))
    throw new BackupError('备份必须指定 --output 新目录，不能指定 --input');
  if (
    action === 'restore' &&
    (!values.input || !values.project || !values['env-file'] || values.output)
  )
    throw new BackupError('恢复必须显式指定 --input、--project 和 --env-file');
  const project = values.project ?? 'tattoo';
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project))
    throw new BackupError('Compose 项目名须为小写字母、数字、下划线或短横线');
  return {
    project,
    envFile: resolve(values['env-file'] ?? '.env'),
    directory: resolve(action === 'backup' ? values.output : values.input),
    composeFiles: (values['compose-file'] ?? [join(repository, 'compose.yaml')]).map((file) =>
      resolve(file),
    ),
  };
}

export function reportFailure(error) {
  console.error(
    error instanceof BackupError ? error.message : '备份/恢复失败，请检查 Docker、配置和磁盘空间',
  );
  process.exitCode = 1;
}

/** All child output is private by default: compose config and SQL can contain secrets. */
function execute(args, { input, output, limit = 2_000_000, timeout = commandTimeout } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', args, {
      cwd: repository,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const chunks = [];
    let bytes = 0;
    let failed;
    const timer = setTimeout(() => {
      failed = new BackupError('Docker 操作超时，服务保持停止；请检查本次目标与遗留容器');
      child.kill('SIGKILL');
    }, timeout);
    child.stderr.resume();
    const sending = input
      ? pipeline(input, child.stdin).catch((error) => {
          failed ??= error;
        })
      : (child.stdin.end(), Promise.resolve());
    const receiving = output
      ? pipeline(child.stdout, output).catch((error) => {
          failed ??= error;
          child.kill('SIGKILL');
        })
      : new Promise((done) => {
          child.stdout.on('data', (chunk) => {
            bytes += chunk.length;
            if (bytes > limit) {
              failed = new BackupError('Docker 元信息响应过大');
              child.kill('SIGKILL');
            } else chunks.push(chunk);
          });
          child.stdout.once('end', done);
          child.stdout.once('close', done);
          child.stdout.once('error', (error) => {
            failed ??= error;
            done();
          });
        });
    child.once('error', () => {
      failed = new BackupError('无法运行 Docker，请确认 Docker CLI 和 Compose 可用');
    });
    child.once('close', async (code) => {
      clearTimeout(timer);
      await Promise.all([sending, receiving]);
      if (failed || code !== 0)
        reject(
          failed instanceof BackupError
            ? failed
            : new BackupError('Docker 操作失败，服务保持停止；请检查配置、镜像与磁盘空间'),
        );
      else resolvePromise(Buffer.concat(chunks).toString('utf8').trim());
    });
  });
}

function controller(options) {
  const prefix = [
    'compose',
    '--project-name',
    options.project,
    '--env-file',
    options.envFile,
    ...(options.composeFiles ?? [join(repository, 'compose.yaml')]).flatMap((file) => [
      '--file',
      file,
    ]),
  ];
  const compose = (args, io) => execute([...prefix, ...args], io);
  const node = (script) =>
    compose(
      ['run', '--rm', '--no-deps', '-T', '--entrypoint', 'node', 'api', '--input-type=module'],
      {
        input: (async function* () {
          yield script;
        })(),
      },
    );
  return { compose, node };
}

function decodeJson(value, message) {
  try {
    return JSON.parse(value);
  } catch {
    throw new BackupError(message);
  }
}

export function keyFingerprint(encoded) {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encoded))
    throw new BackupError('APP_ENCRYPTION_KEY 必须为 base64 编码的 32 字节密钥');
  return createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('hex');
}

export function validateRestoreEnv(content) {
  const message = '恢复配置文件必须持久设置 REMOTE_WRITES_ENABLED=false，不能依赖 shell 覆盖';
  let environment;
  try {
    environment = parseEnv(content);
  } catch {
    throw new BackupError(message);
  }
  if (environment.REMOTE_WRITES_ENABLED !== 'false') throw new BackupError(message);
  const assignments = [
    ...content.matchAll(/^\s*(?:export\s+)?REMOTE_WRITES_ENABLED\s*=([^\r\n]*)/gm),
  ];
  if (
    !assignments.length ||
    assignments.some((entry) => !/^(?:false|"false"|'false')\s*(?:#.*)?$/.test(entry[1].trim()))
  )
    throw new BackupError(message);
}

async function configuration(control, restoring) {
  const config = decodeJson(
    await control.compose(['config', '--format', 'json']),
    'Compose 配置无效',
  );
  const environment = config.services?.api?.environment;
  const fingerprint = keyFingerprint(environment?.APP_ENCRYPTION_KEY);
  if (restoring && String(environment?.REMOTE_WRITES_ENABLED) !== 'false')
    throw new BackupError('恢复配置必须明确禁用远程写入：REMOTE_WRITES_ENABLED=false');
  const imageRef = config.services?.api?.image;
  if (typeof imageRef !== 'string' || !imageRef || /[\r\n]/.test(imageRef))
    throw new BackupError('配置中缺少应用镜像');
  const imageId = await execute(['image', 'inspect', imageRef, '--format', '{{.Id}}']);
  if (!imagePattern.test(imageId)) throw new BackupError('无法核验应用镜像 ID');
  return { fingerprint, imageRef, imageId };
}

async function applicationsStopped(control, expectedImageId) {
  const raw = await control.compose(['ps', '--all', '--format', 'json']);
  const rows = raw
    ? raw.startsWith('[')
      ? decodeJson(raw, '容器状态无效')
      : raw.split('\n').map((line) => decodeJson(line, '容器状态无效'))
    : [];
  if (
    rows.some(
      (row) =>
        ['api', 'worker', 'web'].includes(row.Service) &&
        !['exited', 'created', 'dead'].includes(row.State),
    )
  )
    throw new BackupError(
      '请先停止目标项目的 api 和 worker（升级前的 web 也须停止），再恢复或重试',
    );
  if (expectedImageId) {
    for (const row of rows.filter((row) => ['api', 'worker'].includes(row.Service))) {
      if (!/^[a-f0-9]{12,64}$/.test(row.ID ?? '')) throw new BackupError('无法核验已部署应用容器');
      const actual = await execute([
        'inspect',
        '--type',
        'container',
        '--format',
        '{{.Image}}',
        row.ID,
      ]);
      if (actual !== expectedImageId)
        throw new BackupError('已部署容器与配置镜像不一致，请使用当前部署版本执行备份');
    }
  }
}

async function postgresVersion(control) {
  const version = await control.compose([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'tattoo',
    '-d',
    'tattoo',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    'SHOW server_version_num',
  ]);
  if (!/^16\d{4}$/.test(version)) throw new BackupError('备份/恢复当前仅支持 PostgreSQL 16');
  return version;
}

export async function fileDigest(path) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink())
    throw new BackupError('备份文件必须是普通文件，不能是链接');
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest('hex') };
}

function tarNumber(buffer) {
  const text = buffer.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]+$/.test(text)) throw new BackupError('素材归档包含无效数值');
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new BackupError('素材归档条目大小无效');
  return value;
}

function tarString(buffer) {
  const terminator = buffer.indexOf(0);
  const value = buffer.subarray(0, terminator === -1 ? buffer.length : terminator);
  return new TextDecoder('utf8', { fatal: true }).decode(value);
}

export function safeArchivePath(name, directory = false) {
  if (!name || /[\\:\x00-\x1f\x7f]/.test(name) || isAbsolute(name) || name.startsWith('/'))
    throw new BackupError('素材归档包含不安全路径');
  const parts = name.replace(/\/$/, '').split('/');
  if (parts.some((part) => part === '..' || part === ''))
    throw new BackupError('素材归档包含不安全路径');
  const normalized = parts.filter((part) => part !== '.').join('/');
  if (!normalized && !directory) throw new BackupError('素材归档文件名无效');
  return normalized;
}

/** Validate only strict ustar regular files/directories; never trust tar's own path cleanup. */
export async function validateAssetArchive(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1024 || info.size % 512 !== 0)
    throw new BackupError('素材归档不是完整的 ustar 文件');
  const file = await open(path, 'r');
  const names = new Map();
  let offset = 0;
  let zeroBlocks = 0;
  const header = Buffer.alloc(512);
  try {
    while (offset < info.size) {
      const result = await file.read(header, 0, 512, offset);
      if (result.bytesRead !== 512) throw new BackupError('素材归档已截断');
      offset += 512;
      if (header.every((byte) => byte === 0)) {
        zeroBlocks++;
        continue;
      }
      if (zeroBlocks) throw new BackupError('素材归档在结束标记之后包含数据');
      if (
        header.subarray(257, 263).toString('ascii') !== 'ustar\0' ||
        header.subarray(263, 265).toString('ascii') !== '00'
      )
        throw new BackupError('素材归档仅允许标准 ustar 格式');
      const expected = tarNumber(header.subarray(148, 156));
      let checksum = 0;
      for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
      if (checksum !== expected) throw new BackupError('素材归档头校验失败');
      const type = String.fromCharCode(header[156]);
      if (!['0', '\0', '5'].includes(type) || tarString(header.subarray(157, 257)))
        throw new BackupError('素材归档不允许链接或特殊文件');
      const prefix = tarString(header.subarray(345, 500));
      const name = `${prefix ? `${prefix}/` : ''}${tarString(header.subarray(0, 100))}`;
      const normalized = safeArchivePath(name, type === '5');
      if (names.has(normalized)) throw new BackupError('素材归档包含重复路径');
      names.set(normalized, type === '5' ? 'directory' : 'file');
      const size = tarNumber(header.subarray(124, 136));
      if (type === '5' && size) throw new BackupError('素材归档目录大小无效');
      offset += Math.ceil(size / 512) * 512;
      if (offset > info.size) throw new BackupError('素材归档内容已截断');
    }
    if (zeroBlocks < 2) throw new BackupError('素材归档缺少完整结束标记');
    for (const name of names.keys()) {
      let ancestor = dirname(name).replaceAll('\\', '/');
      while (ancestor !== '.' && ancestor !== '/') {
        if (names.get(ancestor) === 'file') throw new BackupError('素材归档包含文件/目录路径冲突');
        ancestor = dirname(ancestor).replaceAll('\\', '/');
      }
    }
    return names.size;
  } finally {
    await file.close();
  }
}

export function validateManifest(value) {
  if (
    !value ||
    value.schemaVersion !== schemaVersion ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !hashPattern.test(value.keyFingerprint ?? '') ||
    !imagePattern.test(value.application?.imageId ?? '') ||
    typeof value.application?.imageRef !== 'string' ||
    !/^16\d{4}$/.test(String(value.postgresVersion))
  )
    throw new BackupError('备份 manifest 格式或版本无效');
  if (!value.files || Object.keys(value.files).sort().join(',') !== [...filenames].sort().join(','))
    throw new BackupError('备份文件清单无效');
  for (const name of filenames) {
    const file = value.files[name];
    if (
      !file ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes <= 0 ||
      !hashPattern.test(file.sha256 ?? '')
    )
      throw new BackupError('备份文件摘要无效');
  }
  return value;
}

export async function verifyBackup(directory) {
  if (!(await lstat(directory)).isDirectory()) throw new BackupError('备份输入必须是目录');
  const manifestFile = join(directory, 'manifest.json');
  const metadata = await lstat(manifestFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 65536)
    throw new BackupError('备份 manifest 必须是普通小文件');
  const manifest = validateManifest(
    decodeJson(await readFile(manifestFile, 'utf8'), '备份 manifest 无法解析'),
  );
  for (const name of filenames) {
    const actual = await fileDigest(join(directory, name));
    if (
      actual.bytes !== manifest.files[name].bytes ||
      actual.sha256 !== manifest.files[name].sha256
    )
      throw new BackupError('备份文件大小或 SHA256 不匹配，拒绝恢复');
  }
  await validateAssetArchive(join(directory, 'assets.tar'));
  return manifest;
}

const accountCheck = `
  import { Client } from 'pg';
  import { SecretBox } from './apps/server/dist/security.js';
  const db = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000, query_timeout: 15000 });
  await db.connect();
  try {
    const box = new SecretBox(process.env.APP_ENCRYPTION_KEY);
    const result = await db.query('SELECT "secretEncrypted", "tokenEncrypted" FROM "Account"');
    for (const row of result.rows) {
      box.decrypt(row.secretEncrypted);
      if (row.tokenEncrypted) box.decrypt(row.tokenEncrypted);
    }
    const models = await db.query('SELECT "apiKeyEncrypted" FROM "AiModel"');
    for (const row of models.rows) if (row.apiKeyEncrypted) box.decrypt(row.apiKeyEncrypted);
    const searches = await db.query('SELECT "apiKeyEncrypted" FROM "SourceSearchConfig"');
    for (const row of searches.rows) if (row.apiKeyEncrypted) box.decrypt(row.apiKeyEncrypted);
    const users = await db.query('SELECT id, "totpSecretEncrypted", "pendingTotpEncrypted" FROM "User"');
    for (const row of users.rows) {
      const prefix = 'tattoo:totp:v1:' + row.id + ':';
      for (const encrypted of [row.totpSecretEncrypted, row.pendingTotpEncrypted]) {
        if (!encrypted) continue;
        const plaintext = box.decrypt(encrypted);
        if (!plaintext.startsWith(prefix) || !/^[A-Z2-7]{52}$/.test(plaintext.slice(prefix.length)))
          throw new Error('ACCOUNT_AUTH_KEY_INVALID');
      }
    }
    console.log('ACCOUNT_KEYS_OK');
  } finally { await db.end(); }
`;

export async function backup(options) {
  const control = controller(options);
  const config = await configuration(control, false);
  // Exclusive creation reserves the output and never overwrites an older backup.
  try {
    await mkdir(options.directory, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') throw new BackupError('输出目录已存在，拒绝覆盖已有备份');
    throw error;
  }
  console.info('正在停止应用写入；备份完成后应用保持停止，需要显式重新启动。');
  await control.compose(['stop', '--timeout', '45', 'api', 'worker']);
  await applicationsStopped(control, config.imageId);
  const version = await postgresVersion(control);
  await control.node(accountCheck);
  await control.compose(
    [
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '-U',
      'tattoo',
      '-d',
      'tattoo',
      '--format=custom',
      '--no-owner',
      '--no-acl',
    ],
    {
      output: createWriteStream(join(options.directory, 'database.dump'), {
        flags: 'wx',
        mode: 0o600,
      }),
    },
  );
  await control.compose(
    [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'tar',
      'api',
      '--format=ustar',
      '--hard-dereference',
      '--sort=name',
      '-cf',
      '-',
      '-C',
      '/data/assets',
      '.',
    ],
    {
      output: createWriteStream(join(options.directory, 'assets.tar'), {
        flags: 'wx',
        mode: 0o600,
      }),
    },
  );
  await validateAssetArchive(join(options.directory, 'assets.tar'));
  const files = {};
  for (const name of filenames) files[name] = await fileDigest(join(options.directory, name));
  const manifest = {
    schemaVersion,
    createdAt: new Date().toISOString(),
    application: { imageRef: config.imageRef, imageId: config.imageId },
    postgresVersion: version,
    keyFingerprint: config.fingerprint,
    files,
  };
  await writeFile(
    join(options.directory, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.info('备份已完成并校验。主密钥、部署配置和对应版本镜像须单独保管；应用仍停止。');
  return manifest;
}

export const restoredTasksSql = `
  BEGIN;
  DELETE FROM "Session";
  DELETE FROM "LoginChallenge";
  DELETE FROM "RecoveryCode";
  UPDATE "User" SET "securityVersion"="securityVersion"+1,
    "pendingTotpEncrypted"=NULL, "pendingTotpExpiresAt"=NULL,
    "pendingTotpSessionHash"=NULL, "pendingTotpSetupId"=NULL,
    "factorFailureCount"=0, "factorFailureStartedAt"=NULL, "factorBlockedUntil"=NULL,
    "totpLastStep"=CASE WHEN "totpSecretEncrypted" IS NULL THEN NULL
      ELSE GREATEST(COALESCE("totpLastStep",0), FLOOR(EXTRACT(EPOCH FROM clock_timestamp())/30)::integer) END;
  WITH affected AS (
    UPDATE "Delivery" SET state='UNCERTAIN', stage='备份恢复，投递结果待核对',
      error='备份之后原实例可能已执行此任务，请先停止原实例 Worker 并核对微信后台',
      "executionId"=NULL, "heartbeatAt"=NULL, "completedAt"=CURRENT_TIMESTAMP, "updatedAt"=CURRENT_TIMESTAMP
    WHERE state IN ('QUEUED', 'RUNNING') RETURNING id
  ), attempts AS (
    UPDATE "DeliveryAttempt" SET state='UNCERTAIN', stage='备份恢复，投递结果待核对',
      error='恢复后禁止自动重发，请人工核对', "completedAt"=CURRENT_TIMESTAMP
    WHERE "deliveryId" IN (SELECT id FROM affected) AND state='RUNNING'
  )
  INSERT INTO "DeliveryEvent" (id, "deliveryId", actor, message, "createdAt")
    SELECT gen_random_uuid(), id, 'restore', '恢复备份后暂停旧任务；须停止原实例 Worker 并人工核对，再显式重试', CURRENT_TIMESTAMP FROM affected;
  UPDATE "GenerationJob" SET state='UNCERTAIN',
    error='备份恢复后已暂停旧生成任务；原实例可能已调用模型，请核对结果后显式重新生成',
    "executionId"=NULL, "heartbeatAt"=NULL, "completedAt"=CURRENT_TIMESTAMP, "updatedAt"=CURRENT_TIMESTAMP
    WHERE state IN ('QUEUED', 'RUNNING');
  UPDATE "SourceJob" SET state='UNCERTAIN',
    error='备份恢复后已暂停旧资料任务；搜索服务可能已计费，请核对后显式重新获取',
    "executionId"=NULL, "heartbeatAt"=NULL, "completedAt"=CURRENT_TIMESTAMP, "updatedAt"=CURRENT_TIMESTAMP
      WHERE state IN ('QUEUED', 'RUNNING');
  UPDATE "TopicCreation" SET state='UNCERTAIN',
    error='备份恢复后已暂停旧主题任务；原实例可能已调用模型，请核对结果后显式重试',
    "completedAt"=CURRENT_TIMESTAMP, "updatedAt"=CURRENT_TIMESTAMP
      WHERE state IN ('QUEUED', 'RUNNING');
  COMMIT;
`;

export async function restore(options) {
  const manifest = await verifyBackup(options.directory);
  validateRestoreEnv(await readFile(options.envFile, 'utf8'));
  const control = controller(options);
  const config = await configuration(control, true);
  if (config.fingerprint !== manifest.keyFingerprint)
    throw new BackupError('恢复主密钥与备份不匹配，请使用单独保存的原主密钥');
  if (config.imageId !== manifest.application.imageId)
    throw new BackupError('恢复必须使用备份对应的应用镜像；请先加载或选择该版本镜像');
  await applicationsStopped(control);
  await control.compose(['up', '-d', '--wait', '--wait-timeout', '150', 'postgres']);
  await postgresVersion(control);
  const objects = await control.compose([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'tattoo',
    '-d',
    'tattoo',
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `SELECT
    (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_') +
      (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') +
      (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public') +
    (SELECT count(*) FROM pg_namespace WHERE nspname NOT IN ('public','pg_catalog','information_schema') AND nspname !~ '^pg_')`,
  ]);
  if (objects !== '0')
    throw new BackupError('目标数据库不是空实例，拒绝覆盖；请使用新的 Compose 项目与数据卷');
  await control.node(
    `import { readdir } from 'node:fs/promises'; if ((await readdir('/data/assets')).length) throw new Error('target assets not empty'); console.log('ASSETS_EMPTY');`,
  );
  console.info('备份、密钥、镜像与空目标已核验；正在恢复，API 和 Worker 将保持停止。');
  await control.compose(
    [
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '-U',
      'tattoo',
      '-d',
      'tattoo',
      '--no-owner',
      '--no-acl',
      '--exit-on-error',
      '--single-transaction',
    ],
    { input: createReadStream(join(options.directory, 'database.dump')) },
  );
  // Validate decrypted credentials before making the instance usable. Never print plaintext.
  await control.node(accountCheck);
  await control.compose(
    ['exec', '-T', 'postgres', 'psql', '-U', 'tattoo', '-d', 'tattoo', '-v', 'ON_ERROR_STOP=1'],
    {
      input: (async function* () {
        yield restoredTasksSql;
      })(),
    },
  );
  await control.compose(
    [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      '--entrypoint',
      'tar',
      'api',
      '--extract',
      '--file=-',
      '--directory=/data/assets',
      '--keep-old-files',
      '--no-same-owner',
      '--no-same-permissions',
    ],
    { input: createReadStream(join(options.directory, 'assets.tar')) },
  );
  console.info(
    '恢复完成：旧会话已撤销，旧排队/执行中任务已转为待核对。远程写入禁用，API/Worker 未启动。',
  );
  return manifest;
}
