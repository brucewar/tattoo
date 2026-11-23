import { createHash } from 'node:crypto';

const modes = ['success', 'refused', 'malformed', 'disconnect', 'invalid-image', 'url', 'hold'];

/** A local OpenAI-compatible fixture; it never forwards requests to another service. */
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
    const capability =
      pathname === '/v1/chat/completions'
        ? 'text'
        : pathname === '/v1/images/generations'
          ? 'image'
          : null;
    if (!capability) return false;
    const input = JSON.parse(body.toString('utf8'));
    const messages = (input.messages ?? []).map((message) => message.content ?? '').join('\n');
    const task = /TASK:(ARTICLE|REWRITE|TEST_TEXT)/.exec(messages)?.[1] ?? 'UNKNOWN';
    calls[capability]++;
    requests.push({
      capability,
      task,
      model: input.model,
      prompt: typeof input.prompt === 'string' ? input.prompt : '',
      size: input.size ?? null,
      responseFormat: input.response_format ?? null,
      authorizationHash: createHash('sha256')
        .update(String(incoming.headers.authorization ?? ''))
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
      outgoing.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));
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
