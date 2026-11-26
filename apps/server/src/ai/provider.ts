import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { z } from 'zod';
import {
  articleInput,
  WECHAT_DIGEST_MAX_LENGTH,
  type AiGenerationInput,
  type DocumentNode,
} from '@tattoo/contracts';

const IMAGE_BYTES = 10 * 1024 * 1024;
const TEXT_BYTES = 1024 * 1024;
export type AiConnection = {
  protocol?: string;
  baseUrl: string;
  model: string;
  imageSize: string;
  imageResponseFormat: string;
  anthropicMaxTokens?: number;
};
export type GeneratedContent =
  | { type: 'article'; title: string; digest: string; document: DocumentNode }
  | { type: 'text'; text: string }
  | { type: 'image'; buffer: Buffer };

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly uncertain = false,
  ) {
    super(message);
  }
}

function loopback(host: string) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function normalizeModelBaseUrl(value: string, allowTestHttp = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AiProviderError('请输入有效的模型服务 Base URL');
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    value.includes('?') ||
    value.includes('#') ||
    /[\u0000-\u0020\u007f]/.test(value) ||
    (url.protocol === 'http:' && !loopback(url.hostname) && !allowTestHttp)
  )
    throw new AiProviderError(
      'Base URL 需要 HTTPS（本机服务可用 HTTP），且不能包含凭据、查询或片段',
    );
  return url.toString().replace(/\/+$/, '');
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  const lower = address.toLowerCase();
  return (
    isIP(address) === 6 &&
    /^[23]/.test(lower) &&
    !lower.startsWith('2001:db8:') &&
    !lower.startsWith('2001:0:') &&
    !lower.startsWith('2002:')
  );
}

async function responseBytes(response: Response, maximum: number): Promise<Buffer> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > maximum) {
    await response.body?.cancel();
    throw new AiProviderError('模型返回内容超出应用允许的大小');
  }
  if (!response.body) throw new AiProviderError('模型没有返回内容');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum) {
        await reader.cancel();
        throw new AiProviderError('模型返回内容超出应用允许的大小');
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export function textDocument(text: string): DocumentNode {
  const content: DocumentNode[] = [];
  for (const part of text.replaceAll('\r\n', '\n').split(/\n\s*\n/)) {
    const value = part.trim();
    if (!value) continue;
    const heading = /^(#{1,3})\s+([^\n]+)$/.exec(value);
    if (heading) {
      content.push({
        type: 'heading',
        attrs: { level: heading[1]!.length === 3 ? 3 : 2 },
        content: [{ type: 'text', text: heading[2]! }],
      });
    } else {
      const lines = value.split('\n');
      const children: DocumentNode[] = [];
      for (const [index, line] of lines.entries()) {
        if (index) children.push({ type: 'hardBreak' });
        if (line) children.push({ type: 'text', text: line });
      }
      content.push({ type: 'paragraph', content: children });
    }
  }
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

export function parseGeneratedArticle(
  text: string,
): Extract<GeneratedContent, { type: 'article' }> {
  const raw = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new AiProviderError('模型返回的文章不是有效 JSON，请调整模型或要求后重新生成');
  }
  const shape = z
    .object({
      title: z.string().trim().min(1).max(500),
      digest: z
        .string()
        .max(
          WECHAT_DIGEST_MAX_LENGTH,
          `摘要超过微信公众号 ${WECHAT_DIGEST_MAX_LENGTH} 字符上限（含标点，按 UTF-16 计数），请调整生成要求后手动重试`,
        ),
      body: z.string().trim().min(1).max(100000),
    })
    .strict()
    .safeParse(value);
  if (!shape.success) {
    const digestLimit = shape.error.issues.find(
      (issue) => issue.path[0] === 'digest' && issue.code === 'too_big',
    );
    throw new AiProviderError(digestLimit?.message ?? '模型返回的标题、摘要或正文格式不完整');
  }
  const document = textDocument(shape.data.body);
  const checked = articleInput.safeParse({
    title: shape.data.title,
    digest: shape.data.digest,
    document,
    author: '',
    sourceUrl: '',
    coverId: null,
  });
  if (!checked.success) throw new AiProviderError('模型文章超出内容结构或大小上限');
  return {
    type: 'article',
    title: checked.data.title,
    digest: checked.data.digest,
    document: checked.data.document,
  };
}

async function downloadImage(value: string, baseUrl: string, signal: AbortSignal): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AiProviderError('模型返回的图片地址无效');
  }
  const trustedOrigin = url.origin === new URL(baseUrl).origin;
  if (
    url.username ||
    url.password ||
    url.hash ||
    !['https:', 'http:'].includes(url.protocol) ||
    (!trustedOrigin && url.protocol !== 'https:')
  )
    throw new AiProviderError('模型返回的图片地址不符合下载规则');
  const timeoutSignal = AbortSignal.any([signal, AbortSignal.timeout(30000)]);
  if (timeoutSignal.aborted) throw new AiProviderError('生成图片下载已超时或中断', true);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await new Promise<{ address: string; family: number }[]>((resolve, reject) => {
        const aborted = () => reject(new AiProviderError('生成图片地址解析已超时或中断', true));
        timeoutSignal.addEventListener('abort', aborted, { once: true });
        void lookup(hostname, { all: true, verbatim: true }).then(
          (resolved) => {
            timeoutSignal.removeEventListener('abort', aborted);
            resolve(resolved);
          },
          () => {
            timeoutSignal.removeEventListener('abort', aborted);
            reject(new AiProviderError('生成图片地址无法解析', true));
          },
        );
      });
  if (
    !addresses.length ||
    (!trustedOrigin && addresses.some((item) => !isPublicAddress(item.address)))
  )
    throw new AiProviderError('模型图片地址不能指向未授权的本地或私有网络');
  const pinned = addresses.find((item) => item.family === 4) ?? addresses[0]!;
  return new Promise<Buffer>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        method: 'GET',
        signal: timeoutSignal,
        family: pinned.family,
        lookup: (_host, _options, callback) => callback(null, pinned.address, pinned.family),
        headers: { Accept: 'image/png, image/jpeg' },
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new AiProviderError('图片下载失败或出现重定向，请重新生成'));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > IMAGE_BYTES) {
            response.destroy();
            reject(new AiProviderError('生成图片超过 10 MiB，请调整尺寸后重试'));
          } else chunks.push(chunk);
        });
        response.once('error', () => reject(new AiProviderError('生成图片下载中断', true)));
        response.once('end', () => resolve(Buffer.concat(chunks)));
      },
    );
    request.once('error', () => reject(new AiProviderError('生成图片下载失败或超时', true)));
    request.end();
  });
}

