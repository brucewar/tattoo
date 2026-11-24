import { z } from 'zod';
import type { SourceSearchResult } from '@tattoo/contracts';
import { isPublicSourceHost, normalizeSourceUrl } from './reader';

export class SourceSearchError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}

export function normalizeSearchBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceSearchError('请输入有效的 Tavily API 基础地址');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) ||
    url.username ||
    url.password ||
    value.includes('?') ||
    value.includes('#') ||
    /[\u0000-\u0020\u007f]/.test(value)
  )
    throw new SourceSearchError(
      '搜索地址需要 HTTPS（本机服务可用 HTTP），且不能包含凭据、查询或片段',
    );
  return url.toString().replace(/\/+$/, '');
}

function metadata(value: string, maximum: number): string {
  if (/[\uD800-\uDFFF]/u.test(value)) throw new SourceSearchError('搜索结果包含无效文字');
  return value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, maximum)
    .replace(/[\uD800-\uDBFF]$/, '');
}

export class TavilySearch {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 30000,
    private readonly testOrigin?: string,
  ) {
    if (testOrigin) {
      const url = new URL(testOrigin);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.origin !== testOrigin)
        throw new SourceSearchError('搜索测试地址只能使用精确的本机来源');
    }
  }

  async search(
    baseUrl: string,
    apiKey: string,
    query: string,
    signal?: AbortSignal,
  ): Promise<SourceSearchResult[]> {
    if (!apiKey) throw new SourceSearchError('请先配置 Tavily API Key');
    let response: Response;
    try {
      response = await this.fetcher(`${baseUrl}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]),
        body: JSON.stringify({
          query,
          topic: 'general',
          search_depth: 'basic',
          auto_parameters: false,
          max_results: 5,
          include_answer: false,
          include_raw_content: false,
          include_images: false,
        }),
      });
    } catch {
      throw new SourceSearchError(
        '搜索请求超时或连接中断，未自动重发；请核对服务记录后手动重试',
        true,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SourceSearchError(
        response.status === 401
          ? 'Tavily 密钥无效，请检查 API Key'
          : response.status === 403
            ? 'Tavily 拒绝访问，请检查权限'
            : [429, 432, 433, 434].includes(response.status)
              ? 'Tavily 限流或额度不足，请检查服务记录后手动重试'
              : `搜索服务返回 HTTP ${response.status}，请检查服务配置`,
        response.status >= 500,
      );
    }
    if (Number(response.headers.get('content-length')) > 1024 * 1024) {
      await response.body?.cancel();
      throw new SourceSearchError('搜索响应超过 1 MiB 上限');
    }
    if (!response.body) throw new SourceSearchError('搜索服务没有返回结果');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        length += part.value.byteLength;
        if (length > 1024 * 1024) {
          await reader.cancel();
          throw new SourceSearchError('搜索响应超过 1 MiB 上限');
        }
        chunks.push(part.value);
      }
    } catch (error) {
      if (error instanceof SourceSearchError) throw error;
      throw new SourceSearchError('搜索响应读取中断，未自动重发；请核对服务记录后手动重试', true);
    } finally {
      reader.releaseLock();
    }
    let value: unknown;
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new SourceSearchError('搜索服务返回了无法解析的结果');
    }
    const parsed = z.object({ results: z.array(z.unknown()).max(20) }).safeParse(value);
    if (!parsed.success) throw new SourceSearchError('搜索服务没有返回有效的候选列表');
    const results: SourceSearchResult[] = [];
    const seen = new Set<string>();
    for (const candidate of parsed.data.results) {
      const item = z
        .object({
          title: z.string().max(10000),
          url: z.string().max(4000),
          content: z.string().max(100000).optional(),
        })
        .safeParse(candidate);
      if (!item.success) continue;
      let url: string;
      try {
        url = normalizeSourceUrl(item.data.url);
      } catch {
        continue;
      }
      if (
        (!isPublicSourceHost(new URL(url).hostname) && new URL(url).origin !== this.testOrigin) ||
        seen.has(url)
      )
        continue;
      seen.add(url);
      results.push({
        title: metadata(item.data.title, 500) || url,
        url,
        snippet: metadata(item.data.content ?? '', 5000),
      });
      if (results.length === 5) break;
    }
    if (parsed.data.results.length && !results.length)
      throw new SourceSearchError('搜索结果中没有可采集的公开链接');
    return results;
  }
}
