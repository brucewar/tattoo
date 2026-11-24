import { lookup as dnsLookup } from 'node:dns/promises';
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type RequestOptions,
} from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import { Readability } from '@mozilla/readability';
import { JSDOM, VirtualConsole } from 'jsdom';
import ipaddr from 'ipaddr.js';
import Parser from 'rss-parser';

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 50000;
const MAX_ELEMENTS = 20000;
const TIMEOUT = 20000;

type Address = { address: string; family: number };
type Resolver = (hostname: string) => Promise<Address[]>;
type Requester = (
  url: URL,
  options: RequestOptions,
  listener: (response: IncomingMessage) => void,
) => ClientRequest;
type ResponseData = { status: number; headers: IncomingMessage['headers']; bytes: Buffer };
type ReadPage = { url: string; resolvedUrl: string; text: string; contentType: string };
type ReaderOptions = {
  testOrigin?: string;
  resolve?: Resolver;
  request?: Requester;
  timeoutMs?: number;
};

export class SourceReaderError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}

/** 只规范来源身份；公开网络与端口策略在发请求前强制检查。 */
export function normalizeSourceUrl(value: string): string {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SourceReaderError('请输入有效的 HTTP 或 HTTPS 来源链接');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    /[\u0000-\u0020\u007f]/.test(trimmed)
  )
    throw new SourceReaderError('来源链接需使用 HTTP 或 HTTPS，且不能包含凭据或控制字符');
  url.hash = '';
  if (url.hostname.endsWith('.')) url.hostname = url.hostname.slice(0, -1);
  const result = url.toString();
  if (result.length > 4000) throw new SourceReaderError('来源链接超出 4000 字符限制');
  return result;
}

function publicAddress(value: string): boolean {
  try {
    const parsed = ipaddr.parse(value);
    return (
      parsed.range() === 'unicast' &&
      (parsed.kind() !== 'ipv6' || (parsed.toByteArray()[0]! & 0xe0) === 0x20)
    );
  } catch {
    return false;
  }
}

/** 无 DNS 快筛；域名实际连接前仍必须检查全部解析地址。 */
export function isPublicSourceHost(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (isIP(host)) return publicAddress(host);
  return (
    host.includes('.') &&
    !host.includes(':') &&
    !['localhost', 'local', 'internal', 'home.arpa', 'onion'].some(
      (suffix) => host === suffix || host.endsWith(`.${suffix}`),
    )
  );
}

function abortError(): SourceReaderError {
  return new SourceReaderError('资料请求超时或已取消，请稍后重新获取');
}

function assertActive(signal: AbortSignal) {
  if (signal.aborted) throw abortError();
}

async function resolveWithSignal(resolve: Resolver, host: string, signal: AbortSignal) {
  assertActive(signal);
  return new Promise<Address[]>((done, reject) => {
    const aborted = () => reject(abortError());
    signal.addEventListener('abort', aborted, { once: true });
    void resolve(host).then(
      (addresses) => {
        signal.removeEventListener('abort', aborted);
        if (signal.aborted) reject(abortError());
        else done(addresses);
      },
      () => {
        signal.removeEventListener('abort', aborted);
        reject(new SourceReaderError('来源域名无法解析，请检查链接后重试'));
      },
    );
  });
}

function mimeType(headers: IncomingMessage['headers']) {
  return String(headers['content-type'] ?? '')
    .split(';')[0]!
    .trim()
    .toLowerCase();
}

function permittedContentType(headers: IncomingMessage['headers'], kind: 'article' | 'feed') {
  const type = mimeType(headers);
  const allowed =
    kind === 'article'
      ? ['text/html', 'application/xhtml+xml', 'text/plain']
      : [
          'application/rss+xml',
          'application/atom+xml',
          'application/xml',
          'application/rdf+xml',
          'text/xml',
          'text/plain',
          'text/html',
        ];
  if (!allowed.includes(type))
    throw new SourceReaderError(
      kind === 'article'
        ? '来源没有返回支持的 HTML 或纯文本正文，不能提取图片、视频或文件'
        : '来源没有返回支持的 RSS 或 Atom 文本',
    );
}