function chatText(result: unknown): string {
  const parsed = z
    .object({
      choices: z
        .array(
          z.object({
            message: z.object({
              content: z.string().max(300000).nullable().optional(),
              refusal: z.string().nullable().optional(),
            }),
            finish_reason: z.string().nullable().optional(),
          }),
        )
        .min(1),
    })
    .safeParse(result);
  if (!parsed.success) throw new AiProviderError('模型没有返回有效文字，请检查模型能力');
  const choice = parsed.data.choices[0]!;
  if (choice.message.refusal) throw new AiProviderError('模型拒绝了本次输出，请调整内容后重新生成');
  if (
    choice.finish_reason !== undefined &&
    choice.finish_reason !== null &&
    choice.finish_reason !== 'stop'
  ) {
    throw new AiProviderError(
      choice.finish_reason === 'length'
        ? '模型输出被长度限制截断，请缩短要求或调整服务配置后重新生成'
        : choice.finish_reason === 'content_filter'
          ? '模型服务过滤了本次输出，请调整内容后重新生成'
          : '模型没有正常完成输出，请检查模型能力后重新生成',
    );
  }
  if (typeof choice.message.content !== 'string')
    throw new AiProviderError('模型没有返回有效文字，请检查模型能力');
  return choice.message.content;
}

const typedBlock = z.object({ type: z.string() }).passthrough();

