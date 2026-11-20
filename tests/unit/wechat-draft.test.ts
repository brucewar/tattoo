import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Account } from '@prisma/client';
import sharp from 'sharp';
import type { Database } from '../../apps/server/src/database';
import { loadConfig } from '../../apps/server/src/config';
import { SecretBox } from '../../apps/server/src/security';
import type { DraftContent } from '../../apps/server/src/platforms/draft-adapter';
import { PlatformError } from '../../apps/server/src/platforms/platform-error';
import { WechatService } from '../../apps/server/src/platforms/wechat/service';
import { checkWechatDraft } from '../../apps/server/src/platforms/wechat/check';
import { isWechatImageUrl } from '../../apps/server/src/platforms/wechat/image-url';
import { WECHAT_LIMITS } from '../../apps/server/src/platforms/wechat/limits';
import { validateWechat } from '../../apps/server/src/platforms/wechat/renderer';

const coverId = '078e32a9-9e61-462f-8dd5-c59ab916296b';
const imageId = '278e32a9-9e61-462f-8dd5-c59ab916296b';
const input: DraftContent = {
  title: '正常标题',
  author: '作者',
  digest: '摘要',
  sourceUrl: 'https://example.com/original',
  coverId,
  document: {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文内容' }] }],
  },
};
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost/tattoo_test',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
  WECHAT_API_BASE: 'http://localhost:9999',
  ALLOW_MOCK_WECHAT: 'true',
});
const secrets = new SecretBox(config.APP_ENCRYPTION_KEY);
const account = {
  id: '243074d8-6302-458d-b091-a952802b3891',
  credentialVersion: 1,
  secretEncrypted: secrets.encrypt('test-only-app-secret'),
  tokenEncrypted: secrets.encrypt('test-only-token'),
  tokenExpiresAt: new Date(Date.now() + 3600000),
} as Account;
const json = (value: unknown) =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function adapter(fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({}))) {
  const database = { account: { findUnique: vi.fn(async () => account) } };
  return new WechatService(database as unknown as Database, config, fetcher);
}
let png: Buffer;
beforeAll(async () => {
  png = await sharp({ create: { width: 20, height: 12, channels: 3, background: '#35634e' } })
    .png()
    .toBuffer();
});

describe('官方微信草稿规则与最终产物', () => {
  it('完整稿件按已核验官方规则通过，不完整内容仅在平台检查中阻止投递', () => {
    expect(checkWechatDraft(input)).toMatchObject({
      allowed: true,
      limitsVerified: true,
      limitSource: 'official',
      problems: [],
    });
    const result = checkWechatDraft({
      ...input,
      title: '',
      coverId: null,
      document: { type: 'doc', content: [] },
    });
    expect(result.allowed).toBe(false);
    expect(result.problems).toEqual(
      expect.arrayContaining(['请填写标题', '请上传文章封面', '正文不能为空']),
    );
  });
  it('标题32、作者16、摘要120的边界保留原文，不截断超限字段', () => {
    expect(
      checkWechatDraft({
        ...input,
        title: '题'.repeat(32),
        author: '名'.repeat(16),
        digest: '摘'.repeat(120),
      }).allowed,
    ).toBe(true);
    for (const [field, limit] of [
      ['title', 32],
      ['author', 16],
      ['digest', 120],
    ] as const) {
      const value = '中'.repeat(limit + 1);
      expect(checkWechatDraft({ ...input, [field]: value }).allowed).toBe(false);
      expect(value.length).toBe(limit + 1);
    }
  });
  it('补充Unicode按明确的UTF-16保守口径计量', () => {
    expect(checkWechatDraft({ ...input, title: '😀'.repeat(16) }).allowed).toBe(true);
    expect(checkWechatDraft({ ...input, title: '😀'.repeat(17) }).problems).toContain(
      '标题超出公众号限制',
    );
  });
  it('最终HTML必须严格少于20000单位和1000000 UTF-8字节', () => {
    expect(checkWechatDraft(input, 'x'.repeat(19999)).allowed).toBe(true);
    expect(checkWechatDraft(input, 'x'.repeat(20000)).allowed).toBe(false);
    const limits = { ...WECHAT_LIMITS, htmlCharacters: 2_000_000 };
    expect(validateWechat(input, limits, '中'.repeat(333333))).toEqual([]);
    expect(validateWechat(input, limits, '中'.repeat(333333) + 'a')).toContain(
      '排版后的正文超出公众号限制',
    );
  });
  it('原文链接按UTF-8字节独立限制，1000可用、1001拒绝', () => {
    const prefix = 'https://example.com/';
    expect(
      checkWechatDraft({ ...input, sourceUrl: prefix + 'a'.repeat(1000 - prefix.length) }).allowed,
    ).toBe(true);
    expect(
      checkWechatDraft({ ...input, sourceUrl: prefix + 'a'.repeat(1001 - prefix.length) }).problems,
    ).toContain('原文链接超出公众号限制');
  });
  it('请求体包含全部稿件字段和替换后的图片地址，缺映射不会退回本地URL', () => {
    const wechat = adapter();
    const document = { type: 'doc', content: [{ type: 'image', attrs: { assetId: imageId } }] };
    const url = 'http://mmbiz.qpic.cn/mmbiz_png/p4-example/0?wx_fmt=png';
    const prepared = wechat.prepareDraft({
      ...input,
      document,
      coverReference: 'permanent-cover',
      imageUrls: { [imageId]: url },
    });
    expect(prepared.payload).toMatchObject({
      articles: [
        {
          article_type: 'news',
          title: input.title,
          author: input.author,
          digest: input.digest,
          content_source_url: input.sourceUrl,
          thumb_media_id: 'permanent-cover',
          content: prepared.html,
        },
      ],
    });
    expect(prepared.html).toContain(url.replaceAll('&', '&amp;'));
    expect(prepared.html).not.toContain('/api/v1/assets/');
    expect(() =>
      wechat.prepareDraft({ ...input, document, coverReference: 'permanent-cover', imageUrls: {} }),
    ).toThrow(PlatformError);
    expect(() =>
      wechat.prepareDraft({
        ...input,
        document,
        coverReference: 'permanent-cover',
        imageUrls: { [imageId]: 'https://evil.example/image' },
      }),
    ).toThrow('平台上传地址');
  });
  it('替换后变长的微信图片地址必须重新校验最终HTML', () => {
    const wechat = adapter();
    const imageInput = {
      ...input,
      document: { type: 'doc', content: [{ type: 'image', attrs: { assetId: imageId } }] },
    };
    expect(wechat.check(imageInput).allowed).toBe(true);
    const prepared = wechat.prepareDraft({
      ...imageInput,
      coverReference: 'cover',
      imageUrls: { [imageId]: 'https://mmbiz.qpic.cn/' + 'a'.repeat(20_000) },
    });
    expect(wechat.check(imageInput, prepared.html).problems).toContain(
      '排版后的正文超出公众号限制',
    );
  });
  it.each([
    'https://mmbiz.qpic.cn.evil.example/photo',
    'https://evil.example/mmbiz.qpic.cn/photo',
    'https://user:password@mmbiz.qpic.cn/photo',
    'https://mmbiz.qpic.cn:8443/photo',
    'https://mmbiz.qpic.cn/photo#fragment',
    'https://mmbiz.qpic.cn/\nphoto',
    '//mmbiz.qpic.cn/photo',
    'data:image/png;base64,AA',
  ])('拒绝不可信或格式异常的正文映射 %s', (url) => expect(isWechatImageUrl(url)).toBe(false));
});

