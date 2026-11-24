import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { installWeb } from '../../apps/server/src/web';

let directory: string;
let temporaryRoot: string;
let server: Server;
let origin: string;

beforeAll(async () => {
  temporaryRoot = await realpath(tmpdir());
  directory = await mkdtemp(join(temporaryRoot, 'tattoo-web-test-'));
  await mkdir(join(directory, 'assets'));
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>Tattoo</title>');
  await writeFile(join(directory, 'assets', 'main-abc12345.js'), 'window.tattoo = true;');
  await writeFile(join(directory, '.env'), 'must-not-be-served');
  const app = express();
  app.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  installWeb(app, directory, true);
  app.use('/api', (_request, response) => response.status(404).json({ error: 'API_NOT_FOUND' }));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('测试端口无效');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) {
    if (dirname(directory) !== temporaryRoot || !basename(directory).startsWith('tattoo-web-test-'))
      throw new Error('临时目录范围无效');
    await rm(directory, { recursive: true });
  }
});

describe('同一应用入口提供页面与 API', () => {
  it('入口和 SPA 深链接可刷新，页面不永久缓存且保留安全头', async () => {
    for (const path of ['/', '/articles/saved-article', '/sources']) {
      const response = await fetch(origin + path);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toMatch(/text\/html/);
      expect(response.headers.get('Cache-Control')).toBe('no-cache');
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(response.headers.get('X-Frame-Options')).toBe('DENY');
      expect(response.headers.get('Referrer-Policy')).toBe('same-origin');
      const policy = response.headers.get('Content-Security-Policy') ?? '';
      expect(policy).toContain("script-src 'self'");
      expect(policy).toContain("font-src 'self' data:");
      expect(policy).toContain("style-src 'self' 'unsafe-inline'");
      expect(policy).toContain("frame-ancestors 'none'");
      expect(policy).not.toContain('upgrade-insecure-requests');
      expect(await response.text()).toContain('<title>Tattoo</title>');
    }
    const head = await fetch(origin + '/articles/saved-article', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('哈希构建资源保留 MIME 与长期缓存，缺失文件不返回 HTML', async () => {
    const response = await fetch(origin + '/assets/main-abc12345.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toMatch(/javascript/);
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(await response.text()).toBe('window.tattoo = true;');
    for (const path of ['/assets/missing.js', '/missing.png']) {
      const missing = await fetch(origin + path);
      expect(missing.status).toBe(404);
      expect(await missing.text()).not.toContain('<title>Tattoo</title>');
    }
  });

  it('API、非文档请求、非法编码和文件越界不能被 SPA 兜底', async () => {
    for (const path of ['/api', '/api/v1/unknown']) {
      const response = await fetch(origin + path);
      expect(response.status).toBe(404);
      expect(response.headers.get('Content-Type')).toMatch(/application\/json/);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual({ error: 'API_NOT_FOUND' });
    }
    for (const path of ['/.env', '/nested/%2e%2e%2f.env', '/nested%5c.env', '/%00']) {
      const response = await fetch(origin + path);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('must-not-be-served');
    }
    expect((await fetch(origin + '/%E0%A4%A')).status).toBe(400);
    expect(
      (await fetch(origin + '/articles/one', { headers: { Accept: 'application/json' } })).status,
    ).toBe(404);
    expect((await fetch(origin + '/', { method: 'POST' })).status).toBe(404);
  });

  it('生产缺少前端文件拒绝启动，开发模式可继续使用 Vite', () => {
    expect(() => installWeb(express(), join(directory, 'missing'), true)).toThrow(
      '前端构建文件缺失',
    );
    expect(() => installWeb(express(), join(directory, 'missing'))).not.toThrow();
  });
});