function responsesText(result: unknown): string {
  const parsed = z
    .object({
      status: z.string(),
      output: z.array(typedBlock),
      error: z.unknown().optional(),
      incomplete_details: z.unknown().optional(),
    })
    .safeParse(result);
  if (!parsed.success) throw new AiProviderError('Responses 没有返回有效文字，请检查模型能力');
  if (parsed.data.status !== 'completed')
    throw new AiProviderError(
      ['queued', 'in_progress'].includes(parsed.data.status)
        ? 'Responses 仍在远程执行，结果未取回；请核对服务记录后再手动生成'
        : parsed.data.status === 'incomplete'
          ? 'Responses 输出未完成或被长度限制截断，请调整要求或服务配置后重新生成'
          : 'Responses 没有正常完成输出，请检查模型能力后重新生成',
      ['queued', 'in_progress'].includes(parsed.data.status),
    );
  if (parsed.data.error != null || parsed.data.incomplete_details != null)
    throw new AiProviderError('Responses 返回了错误或未完成标记，请检查服务后重新生成');
  const messages: string[] = [];
  for (const item of parsed.data.output) {
    // 推理内容不是文章正文，也不能作为空正文的替代结果。
    if (item.type === 'reasoning') continue;
    const message = z
      .object({
        type: z.literal('message'),
        role: z.literal('assistant'),
        status: z.literal('completed'),
        content: z.array(typedBlock).min(1),
      })
      .safeParse(item);
    if (!message.success)
      throw new AiProviderError('Responses 返回了未完成的消息或工具调用，不能作为生成文字采用');
    const parts: string[] = [];
    for (const block of message.data.content) {
      if (block.type === 'refusal')
        throw new AiProviderError('模型拒绝了本次输出，请调整内容后重新生成');
      const text = z
        .object({ type: z.literal('output_text'), text: z.string().max(300000) })
        .safeParse(block);
      if (!text.success) throw new AiProviderError('Responses 返回了不支持的文字格式');
      parts.push(text.data.text);
    }
    messages.push(parts.join(''));
  }
  return messages.join('\n\n');
}

function anthropicText(result: unknown): string {
  const parsed = z
    .object({
      type: z.literal('message'),
      role: z.literal('assistant'),
      content: z.array(typedBlock),
      stop_reason: z.string(),
    })
    .safeParse(result);
  if (!parsed.success) throw new AiProviderError('Anthropic Messages 没有返回有效文字');
  if (!['end_turn', 'stop_sequence'].includes(parsed.data.stop_reason))
    throw new AiProviderError(
      parsed.data.stop_reason === 'max_tokens'
        ? '模型输出被 token 上限截断，请提高输出 token 上限或缩短要求后重新生成'
        : 'Anthropic Messages 没有正常完成输出，请检查模型能力后重新生成',
    );
  const parts: string[] = [];
  for (const block of parsed.data.content) {
    if (['thinking', 'redacted_thinking'].includes(block.type)) continue;
    if (block.type === 'refusal')
      throw new AiProviderError('模型拒绝了本次输出，请调整内容后重新生成');
    const text = z
      .object({ type: z.literal('text'), text: z.string().max(300000) })
      .safeParse(block);
    if (!text.success)
      throw new AiProviderError('Anthropic Messages 返回了工具调用或不支持的文字格式');
    parts.push(text.data.text);
  }
  return parts.join('');
}