function decodeBody(bytes: Buffer, headers: IncomingMessage['headers']): string {
  const encoding = String(headers['content-encoding'] ?? '')
    .trim()
    .toLowerCase();
  let plain = bytes;
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip')
      plain = gunzipSync(bytes, { maxOutputLength: MAX_BYTES });
    else if (encoding === 'deflate') plain = inflateSync(bytes, { maxOutputLength: MAX_BYTES });
    else if (encoding === 'br') plain = brotliDecompressSync(bytes, { maxOutputLength: MAX_BYTES });
    else if (encoding && encoding !== 'identity')
      throw new SourceReaderError('来源使用了不支持的压缩格式');
  } catch (error) {
    if (error instanceof SourceReaderError) throw error;
    throw new SourceReaderError('来源压缩内容无效或解压后超过 2 MiB');
  }
  if (plain.length > MAX_BYTES) throw new SourceReaderError('来源内容超过 2 MiB');
  const sample = plain.subarray(0, 4096).toString('ascii');
  const charset =
    /charset\s*=\s*["']?([^\s;"'>]+)/i.exec(String(headers['content-type'] ?? ''))?.[1] ??
    /<\?xml[^>]+encoding\s*=\s*["']([^"']+)/i.exec(sample)?.[1] ??
    /<meta\b[^>]+charset\s*=\s*["']?([^\s;"'>]+)/i.exec(sample)?.[1] ??
    (plain[0] === 0xff && plain[1] === 0xfe
      ? 'utf-16le'
      : plain[0] === 0xfe && plain[1] === 0xff
        ? 'utf-16be'
        : 'utf-8');
  try {
    return new TextDecoder(charset, { fatal: true }).decode(plain);
  } catch {
    throw new SourceReaderError('来源文字编码不支持或内容损坏，无法提取');
  }
}

function boundedMarkup(value: string) {
  let elements = 0;
  const tags = /<[A-Za-z][^>]*>/g;
  while (tags.exec(value)) {
    if (++elements > MAX_ELEMENTS)
      throw new SourceReaderError('来源页面结构过于复杂，请换用原文或 RSS 链接');
  }
}

function cleanText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function boundedTitle(value: string): string {
  return cleanText(value)
    .slice(0, 500)
    .replace(/[\uD800-\uDBFF]$/, '');
}

function checkedText(value: string): string {
  const result = cleanText(value);
  if (result.length > MAX_TEXT)
    throw new SourceReaderError('来源正文超过 50000 字符，请选择较短的原文');
  if (/[\u0000\uD800-\uDFFF]/u.test(result)) throw new SourceReaderError('来源正文包含无效字符');
  return result;
}

function dateOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function htmlText(html: string, url: string) {
  boundedMarkup(html);
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() });
  try {
    for (const node of dom.window.document.querySelectorAll(
      'script,style,noscript,template,iframe,object,embed,svg',
    ))
      node.remove();
    for (const node of dom.window.document.querySelectorAll('br')) node.replaceWith('\n');
    for (const node of dom.window.document.querySelectorAll('p,div,li,h1,h2,h3,h4,blockquote'))
      node.append('\n');
    return checkedText(dom.window.document.body?.textContent ?? '');
  } finally {
    dom.window.close();
  }
}

export class SourceReader {
  private readonly testOrigin: string | undefined;
  private readonly resolve: Resolver;
  constructor(private readonly options: ReaderOptions = {}) {
    if (options.testOrigin) {
      const url = new URL(options.testOrigin);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        throw new SourceReaderError('测试来源只能是精确的本机环回来源');
      this.testOrigin = url.origin;
    }
    this.resolve = options.resolve ?? ((host) => dnsLookup(host, { all: true, verbatim: true }));
  }

  private testUrl(url: URL) {
    return Boolean(this.testOrigin && url.origin === this.testOrigin);
  }

  private validateUrl(url: URL) {
    if (!this.testUrl(url) && (url.port || !isPublicSourceHost(url.hostname)))
      throw new SourceReaderError('资料获取只允许公开网络的 HTTP 80 或 HTTPS 443 来源');
  }

