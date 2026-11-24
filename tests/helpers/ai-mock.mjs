import { createHash } from 'node:crypto';

const modes = [
  'success',
  'refused',
  'malformed',
  'disconnect',
  'invalid-image',
  'url',
  'hold',
  'truncated',
  'content-refused',
  'tool-output',
];

/** Local protocol fixtures; they never forward requests to another service. */
export function createAiMock(png) {
  const calls = { text: 0, image: 0 };
  const requests = [];
  const releases = new Set();
  let nextText = 'success';
  let nextImage = 'success';
  function releaseAll() {
    for (const release of releases) release();
    releases.clear();
  }
  function setNext(input) {
    for (const key of ['nextText', 'nextImage'])
      if (input[key] !== undefined && !modes.includes(input[key]))
        throw new Error('Unknown model fixture mode');
    if (input.nextText !== undefined) nextText = input.nextText;
    if (input.nextImage !== undefined) nextImage = input.nextImage;
    if (input.release) releaseAll();
  }
  async function handle(incoming, outgoing, pathname, body) {
    if (pathname === '/__tattoo_ai_audit' && incoming.method === 'GET') {
      outgoing.end(JSON.stringify({ calls, requests }));
      return true;
    }
    if (pathname === '/__tattoo_ai_control' && incoming.method === 'POST') {
      setNext(JSON.parse(body.toString('utf8')));
      outgoing.end(JSON.stringify({ ok: true }));
      return true;
    }
    if (pathname === '/v1/fixture-image.png' && incoming.method === 'GET') {
      outgoing.setHeader('Content-Type', 'image/png');
      outgoing.end(png);
      return true;
    }
    const protocol = {
      '/v1/chat/completions': 'chat-completions',
      '/v1/responses': 'responses',
      '/v1/messages': 'anthropic-messages',
      '/v1/images/generations': 'images-generations',
    }[pathname];
    if (!protocol) return false;
    const capability = protocol === 'images-generations' ? 'image' : 'text';
    const input = JSON.parse(body.toString('utf8'));
    const instructions = [
      input.instructions ?? '',
      input.system ?? '',
      ...(input.messages ?? []).map((message) => message.content ?? ''),
    ].join('\n');
    const task = /TASK:(ARTICLE|REWRITE|TEST_TEXT)/.exec(instructions)?.[1] ?? 'UNKNOWN';
    calls[capability]++;
    requests.push({
      capability,
      protocol,
      task,
      model: input.model,
      prompt: typeof input.prompt === 'string' ? input.prompt : '',
      size: input.size ?? null,
      responseFormat: input.response_format ?? null,
      maxTokens: input.max_tokens ?? null,
      store: input.store ?? null,
      stream: input.stream ?? null,
      anthropicVersion: incoming.headers['anthropic-version'] ?? null,
      authorizationHash: createHash('sha256')
        .update(String(incoming.headers.authorization ?? ''))
        .digest('hex'),
      xApiKeyHash: createHash('sha256')
        .update(String(incoming.headers['x-api-key'] ?? ''))
        .digest('hex'),
    });
    const mode = capability === 'text' ? nextText : nextImage;
    if (capability === 'text') nextText = 'success';
    else nextImage = 'success';
    if (mode === 'hold')
      await new Promise((resolve) => {
        let timer;
        const release = () => {
          clearTimeout(timer);
          releases.delete(release);
          resolve();
        };
        releases.add(release);
        timer = setTimeout(release, 15000);
      });
    if (mode === 'disconnect') incoming.socket.destroy();
    else if (mode === 'refused') {
      outgoing.statusCode = 401;
      outgoing.end(
        JSON.stringify({ error: { message: 'model fixture rejected this credential' } }),
      );
    } else if (mode === 'malformed') outgoing.end('{"incomplete":');
    else if (capability === 'text') {
      const content =
        task === 'ARTICLE'
          ? JSON.stringify({
              title: 'AI 生成测试文章',
              digest: '模型生成摘要',
              body: '## 从灵感到文章\n\n这是一篇由隔离模型接口返回的测试文章。\n\n内容需要人工审阅后保存。',
            })
          : task === 'REWRITE'
            ? '这是模型改写后的段落。'
            : '模型文字验证成功';
      if (protocol === 'responses') {
        outgoing.end(
          JSON.stringify({
            id: 'resp_fixture',
            object: 'response',
            status: mode === 'truncated' ? 'incomplete' : 'completed',
            incomplete_details: mode === 'truncated' ? { reason: 'max_output_tokens' } : null,
            output: [
              { type: 'reasoning', id: 'rs_fixture', summary: [], content: 'private reasoning' },
              ...(mode === 'tool-output'
                ? [{ type: 'function_call', name: 'unexpected_tool', arguments: '{}' }]
                : [
                    {
                      type: 'message',
                      role: 'assistant',
                      status: 'completed',
                      content:
                        mode === 'content-refused'
                          ? [{ type: 'refusal', refusal: 'fixture refused this request' }]
                          : [{ type: 'output_text', text: content, annotations: [] }],
                    },
                  ]),
            ],
          }),
        );
      } else if (protocol === 'anthropic-messages') {
        outgoing.end(
          JSON.stringify({
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            stop_reason:
              mode === 'truncated'
                ? 'max_tokens'
                : mode === 'tool-output'
                  ? 'tool_use'
                  : mode === 'content-refused'
                    ? 'refusal'
                    : 'end_turn',
            content: [
              { type: 'thinking', thinking: 'private reasoning', signature: 'fixture' },
              ...(mode === 'tool-output'
                ? [{ type: 'tool_use', id: 'tool_fixture', name: 'unexpected_tool', input: {} }]
                : [{ type: 'text', text: content }]),
            ],
          }),
        );
      } else {
        outgoing.end(
          JSON.stringify({
            choices: [
              {
                message: { content },
                finish_reason: mode === 'truncated' ? 'length' : 'stop',
              },
            ],
          }),
        );
      }
    } else {
      outgoing.end(
        JSON.stringify({
          data: [
            mode === 'url'
              ? { url: `http://${incoming.headers.host}/v1/fixture-image.png` }
              : {
                  b64_json:
                    mode === 'invalid-image'
                      ? Buffer.from('not an image').toString('base64')
                      : png.toString('base64'),
                },
          ],
        }),
      );
    }
    return true;
  }
  return { calls, requests, setNext, releaseAll, handle };
}
