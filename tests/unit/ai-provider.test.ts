import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  aiGenerationInput,
  aiModelInput,
  articleInput,
  type AiGenerationInput,
} from '../../packages/contracts/src';
import {
  AiProviderError,
  isPublicAddress,
  normalizeModelBaseUrl,
  OpenAiProvider,
  parseGeneratedArticle,
  textDocument,
} from '../../apps/server/src/ai/provider';

const connection = {
  baseUrl: 'https://models.example/v1',
  model: 'configured-model',
  imageSize: '',
  imageResponseFormat: 'auto',
};
const key = 'test-api-key-do-not-return';
const input = (kind: AiGenerationInput['kind'] = 'ARTICLE'): AiGenerationInput => ({
  requestKey: randomUUID(),
  kind,
  prompt: '介绍本地内容创作',
  sourceText: '可用参考资料',
});
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const completion = (content: string) => json({ choices: [{ message: { content } }] });
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aMfkAAAAASUVORK5CYII=',
  'base64',
);

describe('AI 接口请求、生成结果与凭据保护', () => {
  it('文章生成使用配置的模型和后端密钥，不强制服务商特有 JSON 参数', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      completion(
        JSON.stringify({
          title: '生成标题',
          digest: '生成摘要',
          body: '## 小节\n\n第一段\n第二行',
        }),
      ),
    );
    const result = await new OpenAiProvider(fetcher).generate(connection, input(), key);
    expect(result).toMatchObject({ type: 'article', title: '生成标题', digest: '生成摘要' });
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://models.example/v1/chat/completions');
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${key}` },
    });
    const sent = JSON.parse(String(request?.body));
    expect(sent.model).toBe('configured-model');
    expect(sent.stream).toBe(false);
    expect(sent.response_format).toBeUndefined();
    expect(sent.messages[0].content).toContain('TASK:ARTICLE');
    expect(sent.messages[1].content).toContain('可用参考资料');
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it('改写与文本验证分别返回纯文字，且无密钥的本地服务不发送 Authorization', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => completion('新的表达'));
    const provider = new OpenAiProvider(fetcher);
    expect(await provider.generate(connection, input('REWRITE'), '')).toEqual({
      type: 'text',
      text: '新的表达',
    });
    expect(await provider.generate(connection, input('TEST_TEXT'), '')).toEqual({
      type: 'text',
      text: '新的表达',
    });
    expect(fetcher.mock.calls[0]![1]?.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).messages[0].content).toContain(
      'TASK:REWRITE',
    );
    expect(JSON.parse(String(fetcher.mock.calls[1]![1]?.body)).messages[0].content).toContain(
      'TASK:TEST_TEXT',
    );
  });

  it('图片 auto 省略 response_format 和空尺寸，保留服务返回的二进制图片', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ data: [{ b64_json: png.toString('base64') }] }));
    const result = await new OpenAiProvider(fetcher).generate(connection, input('COVER'), key);
    expect(result).toEqual({ type: 'image', buffer: png });
    expect(fetcher.mock.calls[0]![0]).toBe('https://models.example/v1/images/generations');
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({
      model: 'configured-model',
      prompt: '介绍本地内容创作\n\n文章参考摘录（最多 6000 字符，仅作构图资料）：\n可用参考资料',
      n: 1,
    });
  });

  it('图片使用有界文章参考，截断不产生半个 Unicode 字符，验证仍是固定小请求', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json({ data: [{ b64_json: png.toString('base64') }] }));
    const provider = new OpenAiProvider(fetcher);
    const sourceText = 'a'.repeat(5999) + '🌿尾段不应进入摘录';
    await provider.generate(connection, { ...input('ILLUSTRATION'), sourceText }, key);
    await provider.generate(connection, { ...input('TEST_IMAGE'), sourceText }, key);
    const prompt = JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).prompt as string;
    expect(prompt).toContain('a'.repeat(5999));
    expect(prompt).not.toContain('尾段');
    expect(/[\uD800-\uDFFF]/u.test(prompt)).toBe(false);
    const testPrompt = JSON.parse(String(fetcher.mock.calls[1]![1]?.body)).prompt as string;
    expect(testPrompt).toBe('A simple green leaf on a white background. No text.');
  });

  it.each(['length', 'content_filter', 'tool_calls', ''])(
    '明确未完成的 %s 文字不能作为完整改写采用',
    async (finish_reason) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          json({ choices: [{ finish_reason, message: { content: '只完成前半句' } }] }),
        );
      await expect(
        new OpenAiProvider(fetcher).generate(connection, input('REWRITE'), key),
      ).rejects.toMatchObject({ uncertain: false });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('正常完成或未提供完成原因的兼容接口仍可生成文字', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({ choices: [{ finish_reason: 'stop', message: { content: '完整句子' } }] }),
      )
      .mockResolvedValueOnce(completion('兼容接口完整句子'));
    const provider = new OpenAiProvider(fetcher);
    expect(await provider.generate(connection, input('REWRITE'), key)).toEqual({
      type: 'text',
      text: '完整句子',
    });
    expect(await provider.generate(connection, input('REWRITE'), key)).toEqual({
      type: 'text',
      text: '兼容接口完整句子',
    });
  });

  it('只按明确配置发送图片尺寸和响应格式，不按模型名称猜测', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ data: [{ b64_json: png.toString('base64') }] }));
    await new OpenAiProvider(fetcher).generate(
      { ...connection, imageSize: '1536x1024', imageResponseFormat: 'b64_json' },
      input('ILLUSTRATION'),
      key,
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({
      size: '1536x1024',
      response_format: 'b64_json',
      n: 1,
    });
  });

  it.each([401, 403, 429, 500])(
    'HTTP %s 的原始错误不会泄露 Key，且不会自动重试',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ error: { message: `Bearer ${key} prompt=private` } }, status));
      let failed: unknown;
      try {
        await new OpenAiProvider(fetcher).generate(connection, input(), key);
      } catch (error) {
        failed = error;
      }
      expect(failed).toBeInstanceOf(AiProviderError);
      expect(String(failed)).not.toContain(key);
      expect(String(failed)).not.toContain('prompt=private');
      expect((failed as AiProviderError).uncertain).toBe(status >= 500);
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it('连接中断和超时保留未取回结果，不自动重试收费请求', async () => {
    const broken = vi.fn<typeof fetch>().mockRejectedValue(new Error(`connection failed ${key}`));
    await expect(
      new OpenAiProvider(broken).generate(connection, input(), key),
    ).rejects.toMatchObject({ uncertain: true });
    expect(broken).toHaveBeenCalledTimes(1);
    const waiting = vi.fn<typeof fetch>().mockImplementation(
      (_url, request) =>
        new Promise((_resolve, reject) => {
          request?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
        }),
    );
    await expect(
      new OpenAiProvider(waiting, 10).generate(connection, input(), key),
    ).rejects.toMatchObject({ uncertain: true });
    expect(waiting).toHaveBeenCalledTimes(1);
  });

  it.each(['not-json', '{"choices":[]}', '{"choices":[{"message":{"content":null}}]}'])(
    '损坏响应 %s 明确失败',
    async (value) => {
      const provider = new OpenAiProvider(
        vi.fn<typeof fetch>().mockResolvedValue(new Response(value)),
      );
      await expect(provider.generate(connection, input(), key)).rejects.toMatchObject({
        uncertain: false,
      });
    },
  );

  it('流式响应超限在读取中停止，不能仅信任 Content-Length', async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
      },
      cancel() {
        canceled = true;
      },
    });
    const provider = new OpenAiProvider(
      vi.fn<typeof fetch>().mockResolvedValue(new Response(stream)),
    );
    await expect(provider.generate(connection, input(), key)).rejects.toThrow('超出');
    expect(canceled).toBe(true);
  });

  it('声明超限的响应不会读取正文', async () => {
    let canceled = false;
    const stream = new ReadableStream({
      cancel() {
        canceled = true;
      },
    });
    const provider = new OpenAiProvider(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(stream, { headers: { 'Content-Length': String(2 * 1024 * 1024) } }),
        ),
    );
    await expect(provider.generate(connection, input(), key)).rejects.toThrow('超出');
    expect(canceled).toBe(true);
  });

  it.each(['', '@@@@', 'a===', 'abcd=efg'])(
    '无效图片编码 %s 不会被作为素材采用',
    async (b64_json) => {
      const provider = new OpenAiProvider(
        vi.fn<typeof fetch>().mockResolvedValue(json({ data: [{ b64_json }] })),
      );
      await expect(provider.generate(connection, input('COVER'), key)).rejects.toBeInstanceOf(
        AiProviderError,
      );
    },
  );

  it('超大图片编码在解码前拒绝', async () => {
    const provider = new OpenAiProvider(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ data: [{ b64_json: 'a'.repeat(14 * 1024 * 1024) }] })),
    );
    await expect(provider.generate(connection, input('COVER'), key)).rejects.toThrow('10 MiB');
  });
});

describe('Responses 与 Anthropic Messages 文本协议', () => {
  const responses = (text: string, overrides: Record<string, unknown> = {}) => ({
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      },
    ],
    ...overrides,
  });
  const message = (text: string, overrides: Record<string, unknown> = {}) => ({
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    ...overrides,
  });
  const article = JSON.stringify({ title: '多协议文章', digest: '统一编辑流程', body: '完整正文' });

  it('Responses 使用独立端点、instructions 和原始 output 数组，不存储远程对话', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(responses(article)));
    const result = await new OpenAiProvider(fetcher).generate(
      { ...connection, protocol: 'responses' },
      input(),
      key,
    );
    expect(result).toMatchObject({ type: 'article', title: '多协议文章' });
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://models.example/v1/responses');
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { Authorization: `Bearer ${key}` },
    });
    const body = JSON.parse(String(request?.body));
    expect(body).toEqual({
      model: 'configured-model',
      stream: false,
      store: false,
      instructions: expect.stringContaining('TASK:ARTICLE'),
      input: expect.stringContaining('可用参考资料'),
    });
    expect(JSON.stringify(body)).not.toContain(key);
  });

  it('Responses 只合并完整 assistant 消息的 output_text，不采用推理摘要', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        status: 'completed',
        output: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: '私有推理' }] },
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [
              { type: 'output_text', text: '新的' },
              { type: 'output_text', text: '表达' },
            ],
          },
        ],
      }),
    );
    expect(
      await new OpenAiProvider(fetcher).generate(
        { ...connection, protocol: 'responses' },
        input('REWRITE'),
        '',
      ),
    ).toEqual({ type: 'text', text: '新的表达' });
    expect(fetcher.mock.calls[0]![1]?.headers).not.toHaveProperty('Authorization');
  });

  it.each(['incomplete', 'failed', 'cancelled'])(
    'Responses %s 不能伪装成完整文章',
    async (status) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(responses(article, { status })));
      await expect(
        new OpenAiProvider(fetcher).generate(
          { ...connection, protocol: 'responses' },
          input(),
          key,
        ),
      ).rejects.toMatchObject({ uncertain: false });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['in_progress', 'queued'])(
    'Responses %s 仍可能在远程执行，应标记结果未取回且不自动重发',
    async (status) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json(responses('', { status, output: [] })));
      await expect(
        new OpenAiProvider(fetcher).generate(
          { ...connection, protocol: 'responses' },
          input(),
          key,
        ),
      ).rejects.toMatchObject({ uncertain: true });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { error: { message: `private ${key}` } },
    { incomplete_details: { reason: 'max_output_tokens' } },
    { output: [{ type: 'function_call', name: 'tool', arguments: '{}' }] },
    { output: [{ type: 'reasoning', summary: [{ text: '只有推理' }] }] },
    { output: [], output_text: 'SDK 便利字段不能替代真实消息' },
    {
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'incomplete',
          content: [{ type: 'output_text', text: '半句话' }],
        },
      ],
    },
    {
      output: [
        {
          type: 'message',
          role: 'user',
          status: 'completed',
          content: [{ type: 'output_text', text: '回显输入' }],
        },
      ],
    },
    {
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            { type: 'output_text', text: '有文字也不能忽略拒绝' },
            { type: 'refusal', refusal: 'private refusal detail' },
          ],
        },
      ],
    },
  ])('Responses 的工具调用、未完成消息和拒绝必须失败：%j', async (overrides) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(responses('文字', overrides)));
    await expect(
      new OpenAiProvider(fetcher).generate(
        { ...connection, protocol: 'responses' },
        input('REWRITE'),
        key,
      ),
    ).rejects.toMatchObject({ uncertain: false });
  });

  it('Anthropic 使用顶层 system、user 消息、x-api-key 和明确版本及 token 上限', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(message(article)));
    const result = await new OpenAiProvider(fetcher).generate(
      { ...connection, protocol: 'anthropic-messages', anthropicMaxTokens: 8192 },
      input(),
      key,
    );
    expect(result).toMatchObject({ type: 'article', title: '多协议文章' });
    const [url, request] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://models.example/v1/messages');
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    expect(request?.headers).not.toHaveProperty('Authorization');
    const body = JSON.parse(String(request?.body));
    expect(body).toEqual({
      model: 'configured-model',
      stream: false,
      max_tokens: 8192,
      system: expect.stringContaining('TASK:ARTICLE'),
      messages: [{ role: 'user', content: expect.stringContaining('可用参考资料') }],
    });
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it('Anthropic 验证默认使用 4096 token，无密钥服务仍发送版本头，文字不包含 thinking', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json(
        message('', {
          content: [
            { type: 'thinking', thinking: '私有推理', signature: 'signed' },
            { type: 'redacted_thinking', data: 'private' },
            { type: 'text', text: '你' },
            { type: 'text', text: '好' },
          ],
          stop_reason: 'stop_sequence',
        }),
      ),
    );
    expect(
      await new OpenAiProvider(fetcher).generate(
        { ...connection, protocol: 'anthropic-messages' },
        input('TEST_TEXT'),
        '',
      ),
    ).toEqual({ type: 'text', text: '你好' });
    const request = fetcher.mock.calls[0]![1]!;
    expect(request.headers).not.toHaveProperty('x-api-key');
    expect(request.headers).not.toHaveProperty('Authorization');
    const body = JSON.parse(String(request.body));
    expect(body.max_tokens).toBe(4096);
    expect(body.system).toContain('TASK:TEST_TEXT');
  });

  it.each(['max_tokens', 'tool_use', 'refusal', 'pause_turn', '', null])(
    'Anthropic 停止原因 %s 不能作为完整改写采用',
    async (stop_reason) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(json(message('半句话', { stop_reason })));
      await expect(
        new OpenAiProvider(fetcher).generate(
          { ...connection, protocol: 'anthropic-messages' },
          input('REWRITE'),
          key,
        ),
      ).rejects.toMatchObject({ uncertain: false });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { content: [{ type: 'tool_use', name: 'tool', input: {} }] },
    {
      content: [
        { type: 'text', text: '部分文字' },
        { type: 'refusal', text: 'private' },
      ],
    },
    { content: [{ type: 'thinking', thinking: '只有推理' }] },
    { content: [{ type: 'text', text: 123 }] },
    { type: 'error', error: { message: `private ${key}` } },
    { role: 'user' },
  ])('Anthropic 的工具调用和损坏内容不会进入正文：%j', async (overrides) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(message('文字', overrides)));
    await expect(
      new OpenAiProvider(fetcher).generate(
        { ...connection, protocol: 'anthropic-messages' },
        input('REWRITE'),
        key,
      ),
    ).rejects.toMatchObject({ uncertain: false });
  });

  it.each(['responses', 'anthropic-messages'])(
    '%s 共用输出字符限制、脱敏错误和中断语义，不自动重发',
    async (protocol) => {
      const make = protocol === 'responses' ? responses : message;
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json(make('\ud800')))
        .mockResolvedValueOnce(json(make('字'.repeat(80001))))
        .mockResolvedValueOnce(json({ error: { message: `private ${key}` } }, 429));
      const provider = new OpenAiProvider(fetcher);
      for (let index = 0; index < 3; index++) {
        await expect(
          provider.generate({ ...connection, protocol }, input('REWRITE'), key),
        ).rejects.toMatchObject({ uncertain: false });
      }
      expect(fetcher).toHaveBeenCalledTimes(3);
      const waiting = vi.fn<typeof fetch>().mockImplementation(
        (_url, request) =>
          new Promise((_resolve, reject) => {
            request?.signal?.addEventListener('abort', () => reject(new Error(`private ${key}`)), {
              once: true,
            });
          }),
      );
      const abort = new AbortController();
      const execution = new OpenAiProvider(waiting).generate(
        { ...connection, protocol },
        input('REWRITE'),
        key,
        abort.signal,
      );
      abort.abort();
      await expect(execution).rejects.toMatchObject({ uncertain: true });
      expect(waiting).toHaveBeenCalledTimes(1);
    },
  );

  it('未知协议和能力不匹配在发请求前拒绝', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = new OpenAiProvider(fetcher);
    await expect(
      provider.generate({ ...connection, protocol: 'unknown' }, input(), key),
    ).rejects.toThrow('协议');
    await expect(
      provider.generate({ ...connection, protocol: 'responses' }, input('COVER'), key),
    ).rejects.toThrow('协议');
    await expect(
      provider.generate({ ...connection, protocol: 'images-generations' }, input(), key),
    ).rejects.toThrow('协议');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('AI 文章摘要的微信长度约束', () => {
  const protocols = ['chat-completions', 'responses', 'anthropic-messages'] as const;
  const article = (digest: string) =>
    JSON.stringify({ title: '摘要长度回归', digest, body: '完整正文需要保留。' });
  function response(protocol: (typeof protocols)[number], digest: string) {
    const content = article(digest);
    if (protocol === 'responses')
      return json({
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: content }],
          },
        ],
      });
    if (protocol === 'anthropic-messages')
      return json({
        type: 'message',
        role: 'assistant',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: content }],
      });
    return completion(content);
  }

  it.each(protocols)('%s 的文章请求明确提示摘要上限、建议长度和标点计数', async (protocol) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(protocol, '可采用的短摘要。'));
    await new OpenAiProvider(fetcher).generate({ ...connection, protocol }, input(), key);
    const sent = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    const instructions: string =
      protocol === 'responses'
        ? sent.instructions
        : protocol === 'anthropic-messages'
          ? sent.system
          : sent.messages.find((message: { role: string }) => message.role === 'system').content;
    expect(instructions).toContain('摘要');
    expect(instructions).toMatch(
      /(?:不超过|上限)[^。；\n]{0,12}120|120[^。；\n]{0,12}(?:上限|以内)/,
    );
    expect(instructions).toMatch(/建议[^。；\n]{0,20}100[^。；\n]{0,8}(?:以内|内)/);
    expect(instructions).toContain('含标点');
  });

  it.each([
    { label: '中文与标点', accepted: '摘'.repeat(119) + '。', rejected: '摘'.repeat(120) + '。' },
    { label: '成对 emoji', accepted: '🌿'.repeat(60), rejected: '🌿'.repeat(60) + '！' },
    { label: '中文与 emoji', accepted: '摘'.repeat(118) + '🌿', rejected: '摘'.repeat(119) + '🌿' },
  ])(
    '$label 按 UTF-16 接受完整 120 单位摘要，121 单位明确拒绝且不截断',
    ({ accepted, rejected }) => {
      expect(accepted.length).toBe(120);
      expect(rejected.length).toBe(121);
      expect(parseGeneratedArticle(article(accepted))).toMatchObject({
        type: 'article',
        digest: accepted,
      });
      expect(() => parseGeneratedArticle(article(rejected))).toThrow(AiProviderError);
      expect(() => parseGeneratedArticle(article(rejected))).toThrow(/摘要.*120/);
    },
  );

  it.each(protocols)('%s 返回超长摘要时失败，不静默截断或自动重发模型请求', async (protocol) => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(protocol, '摘'.repeat(120) + '。'));
    const execution = new OpenAiProvider(fetcher).generate(
      { ...connection, protocol },
      input(),
      key,
    );
    await expect(execution).rejects.toBeInstanceOf(AiProviderError);
    await expect(execution).rejects.toMatchObject({
      uncertain: false,
      message: expect.stringMatching(/摘要.*120/),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('本地手写稿仍可完整保存超出微信限制的摘要，生成约束不收紧通用稿件结构', () => {
    const digest = '写'.repeat(121);
    const stored = articleInput.parse({
      title: '仍在编辑的本地稿件',
      digest,
      document: { type: 'doc', content: [{ type: 'paragraph' }] },
      author: '',
      sourceUrl: '',
      coverId: null,
    });
    expect(stored.digest).toBe(digest);
  });
});

describe('模型文字与配置输入', () => {
  it('文章 JSON 校验结构，正文中的 HTML 和远程图片仅作为文字', () => {
    const result = parseGeneratedArticle(
      '```json\n' +
        JSON.stringify({
          title: '标题',
          digest: '摘要',
          body: '## 小节\n\n<script>alert(1)</script>\n![图片](https://evil.example/image.png)',
        }) +
        '\n```',
    );
    expect(result.document.content?.[0]).toMatchObject({ type: 'heading', attrs: { level: 2 } });
    expect(JSON.stringify(result.document)).toContain('<script>');
    expect(JSON.stringify(result.document)).not.toContain('"type":"image"');
  });
  it.each([
    { title: 't', digest: '', body: '' },
    { title: 't', digest: '', body: '正文', html: '<script>' },
    { title: '', digest: '', body: '正文' },
  ])('不完整文章不会伪装成生成成功', (value) => {
    expect(() => parseGeneratedArticle(JSON.stringify(value))).toThrow(AiProviderError);
  });
  it('无效 Unicode 或 NUL 不进入文章', () => {
    expect(() =>
      parseGeneratedArticle(JSON.stringify({ title: 't', digest: '', body: '\u0000' })),
    ).toThrow(AiProviderError);
    expect(() =>
      parseGeneratedArticle(JSON.stringify({ title: 't', digest: '', body: '\ud800' })),
    ).toThrow(AiProviderError);
  });
  it('纯文本按段落和标题转换，换行被保留', () => {
    expect(textDocument('### 小节\n\n一\n二')).toEqual({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: '小节' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '一' },
            { type: 'hardBreak' },
            { type: 'text', text: '二' },
          ],
        },
      ],
    });
  });
  it('业务生成需要要求，改写还需要原文，验证任务可以使用固定提示', () => {
    expect(aiGenerationInput.safeParse({ requestKey: randomUUID(), kind: 'ARTICLE' }).success).toBe(
      false,
    );
    expect(
      aiGenerationInput.safeParse({ requestKey: randomUUID(), kind: 'REWRITE', prompt: '改写' })
        .success,
    ).toBe(false);
    expect(
      aiGenerationInput.safeParse({ requestKey: randomUUID(), kind: 'TEST_TEXT' }).success,
    ).toBe(true);
  });
  it('模型配置拒绝无法安全保存的模型文字及无效 Bearer 密钥，允许无密钥本机服务', () => {
    const valid = { baseUrl: 'http://localhost:1234/v1', model: '中文模型' };
    expect(aiModelInput.safeParse(valid).success).toBe(true);
    expect(aiModelInput.safeParse({ ...valid, apiKey: '' }).success).toBe(true);
    expect(aiModelInput.safeParse({ ...valid, model: '\ud800' }).success).toBe(false);
    expect(aiModelInput.safeParse({ ...valid, apiKey: 'contains a space' }).success).toBe(false);
    expect(aiModelInput.safeParse({ ...valid, apiKey: 'emoji-🔑' }).success).toBe(false);
  });
  it('协议枚举明确，旧配置仍可省略协议，Anthropic token 上限有界且不接受字符串', () => {
    const valid = { baseUrl: 'https://models.example/v1', model: 'configured-model' };
    expect(aiModelInput.parse(valid)).toMatchObject({ anthropicMaxTokens: 4096 });
    for (const protocol of [
      'chat-completions',
      'responses',
      'anthropic-messages',
      'images-generations',
    ])
      expect(aiModelInput.safeParse({ ...valid, protocol }).success).toBe(true);
    expect(aiModelInput.safeParse({ ...valid, protocol: 'openai-compatible' }).success).toBe(false);
    for (const anthropicMaxTokens of [0, -1, 1.5, 128001, '4096'])
      expect(aiModelInput.safeParse({ ...valid, anthropicMaxTokens }).success).toBe(false);
    expect(aiModelInput.safeParse({ ...valid, anthropicMaxTokens: 128000 }).success).toBe(true);
  });
  it('Base URL 正规化但不猜测 /v1，HTTPS 与本机 HTTP 可用', () => {
    expect(normalizeModelBaseUrl('https://models.example/custom/v1/')).toBe(
      'https://models.example/custom/v1',
    );
    expect(normalizeModelBaseUrl('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1');
  });
  it.each([
    'http://192.168.1.4/v1',
    'file:///etc/passwd',
    'https://user:secret@example.com/v1',
    'https://example.com/v1?token=x',
    'https://example.com/v1#token',
    'https://example.com/v1?',
    'https://example.com/v1#',
  ])('拒绝非预期配置 %s', (url) => {
    expect(() => normalizeModelBaseUrl(url)).toThrow(AiProviderError);
  });
});

