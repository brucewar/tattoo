import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { PrismaClient } from '@prisma/client';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AssetsService } from '../../apps/server/src/assets/assets.module';
import { loadConfig } from '../../apps/server/src/config';
import type { Database } from '../../apps/server/src/database';

const url = process.env.TEST_DATABASE_URL;
if (!url || !/test/i.test(new URL(url).pathname)) throw new Error('素材测试必须使用独立测试库');
const database = new PrismaClient({ datasources: { db: { url } } });
const id = randomUUID();
const dataRoot = resolve('data');
const directory = join(dataRoot, `accounts-assets-test-${id}`);
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: url,
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64'),
  STORAGE_PATH: directory,
});
const assets = new AssetsService(database as Database, config);
const ids = new Set<string>();
let picture: Buffer;

beforeAll(async () => {
  await database.$connect();
  await mkdir(directory, { recursive: true });
  picture = await sharp({ create: { width: 17, height: 13, channels: 3, background: '#327856' } })
    .png()
    .toBuffer();
});
afterAll(async () => {
  await database.asset.deleteMany({ where: { id: { in: [...ids] } } });
  await database.$disconnect();
  const root = await realpath(dataRoot);
  const target = await realpath(directory);
  if (dirname(target) !== root || basename(target) !== `accounts-assets-test-${id}`)
    throw new Error('测试素材清理范围不匹配');
  await rm(target, { recursive: true });
});

describe('安全素材上传', () => {
  it('规范化图像并哈希去重，客户端文件名不能控制磁盘路径', async () => {
    const [first, second] = await Promise.all([
      assets.upload(picture, '../../cover.png'),
      assets.upload(picture, 'other.png'),
    ]);
    ids.add(first.id);
    ids.add(second.id);
    expect(first.id).toBe(second.id);
    const file = await assets.getFile(first.id);
    expect(file.asset.path).toMatch(/^[0-9a-f-]+\.png$/);
    expect(dirname(file.path)).toBe(directory);
    expect(file.asset.name).not.toContain('..');
    expect(await readdir(directory)).toEqual([file.asset.path]);
    const compressed = await assets.coverBuffer(first.id);
    expect(compressed.length).toBeLessThanOrEqual(512 * 1024);
    expect((await sharp(compressed).metadata()).format).toBe('jpeg');
    expect((await sharp(file.path).metadata()).format).toBe('png');
  });
  it('拒绝 SVG、伪装内容、损坏图像及超过请求上限的图像', async () => {
    for (const value of [
      Buffer.from('<svg><script>alert(1)</script></svg>'),
      Buffer.from('not a png'),
      Buffer.from([255, 216, 255, 0, 0]),
      Buffer.alloc(10 * 1024 * 1024 + 1),
    ]) {
      await expect(assets.upload(value, 'pretend.png')).rejects.toMatchObject({ status: 400 });
    }
  });
  it('应用 EXIF 方向并去除元数据，微信压缩副本不改写本地素材', async () => {
    const rotated = await sharp({
      create: { width: 31, height: 19, channels: 3, background: '#b86f44' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const asset = await assets.upload(rotated, 'oriented.jpg');
    ids.add(asset.id);
    const file = await assets.getFile(asset.id);
    const before = await readFile(file.path);
    const metadata = await sharp(before).metadata();
    expect([metadata.width, metadata.height]).toEqual([19, 31]);
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    await assets.coverBuffer(asset.id);
    expect(await readFile(file.path)).toEqual(before);
    const oversized = await sharp({
      create: { width: 5001, height: 4000, channels: 3, background: '#ffffff' },
    })
      .png()
      .toBuffer();
    await expect(assets.upload(oversized, 'too-many-pixels.png')).rejects.toMatchObject({
      status: 400,
    });
  });
  it('文件写入失败不留下可引用的素材记录', async () => {
    const occupied = join(directory, 'not-a-directory');
    await writeFile(occupied, 'occupied');
    const failing = new AssetsService(database as Database, { ...config, STORAGE_PATH: occupied });
    const different = await sharp({
      create: { width: 19, height: 17, channels: 3, background: '#d8264c' },
    })
      .png()
      .toBuffer();
    const count = await database.asset.count();
    await expect(failing.upload(different, 'new.png')).rejects.toThrow();
    expect(await database.asset.count()).toBe(count);
  });
  it('数据库中越界路径无法被素材接口读取', async () => {
    const invalid = await database.asset.create({
      data: {
        name: 'invalid',
        mime: 'image/png',
        size: 1,
        width: 1,
        height: 1,
        sha256: randomUUID(),
        path: '../outside.txt',
      },
    });
    ids.add(invalid.id);
    await expect(assets.getFile(invalid.id)).rejects.toMatchObject({ status: 404 });
  });
});
