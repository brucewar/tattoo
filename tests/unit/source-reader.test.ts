import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type Server,
} from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  isPublicSourceHost,
  normalizeSourceUrl,
  SourceReader,
  SourceReaderError,
} from '../../apps/server/src/sources/reader';

const paragraph =
  '这是一篇可供内容创作参考的公开文章。资料应当保留原始链接和获取时间，作者需要在使用之前核实其中的信息。'.repeat(
    12,
  );
const html = `<!doctype html><html><head><meta charset="utf-8"><title>公开文章标题</title><meta property="article:published_time" content="2026-11-24T08:00:00Z"></head><body><nav>导航噪声</nav><article><h1>公开文章标题</h1><p>${paragraph}</p><p>第二段保留段落。${paragraph}</p><script src="/side-effect"></script><script>fetch('/side-effect')</script><img src="/side-effect"></article></body></html>`;
const boundaryTitle = 'a'.repeat(499) + '😀';
let server: Server;
let origin = '';
let sideEffects = 0;
let receivedHeaders: IncomingMessage['headers'];

beforeAll(async () => {
  server = createServer((request, response) => {
    receivedHeaders = request.headers;
    const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (path === '/article') response.end(html);
    else if (path === '/unicode-title')
      response.end(html.replaceAll('公开文章标题', boundaryTitle));
    else if (path === '/unicode-feed') {
      response.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      response.end(
        `<?xml version="1.0"?><rss version="2.0"><channel><title>${boundaryTitle}</title><link>${origin}</link><description>示例订阅</description><item><title>${boundaryTitle}</title><link>/article</link><description>合法标题的订阅正文。</description></item></channel></rss>`,
      );
    } else if (path === '/side-effect') {
      sideEffects++;
      response.end('unexpected');
    } else if (path === '/redirect') {
      response.statusCode = 302;
      response.setHeader('Location', '/article');
      response.end();
    } else if (path === '/loop') {
      response.statusCode = 302;
      response.setHeader('Location', '/loop');
      response.end();
    } else if (path === '/private') {
      response.statusCode = 302;
      response.setHeader('Location', 'http://169.254.169.254/latest/meta-data/');
      response.end();
    } else if (path === '/credentials') {
      response.statusCode = 302;
      response.setHeader('Location', 'https://user:password@example.com/article');
      response.end();
    } else if (path === '/oversized') {
      response.setHeader('Content-Length', String(2 * 1024 * 1024 + 1));
      response.end();
    } else if (path === '/compressed') {
      response.setHeader('Content-Encoding', 'gzip');
      response.end(gzipSync(Buffer.alloc(2 * 1024 * 1024 + 1, 'a')));
    } else if (path === '/gzip') {
      response.setHeader('Content-Encoding', 'gzip');
      response.end(gzipSync(html));
    } else if (path === '/binary') {
      response.setHeader('Content-Type', 'image/png');
      response.end(Buffer.from([0, 1, 2]));
    } else if (path === '/error') {
      response.statusCode = 403;
      response.end('remote secret error body');
    } else if (path === '/hang') {
      /* The owned socket is closed by cancellation or afterAll. */
    } else if (path === '/long') {
      response.setHeader('Content-Type', 'text/plain');
      response.end('a'.repeat(50001));
    } else if (path === '/plain') {
      response.setHeader('Content-Type', 'text/plain');
      response.end('可读取的纯文本，保留 <script> 文字。');
    } else if (path === '/empty')
      response.end(
        '<html><head><title>空页面</title><script>fetch("/side-effect")</script></head><body></body></html>',
      );
    else if (path === '/feed') {
      response.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
      response.end(
        `<?xml version="1.0"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>测试订阅</title><link>${origin}</link><description>示例订阅</description><item><title>第一条</title><link>/article#fragment</link><pubDate>Tue, 24 Nov 2026 08:00:00 GMT</pubDate><content:encoded><![CDATA[<p>订阅正文</p><script src="/side-effect"></script><p>第二段</p>]]></content:encoded></item><item><title>重复</title><link>/article</link></item><item><title>不安全</title><link>http://169.254.169.254/latest/meta-data/</link></item><item><title>无链接</title></item></channel></rss>`,
      );
    } else if (path === '/atom') {
      response.setHeader('Content-Type', 'application/atom+xml');
      response.end(
        `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom订阅</title><id>urn:test</id><updated>2026-11-24T08:00:00Z</updated><entry><title>Atom条目</title><id>urn:entry</id><link href="/atom-article"/><updated>2026-11-24T08:30:00Z</updated><summary type="html">&lt;p&gt;条目摘要&lt;/p&gt;</summary></entry></feed>`,
      );
    } else if (path === '/many') {
      response.setHeader('Content-Type', 'application/rss+xml');
      response.end(
        `<rss version="2.0"><channel><title>多条</title><link>${origin}</link><description>描述</description>${Array.from({ length: 30 }, (_, index) => `<item><title>${index}</title><link>/news/${index}</link><description>摘要</description></item>`).join('')}</channel></rss>`,
      );
    } else if (path === '/entity') {
      response.setHeader('Content-Type', 'application/rss+xml');
      response.end(
        `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY xxe SYSTEM "${origin}/side-effect">]><rss><channel><title>&xxe;</title></channel></rss>`,
      );
    } else if (path === '/invalid-feed') {
      response.setHeader('Content-Type', 'application/rss+xml');
      response.end('<rss><channel>');
    } else if (path === '/complex') response.end('<div>'.repeat(20001));
    else {
      response.statusCode = 404;
      response.end('not found');
    }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Reader fixture did not listen');
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server?.closeAllConnections();
  if (server?.listening)
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
});

const reader = () => new SourceReader({ testOrigin: origin });

describe('公开资料读取与正文/RSS解析', () => {
  it('URL身份规范化保留查询、移除片段，不信任携带凭据的来源', () => {
    expect(normalizeSourceUrl(' HTTPS://Example.COM.:443/article?q=1#section ')).toBe(
      'https://example.com/article?q=1',
    );
    expect(() => normalizeSourceUrl('https://user:secret@example.com/article')).toThrow(
      SourceReaderError,
    );
    expect(() => normalizeSourceUrl('file:///etc/passwd')).toThrow(SourceReaderError);
    expect(() => normalizeSourceUrl('https://example.com/a\nb')).toThrow(SourceReaderError);
    expect(() => normalizeSourceUrl('https://example.com/' + 'a'.repeat(4000))).toThrow('4000');
  });

  it('拒绝环回、私网、映射和特殊IP，保留真实公开域名/IP', () => {
    for (const value of [
      'localhost',
      'sub.localhost',
      'rsshub',
      '169.254.169.254',
      '100.100.100.200',
      '192.168.1.1',
      '127.0.0.1',
      '0.0.0.0',
      '192.0.2.1',
      '[::1]',
      '[::2]',
      '[::127.0.0.1]',
      '[::ffff:8.8.8.8]',
      '[2001:db8::1]',
      '[4000::1]',
      'service.internal',
    ])
      expect(isPublicSourceHost(value), value).toBe(false);
    for (const value of ['example.com', '8.8.8.8', '[2001:4860:4860::8888]'])
      expect(isPublicSourceHost(value), value).toBe(true);
  });

  it('公开地址策略对数字IP和非标准端口同样生效，测试只放行精确origin', async () => {
    await expect(new SourceReader().article('http://2130706433/article')).rejects.toThrow(
      '公开网络',
    );
    await expect(new SourceReader().article('https://example.com:8443/article')).rejects.toThrow(
      '公开网络',
    );
    await expect(reader().article('http://127.0.0.1/article')).rejects.toThrow('公开网络');
    expect(() => new SourceReader({ testOrigin: 'http://192.168.1.1' })).toThrow('环回');
  });

  it('检查全部DNS答案，混入私网地址时不选择另一条公开地址继续连接', async () => {
    const transport = vi.fn();
    const blocked = new SourceReader({
      resolve: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '10.0.0.1', family: 4 },
      ],
      request: transport,
    });
    await expect(blocked.article('https://mixed.example/article')).rejects.toThrow('解析到了');
    expect(transport).not.toHaveBeenCalled();
  });

  it('连接使用已检查的IP且只解析一次，正文请求不带认证或Cookie', async () => {
    const resolve = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
    let pinned = '';
    const request = vi.fn(
      (url: URL, options: RequestOptions, listener: (response: IncomingMessage) => void) => {
        expect(url.toString()).toBe('http://public.example/article');
        options.lookup!('public.example', {}, (_error, address) => {
          pinned = String(address);
        });
        return httpRequest(
          origin + '/article',
          { ...options, lookup: undefined, family: 4 },
          listener,
        );
      },
    );
    const result = await new SourceReader({ resolve, request }).article(
      'http://public.example/article',
    );
    expect(result.url).toBe('http://public.example/article');
    expect(pinned).toBe('8.8.8.8');
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(receivedHeaders).not.toHaveProperty('authorization');
    expect(receivedHeaders).not.toHaveProperty('cookie');
    expect(result.text).toContain('公开文章');
  });

  it('提取正文、标题和日期，不执行脚本或获取原文图片', async () => {
    const before = sideEffects;
    const result = await reader().article(origin + '/article#fragment');
    expect(result).toMatchObject({
      url: origin + '/article',
      resolvedUrl: origin + '/article',
      title: '公开文章标题',
      publishedAt: '2026-11-24T08:00:00.000Z',
    });
    expect(result.text).toContain('第二段保留段落');
    expect(result.text).not.toContain('<p>');
    expect(result.text).not.toContain("fetch('/side-effect')");
    expect(result.text).not.toContain('导航噪声');
    expect(sideEffects).toBe(before);
  });

  it('公开相对跳转记录最终链接，原始身份不被替换', async () => {
    const result = await reader().article(origin + '/redirect');
    expect(result.url).toBe(origin + '/redirect');
    expect(result.resolvedUrl).toBe(origin + '/article');
    await expect(reader().article(origin + '/private')).rejects.toThrow('公开网络');
    await expect(reader().article(origin + '/credentials')).rejects.toThrow('凭据');
    await expect(reader().article(origin + '/loop')).rejects.toThrow('跳转');
  });

  it('文章、订阅和条目标题在emoji边界截断后保持有效Unicode，正文仍可采集', async () => {
    const article = await reader().article(origin + '/unicode-title');
    const feed = await reader().feed(origin + '/unicode-feed');
    for (const title of [article.title, feed.title, feed.items[0]!.title]) {
      expect(title).toBe('a'.repeat(499));
      expect(title).not.toMatch(/[\uD800-\uDFFF]/u);
    }
    expect(article.text).toContain('可供内容创作参考');
    expect(feed.items[0]!.text).toBe('合法标题的订阅正文。');
  });

  it('压缩正常解码，压缩炸弹、超大响应和非文本内容均拒绝', async () => {
    expect((await reader().article(origin + '/gzip')).title).toBe('公开文章标题');
    await expect(reader().article(origin + '/compressed')).rejects.toThrow('2 MiB');
    await expect(reader().article(origin + '/oversized')).rejects.toThrow('2 MiB');
    await expect(reader().article(origin + '/binary')).rejects.toThrow('不能提取图片');
    await expect(reader().article(origin + '/complex')).rejects.toThrow('结构过于复杂');
  });

  it('无正文、正文超过上限和服务错误不成为成功资料，不泄露远程错误body', async () => {
    await expect(reader().article(origin + '/empty')).rejects.toThrow('正文');
    await expect(reader().article(origin + '/long')).rejects.toThrow('50000');
    try {
      await reader().article(origin + '/error');
      throw new Error('Expected source error');
    } catch (error) {
      expect(error).toBeInstanceOf(SourceReaderError);
      expect((error as Error).message).toContain('403');
      expect((error as Error).message).not.toContain('remote secret');
    }
    expect((await reader().article(origin + '/plain')).text).toBe(
      '可读取的纯文本，保留 <script> 文字。',
    );
  });

  it('总请求时限、调用方取消和DNS等待取消都有界', async () => {
    await expect(
      new SourceReader({ testOrigin: origin, timeoutMs: 30 }).article(origin + '/hang'),
    ).rejects.toThrow('取消');
    const cancel = new AbortController();
    cancel.abort();
    await expect(reader().article(origin + '/article', cancel.signal)).rejects.toThrow('取消');
    const waiting = new SourceReader({
      timeoutMs: 30,
      resolve: () => new Promise(() => undefined),
    });
    await expect(waiting.article('https://unresolved.example/article')).rejects.toThrow('取消');
  });

  it('RSS保留文字与日期，规范相对链接并去重，不抓条目正文或脚本', async () => {
    const before = sideEffects;
    const result = await reader().feed(origin + '/feed');
    expect(result.title).toBe('测试订阅');
    expect(result.items).toEqual([
      {
        url: origin + '/article',
        title: '第一条',
        text: '订阅正文\n第二段',
        publishedAt: '2026-11-24T08:00:00.000Z',
      },
    ]);
    expect(sideEffects).toBe(before);
  });

  it('Atom摘要保持来源内容并最多导入20个条目', async () => {
    const result = await reader().feed(origin + '/atom');
    expect(result.title).toBe('Atom订阅');
    expect(result.items[0]).toMatchObject({
      url: origin + '/atom-article',
      title: 'Atom条目',
      text: '条目摘要',
    });
    expect((await reader().feed(origin + '/many')).items).toHaveLength(20);
  });

  it('拒绝DTD、外部实体和损坏XML，不向实体链接发请求', async () => {
    const before = sideEffects;
    await expect(reader().feed(origin + '/entity')).rejects.toThrow('DTD');
    await expect(reader().feed(origin + '/invalid-feed')).rejects.toThrow('无法解析');
    expect(sideEffects).toBe(before);
  });
});