  private async request(
    url: URL,
    kind: 'article' | 'feed',
    signal: AbortSignal,
  ): Promise<ResponseData> {
    this.validateUrl(url);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await resolveWithSignal(this.resolve, host, signal);
    assertActive(signal);
    if (
      !addresses.length ||
      addresses.some(
        (item) =>
          !isIP(item.address) ||
          (this.testUrl(url)
            ? !['127.0.0.1', '::1'].includes(item.address)
            : !publicAddress(item.address)),
      )
    )
      throw new SourceReaderError('来源解析到了不允许的本地、私有或特殊网络地址');
    const pinned = addresses.find((item) => item.family === 4) ?? addresses[0]!;
    return new Promise<ResponseData>((done, reject) => {
      let settled = false;
      const fail = (error: SourceReaderError) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const finish = (value: ResponseData) => {
        if (settled) return;
        settled = true;
        done(value);
      };
      const requester =
        this.options.request ?? (url.protocol === 'https:' ? httpsRequest : httpRequest);
      const request = requester(
        url,
        {
          method: 'GET',
          agent: false,
          signal,
          family: pinned.family,
          lookup: (_hostname, _options, callback) => callback(null, pinned.address, pinned.family),
          headers: {
            Accept:
              kind === 'article'
                ? 'text/html,application/xhtml+xml,text/plain'
                : 'application/rss+xml,application/atom+xml,application/xml,text/xml,text/plain',
            'Accept-Encoding': 'gzip, deflate, br',
            'User-Agent': 'Tattoo Source Reader/0.1',
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status)) {
            finish({ status, headers: response.headers, bytes: Buffer.alloc(0) });
            response.destroy();
            return;
          }
          try {
            if (status < 200 || status >= 300)
              throw new SourceReaderError(`来源返回 HTTP ${status}，请检查链接及访问权限`);
            permittedContentType(response.headers, kind);
            const declared = Number(response.headers['content-length']);
            if (declared > MAX_BYTES) throw new SourceReaderError('来源内容超过 2 MiB');
          } catch (error) {
            fail(
              error instanceof SourceReaderError ? error : new SourceReaderError('来源响应无效'),
            );
            response.destroy();
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_BYTES) {
              fail(new SourceReaderError('来源内容超过 2 MiB'));
              response.destroy();
            } else chunks.push(chunk);
          });
          response.once('aborted', () => fail(new SourceReaderError('来源响应中断，请重新获取')));
          response.once('error', () =>
            fail(signal.aborted ? abortError() : new SourceReaderError('来源响应中断，请重新获取')),
          );
          response.once('end', () =>
            finish({ status, headers: response.headers, bytes: Buffer.concat(chunks) }),
          );
        },
      );
      request.once('error', () =>
        fail(signal.aborted ? abortError() : new SourceReaderError('来源连接失败，请稍后重新获取')),
      );
      request.end();
    });
  }

  private async read(
    value: string,
    kind: 'article' | 'feed',
    signal: AbortSignal,
  ): Promise<ReadPage> {
    const input = normalizeSourceUrl(value);
    let current = input;
    for (let redirects = 0; redirects <= 3; redirects++) {
      assertActive(signal);
      const response = await this.request(new URL(current), kind, signal);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (redirects === 3 || !response.headers.location)
          throw new SourceReaderError('来源跳转次数过多或未提供有效目标');
        let next: string;
        try {
          next = new URL(response.headers.location, current).toString();
        } catch {
          throw new SourceReaderError('来源跳转目标无效');
        }
        current = normalizeSourceUrl(next);
        continue;
      }
      assertActive(signal);
      const text = decodeBody(response.bytes, response.headers);
      if (!text.trim()) throw new SourceReaderError('来源没有返回可读取的内容');
      return { url: input, resolvedUrl: current, text, contentType: mimeType(response.headers) };
    }
    throw new SourceReaderError('来源跳转次数过多');
  }

  async article(
    value: string,
    signal?: AbortSignal,
  ): Promise<{
    url: string;
    resolvedUrl: string;
    title: string;
    text: string;
    publishedAt: string | null;
  }> {
    const active = AbortSignal.any([
      AbortSignal.timeout(this.options.timeoutMs ?? TIMEOUT),
      ...(signal ? [signal] : []),
    ]);
    const page = await this.read(value, 'article', active);
    assertActive(active);
    if (page.contentType === 'text/plain') {
      return {
        url: page.url,
        resolvedUrl: page.resolvedUrl,
        title: new URL(page.resolvedUrl).hostname,
        text: checkedText(page.text),
        publishedAt: null,
      };
    }
    boundedMarkup(page.text);
    let dom: JSDOM | undefined;
    try {
      dom = new JSDOM(page.text, { url: page.resolvedUrl, virtualConsole: new VirtualConsole() });
      const document = dom.window.document;
      for (const node of document.querySelectorAll(
        'script,style,noscript,template,iframe,object,embed,svg',
      ))
        node.remove();
      for (const node of document.querySelectorAll('br')) node.replaceWith('\n');
      for (const node of document.querySelectorAll('p,div,li,h1,h2,h3,h4,blockquote'))
        node.append('\n');
      const publishedAt = dateOrNull(
        document
          .querySelector(
            'meta[property="article:published_time"],meta[name="datePublished"],time[datetime]',
          )
          ?.getAttribute('content') ??
          document.querySelector('time[datetime]')?.getAttribute('datetime'),
      );
      const parsed = new Readability(document, {
        maxElemsToParse: MAX_ELEMENTS,
        charThreshold: 80,
      }).parse();
      if (!parsed?.textContent?.trim())
        throw new SourceReaderError('页面没有可提取的正文；动态页面、登录页或付费内容可能无法读取');
      const text = checkedText(parsed.textContent);
      if (!text) throw new SourceReaderError('页面没有可提取的正文');
      const title =
        boundedTitle(parsed.title ?? document.title ?? '') || new URL(page.resolvedUrl).hostname;
      assertActive(active);
      return { url: page.url, resolvedUrl: page.resolvedUrl, title, text, publishedAt };
    } catch (error) {
      if (error instanceof SourceReaderError) throw error;
      throw new SourceReaderError('来源页面格式无效或无法提取正文');
    } finally {
      dom?.window.close();
    }
  }

  async feed(
    value: string,
    signal?: AbortSignal,
  ): Promise<{
    title: string;
    items: { url: string; title: string; text: string; publishedAt: string | null }[];
  }> {
    const active = AbortSignal.any([
      AbortSignal.timeout(this.options.timeoutMs ?? TIMEOUT),
      ...(signal ? [signal] : []),
    ]);
    const page = await this.read(value, 'feed', active);
    if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(page.text))
      throw new SourceReaderError('订阅内容包含不允许的 DTD 或实体声明');
    boundedMarkup(page.text);
    let parsed: Awaited<ReturnType<Parser['parseString']>>;
    try {
      parsed = await new Parser().parseString(page.text);
    } catch {
      throw new SourceReaderError('无法解析 RSS 或 Atom，请检查订阅地址');
    }
    const items: { url: string; title: string; text: string; publishedAt: string | null }[] = [];
    const seen = new Set<string>();
    for (const item of parsed.items) {
      assertActive(active);
      if (items.length === 20) break;
      if (!item.link) continue;
      let url: string;
      try {
        url = normalizeSourceUrl(new URL(item.link, page.resolvedUrl).toString());
        this.validateUrl(new URL(url));
      } catch {
        continue;
      }
      if (seen.has(url)) continue;
      seen.add(url);
      const raw = item['content:encoded'] ?? item.content ?? item.summary ?? '';
      const text = htmlText(typeof raw === 'string' ? raw : '', url);
      const title =
        boundedTitle(typeof item.title === 'string' ? item.title : '') || new URL(url).hostname;
      items.push({ url, title, text, publishedAt: dateOrNull(item.isoDate ?? item.pubDate) });
    }
    assertActive(active);
    return {
      title: boundedTitle(parsed.title ?? '') || new URL(page.resolvedUrl).hostname,
      items,
    };
  }
}
