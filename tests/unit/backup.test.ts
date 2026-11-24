import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cliOptions,
  fileDigest,
  keyFingerprint,
  validateAssetArchive,
  validateManifest,
  validateRestoreEnv,
  verifyBackup,
} from '../../scripts/lib/backup.mjs';

let directory: string;
let temporaryRoot: string;
beforeEach(async () => {
  temporaryRoot = await realpath(tmpdir());
  directory = await mkdtemp(join(temporaryRoot, 'tattoo-backup-test-'));
});
afterEach(async () => {
  if (
    dirname(directory) !== temporaryRoot ||
    !basename(directory).startsWith('tattoo-backup-test-')
  )
    throw new Error('临时目录范围无效');
  await rm(directory, { recursive: true });
});

function archive(entries: { name: string; type?: string; link?: string; data?: Buffer }[]) {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const header = Buffer.alloc(512);
    const data = entry.data ?? Buffer.alloc(0);
    const text = (value: string, offset: number) => header.write(value, offset, 'utf8');
    const octal = (value: number, offset: number, width: number) =>
      text(`${value.toString(8).padStart(width - 1, '0')}\0`, offset);
    text(entry.name, 0);
    octal(0o600, 100, 8);
    octal(1000, 108, 8);
    octal(1000, 116, 8);
    octal(data.length, 124, 12);
    octal(1700000000, 136, 12);
    header.fill(32, 148, 156);
    text(entry.type ?? '0', 156);
    if (entry.link) text(entry.link, 157);
    text('ustar\0', 257);
    text('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    text(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

async function checkTar(content: Buffer) {
  const path = join(directory, 'assets.tar');
  await writeFile(path, content);
  return validateAssetArchive(path);
}

function manifest() {
  return {
    schemaVersion: 1,
    createdAt: '2026-11-20T00:00:00.000Z',
    application: { imageRef: 'tattoo-app:test', imageId: `sha256:${'a'.repeat(64)}` },
    postgresVersion: '160010',
    keyFingerprint: keyFingerprint(Buffer.alloc(32, 7).toString('base64')),
    files: {
      'database.dump': { bytes: 10, sha256: 'b'.repeat(64) },
      'assets.tar': { bytes: 1024, sha256: 'c'.repeat(64) },
    },
  };
}

describe('备份完整性与归档提取边界', () => {
  it('二进制归档与摘要按原字节检查，空素材目录也可备份', async () => {
    const content = archive([
      { name: './', type: '5' },
      { name: './image.jpg', data: Buffer.alloc(733, 255) },
    ]);
    await expect(checkTar(content)).resolves.toBe(2);
    const digest = await fileDigest(join(directory, 'assets.tar'));
    expect(digest).toEqual({
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
    await expect(checkTar(archive([{ name: './', type: '5' }]))).resolves.toBe(1);
  });

  it.each([
    '../escape.jpg',
    '/escape.jpg',
    './nested/../../escape.jpg',
    'C:/escape.jpg',
    'nested\\escape.jpg',
  ])('拒绝不安全素材路径 %s', async (name) => {
    await expect(checkTar(archive([{ name }]))).rejects.toThrow(/不安全路径/);
  });

  it.each(['1', '2', '3', '4', '6', 'x', 'L'])(
    '拒绝硬链接、符号链接和特殊条目 %s',
    async (type) => {
      await expect(
        checkTar(archive([{ name: './unsafe', type, link: '../../outside' }])),
      ).rejects.toThrow(/链接或特殊文件/);
    },
  );

  it('归一化后重复名称和文件/目录冲突不能提取', async () => {
    await expect(
      checkTar(archive([{ name: './image.jpg' }, { name: 'image.jpg' }])),
    ).rejects.toThrow(/重复路径/);
    await expect(
      checkTar(archive([{ name: './folder' }, { name: './folder/image.jpg' }])),
    ).rejects.toThrow(/路径冲突/);
  });

  it('头校验、截断与终止标记之后的数据都不能通过', async () => {
    const content = archive([{ name: './image.jpg', data: Buffer.from('image') }]);
    const broken = Buffer.from(content);
    broken[0] = 88;
    await expect(checkTar(broken)).rejects.toThrow(/头校验/);
    await expect(checkTar(content.subarray(0, content.length - 1))).rejects.toThrow(/完整/);
    await expect(checkTar(content.subarray(0, content.length - 512))).rejects.toThrow(/结束标记/);
    await expect(checkTar(Buffer.concat([Buffer.alloc(1024), content]))).rejects.toThrow(
      /结束标记之后/,
    );
  });

  it('manifest 限定版本、文件名与摘要，主密钥只保存指纹', () => {
    const value = manifest();
    expect(validateManifest(value)).toBe(value);
    expect(JSON.stringify(value)).not.toContain(Buffer.alloc(32, 7).toString('base64'));
    expect(() => validateManifest({ ...value, schemaVersion: 2 })).toThrow(/格式或版本/);
    expect(() =>
      validateManifest({ ...value, files: { '../database.dump': value.files['database.dump'] } }),
    ).toThrow(/文件清单/);
    expect(() =>
      validateManifest({
        ...value,
        files: { ...value.files, 'database.dump': { bytes: 3, sha256: 'bad' } },
      }),
    ).toThrow(/摘要/);
    expect(() => keyFingerprint('wrong-key')).toThrow(/32 字节/);
  });

  it('有效目录通过，修改数据库或素材任何字节后都拒绝', async () => {
    const dump = Buffer.from([80, 71, 68, 77, 80, 0, 255, 1]);
    const tar = archive([{ name: './', type: '5' }]);
    await writeFile(join(directory, 'database.dump'), dump);
    await writeFile(join(directory, 'assets.tar'), tar);
    const value = manifest();
    value.files['database.dump'] = await fileDigest(join(directory, 'database.dump'));
    value.files['assets.tar'] = await fileDigest(join(directory, 'assets.tar'));
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(value));
    await expect(verifyBackup(directory)).resolves.toEqual(value);
    await writeFile(join(directory, 'database.dump'), Buffer.from([80, 71, 68, 77, 80, 0, 254, 1]));
    await expect(verifyBackup(directory)).rejects.toThrow(/SHA256 不匹配/);
    await writeFile(join(directory, 'database.dump'), dump);
    await writeFile(join(directory, 'assets.tar'), Buffer.alloc(tar.length));
    await expect(verifyBackup(directory)).rejects.toThrow(/SHA256 不匹配/);
  });
});

describe('恢复显式目标', () => {
  it.each([
    'REMOTE_WRITES_ENABLED=false\n',
    'export REMOTE_WRITES_ENABLED = "false" # 保持暂停\r\n',
    "REMOTE_WRITES_ENABLED='false'\nOTHER=unchanged\n",
    '# 说明\nREMOTE_WRITES_ENABLED=false # 暂停\nREMOTE_WRITES_ENABLED=false\n',
  ])('恢复文件中的持久 literal false 可使用常规引号与注释', (content) => {
    expect(() => validateRestoreEnv(content)).not.toThrow();
  });

  it.each([
    'OTHER=false\n',
    'REMOTE_WRITES_ENABLED=true\n',
    'REMOTE_WRITES_ENABLED=${OTHER}\nOTHER=false\n',
    'REMOTE_WRITES_ENABLED="${OTHER}"\nOTHER=false\n',
    'REMOTE_WRITES_ENABLED=true\nREMOTE_WRITES_ENABLED=false\n',
    'REMOTE_WRITES_ENABLED=false\nREMOTE_WRITES_ENABLED=true\n',
    'OTHER="inside\nREMOTE_WRITES_ENABLED=false\nend"\n',
  ])('文件值缺失、插值或矛盾赋值不能被 shell 覆盖掩盖', (content) => {
    expect(() => validateRestoreEnv(content)).toThrow(/持久设置/);
  });

  it('恢复要求配置和项目，拒绝输入输出混用与非法项目名', () => {
    expect(() => cliOptions('restore', ['--input', 'backup'])).toThrow(/显式指定/);
    expect(() =>
      cliOptions('restore', [
        '--input',
        'backup',
        '--project',
        'safe',
        '--env-file',
        'restore.env',
        '--output',
        'other',
      ]),
    ).toThrow(/显式指定/);
    expect(() => cliOptions('backup', ['--output', 'backup', '--project', '../live'])).toThrow(
      /项目名/,
    );
    expect(cliOptions('backup', ['--output', 'backup']).project).toBe('tattoo');
  });

  it('按调用顺序保留指定的 Compose 文件，不自动混入另一部署配置', () => {
    const options = cliOptions('backup', [
      '--output',
      'backup',
      '--compose-file',
      'compose.yaml',
      '--compose-file',
      'compose.build.yaml',
    ]);
    expect(options.composeFiles).toEqual([resolve('compose.yaml'), resolve('compose.build.yaml')]);
    const explicit = cliOptions('restore', [
      '--input',
      'backup',
      '--project',
      'restored',
      '--env-file',
      'restore.env',
      '--compose-file',
      'deployment/custom.yaml',
    ]);
    expect(explicit.composeFiles).toEqual([resolve('deployment/custom.yaml')]);
    expect(cliOptions('backup', ['--output', 'backup']).composeFiles).toEqual([
      resolve('compose.yaml'),
    ]);
  });
});