describe('正文图片上传与任务截止时间', () => {
  it('正文图片调用uploadimg并返回可信URL，不创建草稿', async () => {
    const url = 'https://mmbiz.qpic.cn/mmbiz_png/example/0';
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ url, errcode: 0 }));
    expect(await adapter(fetcher).uploadBodyImage(account, png)).toBe(url);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain('/cgi-bin/media/uploadimg?');
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'POST', redirect: 'error' });
    const form = fetcher.mock.calls[0]![1]!.body as FormData;
    expect((form.get('media') as Blob).type).toBe('image/png');
  });
  it('超限或伪造图片在联网前被拒绝', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const wechat = adapter(fetcher);
    for (const buffer of [Buffer.alloc(1_000_000), Buffer.from('<svg>not png</svg>')])
      await expect(wechat.uploadBodyImage(account, buffer)).rejects.toBeInstanceOf(PlatformError);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('上游成功响应中的外站URL也不能缓存或进入最终正文', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ url: 'https://attacker.example/image' }));
    await expect(adapter(fetcher).uploadBodyImage(account, png)).rejects.toMatchObject({
      code: 'WECHAT_INVALID_IMAGE_URL',
      invalidBodyImage: true,
      uncertain: false,
    });
  });
  it('任务已截止时不发出请求', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      adapter(fetcher).createDraft(account, {}, { assertActive() {}, deadlineAt: Date.now() - 1 }),
    ).rejects.toMatchObject({ code: 'WECHAT_TASK_TIMEOUT' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('每次HTTP请求前重新核对全局执行权，失效后不发出请求', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const beforeRequest = vi.fn(async () => {
      throw new Error('execution revoked');
    });
    await expect(
      adapter(fetcher).createDraft(account, {}, { assertActive() {}, beforeRequest }),
    ).rejects.toMatchObject({ uncertain: true });
    expect(beforeRequest).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('执行权核对期间耗尽任务时限，也不能越过请求门槛', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const guard = {
      assertActive() {},
      deadlineAt: Date.now() + 10_000,
      async beforeRequest() {
        guard.deadlineAt = Date.now() - 1;
      },
    };
    await expect(adapter(fetcher).createDraft(account, {}, guard)).rejects.toMatchObject({
      code: 'WECHAT_TASK_TIMEOUT',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('新增草稿请求随剩余任务时限中断，结果保持不确定', async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn<typeof fetch>().mockImplementation(
        (_url, options) =>
          new Promise((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            });
          }),
      );
      const rejected = expect(
        adapter(fetcher).createDraft(
          account,
          {},
          { assertActive() {}, deadlineAt: Date.now() + 80 },
        ),
      ).rejects.toMatchObject({ uncertain: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(80);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});