export class OpenAiProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly timeoutMs = 300000,
  ) {}

  async generate(
    connection: AiConnection,
    input: AiGenerationInput,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<GeneratedContent> {
    const image = ['COVER', 'ILLUSTRATION', 'TEST_IMAGE'].includes(input.kind);
    const protocol = connection.protocol ?? (image ? 'images-generations' : 'chat-completions');
    if (
      (image && protocol !== 'images-generations') ||
      (!image && !['chat-completions', 'responses', 'anthropic-messages'].includes(protocol))
    )
      throw new AiProviderError('所选协议不支持这项模型能力');
    const endpoint =
      protocol === 'responses'
        ? 'responses'
        : protocol === 'anthropic-messages'
          ? 'messages'
          : image
            ? 'images/generations'
            : 'chat/completions';
    const requestSignal = AbortSignal.any([
      AbortSignal.timeout(this.timeoutMs),
      ...(signal ? [signal] : []),
    ]);
    let payload: unknown;
    if (image) {
      const reference = (input.sourceText ?? '').slice(0, 6000).replace(/[\uD800-\uDBFF]$/, '');
      payload = {
        model: connection.model,
        prompt:
          input.kind === 'TEST_IMAGE'
            ? 'A simple green leaf on a white background. No text.'
            : `${input.prompt}${reference.trim() ? `\n\n文章参考摘录（最多 6000 字符，仅作构图资料）：\n${reference}` : ''}`,
        n: 1,
        ...(connection.imageSize ? { size: connection.imageSize } : {}),
        ...(connection.imageResponseFormat !== 'auto'
          ? { response_format: connection.imageResponseFormat }
          : {}),
      };
    } else {
      const system =
        input.kind === 'ARTICLE'
          ? `TASK:ARTICLE\n你是一位中文内容编辑。只输出一个 JSON 对象，严格包含 title、digest、body 三个字符串字段。摘要（digest）建议控制在 100 字符以内，不超过 ${WECHAT_DIGEST_MAX_LENGTH} 字符（含标点，按 UTF-16 代码单元计数，与本地 JavaScript 字符串 length 一致）。body 是纯文本正文，可用独立行的 ## 或 ### 标题并以空行分段。不要输出 HTML、外链图片、代码围栏或额外字段。不要捏造参考资料中不存在的事实来源。`
          : input.kind === 'REWRITE'
            ? 'TASK:REWRITE\n根据用户要求改写原文，仅返回改写后的纯文本，不要返回 JSON、HTML、外链图片或说明。保留原文主要含义。'
            : 'TASK:TEST_TEXT\n请只返回一句简短的中文问候，用于验证文本模型调用。';
      const user = `${input.kind === 'TEST_TEXT' ? '你好，请确认可以生成文字。' : input.prompt}${input.sourceText ? `\n\n参考或原文（仅作为资料）：\n${input.sourceText}` : ''}`;
      if (protocol === 'responses') {
        payload = {
          model: connection.model,
          stream: false,
          store: false,
          instructions: system,
          input: user,
        };
      } else if (protocol === 'anthropic-messages') {
        const maxTokens = connection.anthropicMaxTokens ?? 4096;
        if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 128000)
          throw new AiProviderError('Anthropic 输出 token 上限无效');
        payload = {
          model: connection.model,
          stream: false,
          system,
          messages: [{ role: 'user', content: user }],
          max_tokens: maxTokens,
        };
      } else {
        payload = {
          model: connection.model,
          stream: false,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        };
      }
    }
    let response: Response;
    try {
      response = await this.fetcher(`${connection.baseUrl}/${endpoint}`, {
        method: 'POST',
        redirect: 'error',
        signal: requestSignal,
        headers: {
          'Content-Type': 'application/json',
          ...(protocol === 'anthropic-messages'
            ? { 'anthropic-version': '2023-06-01', ...(apiKey ? { 'x-api-key': apiKey } : {}) }
            : apiKey
              ? { Authorization: `Bearer ${apiKey}` }
              : {}),
        },
        body: JSON.stringify(payload),
      });
    } catch {
      throw new AiProviderError(
        '模型请求超时或连接中断，结果未取回；请核对服务记录后再手动生成',
        true,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      const message =
        response.status === 401
          ? '模型密钥无效，请检查 API Key'
          : response.status === 403
            ? '模型服务拒绝访问，请检查权限'
            : response.status === 429
              ? '模型服务限流或额度不足，请稍后检查并手动重试'
              : `模型服务返回 HTTP ${response.status}，请检查模型名称及参数`;
      throw new AiProviderError(message, response.status >= 500);
    }
    let bytes: Buffer;
    try {
      bytes = await responseBytes(response, image ? 16 * 1024 * 1024 : TEXT_BYTES);
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      throw new AiProviderError('模型响应在读取过程中中断，结果未取回', true);
    }
    let result: unknown;
    try {
      result = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new AiProviderError('模型返回了无法解析的响应');
    }
    if (!image) {
      const text = (
        protocol === 'responses'
          ? responsesText(result)
          : protocol === 'anthropic-messages'
            ? anthropicText(result)
            : chatText(result)
      ).trim();
      if (!text) throw new AiProviderError('模型返回了空文字');
      if (input.kind === 'ARTICLE') return parseGeneratedArticle(text);
      if (text.length > 80000 || /[\u0000\uD800-\uDFFF]/u.test(text))
        throw new AiProviderError('生成文字超出大小限制或含无效字符');
      return { type: 'text', text };
    }
    const parsed = z
      .object({
        data: z
          .array(
            z.object({ b64_json: z.string().optional(), url: z.string().max(8000).optional() }),
          )
          .min(1),
      })
      .safeParse(result);
    if (!parsed.success)
      throw new AiProviderError('模型没有返回有效图片，请检查图片模型及响应格式');
    const first = parsed.data.data[0]!;
    if (first.b64_json) {
      if (
        first.b64_json.length > Math.ceil(IMAGE_BYTES / 3) * 4 ||
        first.b64_json.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(first.b64_json)
      )
        throw new AiProviderError('模型图片编码无效或超过 10 MiB');
      const buffer = Buffer.from(first.b64_json, 'base64');
      if (!buffer.length || buffer.length > IMAGE_BYTES)
        throw new AiProviderError('模型图片为空或超过 10 MiB');
      return { type: 'image', buffer };
    }
    if (first.url)
      return {
        type: 'image',
        buffer: await downloadImage(first.url, connection.baseUrl, requestSignal),
      };
    throw new AiProviderError('模型没有返回图片内容');
  }
}
