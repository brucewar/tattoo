import { createHash } from 'node:crypto';

export function createSourcesMock() {
  const calls = { article: 0, feed: 0, search: 0 };
  const requests = [];
  const held = new Set();
  let articleVersion = 1;
  let modes = { article: 'success', feed: 'success', search: 'success' };

  function releaseAll() {
    for (const release of held) release();
    held.clear();
  }
  function control(input = {}) {
    for (const [key, type] of [
      ['nextArticle', 'article'],
      ['nextFeed', 'feed'],
      ['nextSearch', 'search'],
    ]) {
      if (['success', 'hold', 'disconnect', 'refused', 'malformed'].includes(input[key]))
        modes[type] = input[key];
    }
    if (Number.isInteger(input.articleVersion) && input.articleVersion > 0)
      articleVersion = input.articleVersion;
    if (input.release) releaseAll();
  }
  async function handle(incoming, outgoing, pathname, bytes) {
    if (pathname === '/__tattoo_sources_audit') {
      outgoing.setHeader('Content-Type', 'application/json');
      outgoing.end(JSON.stringify({ calls, requests }));
      return true;
    }
    if (pathname === '/__tattoo_sources_control') {
      control(JSON.parse(bytes.toString('utf8') || '{}'));
      outgoing.setHeader('Content-Type', 'application/json');
      outgoing.end(JSON.stringify({ ok: true }));
      return true;
    }
    const kind =
      pathname === '/search'
        ? 'search'
        : ['/sources/feed', '/sources/atom', '/sources/entity'].includes(pathname)
          ? 'feed'
          : pathname.startsWith('/sources/article') || pathname === '/sources/private-redirect'
            ? 'article'
            : null;
    if (!kind) return false;
    calls[kind]++;
    let payload;
    try {
      payload = JSON.parse(bytes.toString('utf8') || '{}');
    } catch {
      payload = {};
    }
    const authorization = String(incoming.headers.authorization ?? '');
    requests.push({
      kind,
      path: incoming.url ?? pathname,
      authorizationHash: authorization
        ? createHash('sha256').update(authorization).digest('hex')
        : '',
      ...(kind === 'search'
        ? {
            query: payload.query,
            payload: {
              topic: payload.topic,
              search_depth: payload.search_depth,
              auto_parameters: payload.auto_parameters,
              max_results: payload.max_results,
              include_answer: payload.include_answer,
              include_raw_content: payload.include_raw_content,
              include_images: payload.include_images,
              bodyHasApiKey: Object.hasOwn(payload, 'api_key'),
            },
          }
        : {}),
    });
    const mode = modes[kind];
    modes[kind] = 'success';
    if (mode === 'hold') await new Promise((resolve) => held.add(resolve));
    if (incoming.socket.destroyed || outgoing.destroyed) return true;
    if (mode === 'disconnect') {
      incoming.socket.destroy();
      return true;
    }
    if (mode === 'refused') {
      outgoing.statusCode = 403;
      outgoing.end('source fixture access denied');
      return true;
    }
    const origin = `http://${incoming.headers.host}`;
    if (kind === 'search') {
      outgoing.setHeader('Content-Type', 'application/json');
      outgoing.end(
        JSON.stringify(
          mode === 'malformed'
            ? { results: 'invalid' }
            : {
                results: [
                  {
                    title: 'Tattoo 资料测试文章',
                    url: origin + '/sources/article',
                    content: '这只是搜索摘要，需要明确采集原文。',
                  },
                  {
                    title: '第二篇公开资料',
                    url: origin + '/sources/article-two',
                    content: '另一篇文章的搜索摘要。',
                  },
                  { title: '重复条目', url: origin + '/sources/article#fragment', content: '重复' },
                  {
                    title: '私网结果',
                    url: 'http://169.254.169.254/latest/meta-data/',
                    content: '必须过滤',
                  },
                ],
              },
        ),
      );
      return true;
    }
    if (pathname === '/sources/private-redirect') {
      outgoing.statusCode = 302;
      outgoing.setHeader('Location', 'http://169.254.169.254/latest/meta-data/');
      outgoing.end();
      return true;
    }
    if (kind === 'article') {
      outgoing.setHeader('Content-Type', 'text/html; charset=utf-8');
      const title = pathname === '/sources/article-two' ? '第二篇公开资料' : 'Tattoo 资料测试文章';
      const text = `这是第 ${articleVersion} 版已采集的正文参考。内容来自本地 HTTP 模拟服务，使用时必须保留来源链接并核实资料。`;
      outgoing.end(
        mode === 'malformed'
          ? '<html><body></body></html>'
          : `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta property="article:published_time" content="2026-11-24T08:00:00Z"></head><body><nav>导航噪声</nav><article><h1>${title}</h1><p>${text.repeat(12)}</p><p>资料选用后才提交给模型，采集不会自动生成文章。</p></article></body></html>`,
      );
      return true;
    }
    if (mode === 'malformed') {
      outgoing.setHeader('Content-Type', 'application/rss+xml');
      outgoing.end('<rss><channel>');
    } else if (pathname === '/sources/atom') {
      outgoing.setHeader('Content-Type', 'application/atom+xml');
      outgoing.end(
        `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Atom 测试订阅</title><id>urn:tattoo:feed</id><updated>2026-11-24T08:00:00Z</updated><entry><title>Atom资料</title><id>urn:tattoo:entry</id><link href="${origin}/sources/article?atom=1"/><updated>2026-11-24T08:00:00Z</updated><summary>Atom提供的摘要资料。</summary></entry></feed>`,
      );
    } else {
      outgoing.setHeader('Content-Type', 'application/rss+xml');
      if (pathname === '/sources/entity')
        outgoing.end(
          '<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><channel><title>&xxe;</title></channel></rss>',
        );
      else
        outgoing.end(
          mode === 'malformed'
            ? '<rss><channel>'
            : `<?xml version="1.0"?><rss version="2.0"><channel><title>RSS 测试订阅</title><link>${origin}</link><description>本地模拟订阅</description><item><title>RSS第一条资料</title><link>${origin}/sources/article</link><pubDate>Tue, 24 Nov 2026 08:00:00 GMT</pubDate><description><![CDATA[<p>RSS摘要，可能不是全文。</p>]]></description></item><item><title>RSS第二条资料</title><link>${origin}/sources/article-two</link><description>第二条RSS摘要。</description></item><item><title>重复资料</title><link>${origin}/sources/article#fragment</link></item><item><title>不安全资料</title><link>http://169.254.169.254/latest/meta-data/</link></item></channel></rss>`,
        );
    }
    return true;
  }
  return { calls, requests, handle, control, releaseAll };
}