describe('模型图片下载边界', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '172.16.1.1',
    '192.168.1.1',
    '224.0.0.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1',
  ])('拒绝非公开地址 %s', (address) => expect(isPublicAddress(address)).toBe(false));
  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('允许公开地址 %s', (address) =>
    expect(isPublicAddress(address)).toBe(true),
  );
  it('非配置来源不能借图片 URL 访问本地网络', async () => {
    const provider = new OpenAiProvider(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(json({ data: [{ url: 'https://127.0.0.1/private' }] })),
    );
    await expect(provider.generate(connection, input('COVER'), key)).rejects.toThrow(
      '本地或私有网络',
    );
  });
  it('明确配置的同源本机服务可下载图片，下载不携带模型 API Key且不跟随重定向', async () => {
    let observedAuthorization: string | undefined;
    let finalRequests = 0;
    const server = createServer((request, response) => {
      observedAuthorization = request.headers.authorization;
      if (request.url === '/redirect') {
        response.writeHead(302, { Location: '/final' });
        response.end();
      } else {
        if (request.url === '/final') finalRequests++;
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(png);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server not listening');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({ data: [{ url: `${origin}/image` }] }))
        .mockResolvedValueOnce(json({ data: [{ url: `${origin}/redirect` }] }));
      const provider = new OpenAiProvider(fetcher);
      expect(
        await provider.generate({ ...connection, baseUrl: `${origin}/v1` }, input('COVER'), key),
      ).toEqual({ type: 'image', buffer: png });
      await expect(
        provider.generate({ ...connection, baseUrl: `${origin}/v1` }, input('COVER'), key),
      ).rejects.toThrow('重定向');
      expect(observedAuthorization).toBeUndefined();
      expect(finalRequests).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
