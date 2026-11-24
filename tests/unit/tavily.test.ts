import { describe, expect, it, vi } from 'vitest';
import {
  normalizeSearchBaseUrl,
  SourceSearchError,
  TavilySearch,
} from '../../apps/server/src/sources/tavily';

const candidate = {
  title: '公开来源',
  url: 'https://example.com/article#read',
  content: '搜索摘要，不是原文。',
};

describe('Tavily 搜索请求与结果', () => {
  it('只执行明确的 basic 搜索，密钥只放 Bearer，不隐式请求全文或答案', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ results: [candidate] }));
    expect(
      await new TavilySearch(fetcher).search('https://api.tavily.com', 'test-secret', '资料主题'),
    ).toEqual([
      { title: candidate.title, url: 'https://example.com/article', snippet: candidate.content },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.tavily.com/search');
    expect(request!.redirect).toBe('error');
    expect(request!.headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer test-secret',
    });
    expect(JSON.parse(request!.body as string)).toEqual({
      query: '资料主题',
      topic: 'general',
      search_depth: 'basic',
      auto_parameters: false,
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    });
    expect(request!.body).not.toContain('test-secret');
  });

  it('过滤危险地址、去重并最多保留五条候选，不把摘要保存成全文', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        results: [
          { ...candidate, url: 'http://127.0.0.1/admin' },
          { ...candidate, url: 'http://169.254.169.254/latest/meta-data/' },
          { ...candidate, url: 'javascript:alert(1)' },
          candidate,
          { ...candidate, url: 'https://example.com/article#other' },
          ...Array.from({ length: 6 }, (_, index) => ({
            ...candidate,
            url: `https://example.com/${index}`,
          })),
        ],
      }),
    );
    const results = await new TavilySearch(fetcher).search('https://api.tavily.com', 'key', '主题');
    expect(results).toHaveLength(5);
    expect(results.map(({ url }) => url)).toEqual([
      'https://example.com/article',
      'https://example.com/0',
      'https://example.com/1',
      'https://example.com/2',
      'https://example.com/3',
    ]);
    expect(results[0]).not.toHaveProperty('text');
  });

  it('只有精确测试来源可以作为本机候选，其它私网地址仍被丢弃', async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({
        results: [
          { ...candidate, url: 'http://127.0.0.1:9999/article' },
          { ...candidate, url: 'http://127.0.0.1:9998/private' },
        ],
      }),
    );
    expect(
      await new TavilySearch(fetcher, 30000, 'http://127.0.0.1:9999').search(
        'http://127.0.0.1:9999',
        'key',
        '主题',
      ),
    ).toEqual([
      { title: candidate.title, url: 'http://127.0.0.1:9999/article', snippet: candidate.content },
    ]);
    expect(() => new TavilySearch(fetcher, 30000, 'http://192.168.1.1')).toThrow('本机');
  });

  it('空搜索结果是有效结果，无密钥则不发请求', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ results: [] }));
    const provider = new TavilySearch(fetcher);
    await expect(provider.search('https://api.tavily.com', '', '主题')).rejects.toThrow('API Key');
    expect(fetcher).not.toHaveBeenCalled();
    expect(await provider.search('https://api.tavily.com', 'key', '主题')).toEqual([]);
  });

  it.each([401, 403, 429, 432, 433, 434, 500])('HTTP %i 不泄露服务错误体或密钥', async (status) => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ secret: 'sensitive-provider-response' }, { status }),
    );
    const error = await new TavilySearch(fetcher)
      .search('https://api.tavily.com', 'key', '主题')
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SourceSearchError);
    expect((error as Error).message).not.toContain('sensitive-provider-response');
    expect((error as SourceSearchError).uncertain).toBe(status >= 500);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('连接中断标记待核对，不自动重发请求', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw Error('secret-transport-details');
    });
    await expect(
      new TavilySearch(fetcher).search('https://api.tavily.com', 'key', '主题'),
    ).rejects.toMatchObject({ uncertain: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('中断信号传给请求，读取中断同样标记待核对', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      expect(options?.signal?.aborted).toBe(true);
      throw Error('aborted');
    });
    controller.abort();
    await expect(
      new TavilySearch(fetcher).search('https://api.tavily.com', 'key', '主题', controller.signal),
    ).rejects.toMatchObject({ uncertain: true });
    const interrupted = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(reader) {
              reader.error(Error('disconnected'));
            },
          }),
        ),
    );
    await expect(
      new TavilySearch(interrupted).search('https://api.tavily.com', 'key', '主题'),
    ).rejects.toMatchObject({ uncertain: true });
  });

  it.each([
    { response: new Response('not json'), message: '解析' },
    { response: Response.json({ error: 'sensitive' }), message: '候选列表' },
    {
      response: Response.json({ results: [{ ...candidate, url: 'http://localhost/private' }] }),
      message: '公开链接',
    },
    {
      response: new Response('small', { headers: { 'Content-Length': String(1024 * 1024 + 1) } }),
      message: '1 MiB',
    },
    { response: new Response('x'.repeat(1024 * 1024 + 1)), message: '1 MiB' },
  ])('拒绝坏格式、全危险链接及超大响应', async ({ response, message }) => {
    await expect(
      new TavilySearch(vi.fn<typeof fetch>(async () => response)).search(
        'https://api.tavily.com',
        'key',
        '主题',
      ),
    ).rejects.toThrow(message);
  });
});

describe('Tavily 基础地址', () => {
  it('保留网关前缀并去掉尾斜线，HTTP仅允许本机', () => {
    expect(normalizeSearchBaseUrl('https://gateway.example/v1/')).toBe(
      'https://gateway.example/v1',
    );
    expect(normalizeSearchBaseUrl('http://127.0.0.1:8888/')).toBe('http://127.0.0.1:8888');
  });
  it.each([
    'http://192.168.1.1/',
    'https://user:key@example.com',
    'https://example.com/?',
    'https://example.com/#',
    'file:///tmp/key',
    'https://example.com/\n',
  ])('拒绝不安全地址 %s', (value) => {
    expect(() => normalizeSearchBaseUrl(value)).toThrow(SourceSearchError);
  });
});
