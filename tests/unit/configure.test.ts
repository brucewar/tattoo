import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('配置生成使用随机密钥且拒绝覆盖现有部署配置', async () => {
  const temporaryRoot = await realpath(tmpdir());
  const directory = await mkdtemp(join(temporaryRoot, 'tattoo-config-test-'));
  try {
    const file = join(directory, '.env');
    const script = resolve('scripts/configure.mjs');
    const first = spawnSync(process.execPath, [script, '--output', file], { encoding: 'utf8' });
    expect(first.status).toBe(0);
    const before = await readFile(file, 'utf8');
    const key = before.match(/^APP_ENCRYPTION_KEY=(.+)$/m)?.[1];
    expect(Buffer.from(key!, 'base64')).toHaveLength(32);
    expect(first.stdout).not.toContain(key);
    expect(spawnSync(process.execPath, [script, '--output', file]).status).not.toBe(0);
    expect(await readFile(file, 'utf8')).toBe(before);
  } finally {
    if (
      dirname(directory) !== temporaryRoot ||
      !basename(directory).startsWith('tattoo-config-test-')
    )
      throw new Error('临时目录范围校验失败');
    await rm(directory, { recursive: true });
  }
});
