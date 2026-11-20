import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Account } from '@prisma/client';
import type { Database } from '../../apps/server/src/database';
import { loadConfig } from '../../apps/server/src/config';
import { SecretBox } from '../../apps/server/src/security';
import { WechatError, WechatService } from '../../apps/server/src/platforms/wechat.module';

const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@localhost/tattoo_test',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString('base64'),
  WECHAT_API_BASE: 'http://localhost:9999',
  ALLOW_MOCK_WECHAT: 'true',
});
const box = new SecretBox(config.APP_ENCRYPTION_KEY);
const secret = 'test-app-secret-do-not-return';
const accessToken = 'test-access-token-do-not-return';
let account: Account;

beforeEach(() => {
  account = {
    id: '243074d8-6302-458d-b091-a952802b3891',
    platform: 'wechat',
    name: 'test',
    appId: 'wxtestaccount1234',
    credentialVersion: 1,
    secretEncrypted: box.encrypt(secret),
    tokenEncrypted: box.encrypt(accessToken),
    tokenExpiresAt: new Date(Date.now() + 3600000),
    capabilities: {},
    createdAt: new Date(),
    updatedAt: new Date(),
  };
});

function service(fetcher: typeof fetch) {
  const database = {
    account: {
      findUnique: vi.fn(async () => account),
      updateMany: vi.fn(async ({ data }: { data: Partial<Account> }) => {
        Object.assign(account, data);
        return { count: 1 };
      }),
    },
  };
  return { wechat: new WechatService(database as unknown as Database, config, fetcher), database };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

describe('微信适配器的副作用与凭证边界', () => {
  it('权限证据只属于实际调用的接口，token 失败不推断草稿读写权限', async () => {
    const { wechat } = service(
      vi
        .fn<typeof fetch>()
        .mockImplementation(async () => json({ errcode: 48001, errmsg: 'unauthorized' })),
    );
    await expect(wechat.countDrafts(account)).rejects.toMatchObject({
      readPermissionDenied: true,
      writePermissionDenied: false,
    });
    await expect(wechat.createDraft(account, { articles: [] })).rejects.toMatchObject({
      readPermissionDenied: false,
      writePermissionDenied: true,
    });
    account.tokenEncrypted = null;
    account.tokenExpiresAt = null;
    await expect(wechat.createDraft(account, { articles: [] })).rejects.toMatchObject({
      readPermissionDenied: false,
      writePermissionDenied: false,
    });
  });
  it('只读草稿计数不调用素材或新增草稿接口', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ total_count: 2 }));
    const { wechat } = service(fetcher);
    expect(await wechat.countDrafts(account)).toBe(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toContain('/cgi-bin/draft/count?');
    expect(fetcher.mock.calls[0]![1]?.method).toBe('GET');
    expect(fetcher.mock.calls[0]![1]?.redirect).toBe('error');
  });
  it('普通稳定 token 获取不强制刷新，并加密缓存', async () => {
    account.tokenEncrypted = null;
    account.tokenExpiresAt = null;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ access_token: accessToken, expires_in: 7200 }));
    const { wechat } = service(fetcher);
    expect(await wechat.token(account)).toBe(accessToken);
    expect(await wechat.token(account)).toBe(accessToken);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({
      force_refresh: false,
      appid: account.appId,
      secret,
    });
    expect(account.tokenEncrypted).not.toContain(accessToken);
    expect(box.decrypt(account.tokenEncrypted!)).toBe(accessToken);
  });
  it('40164 仅展示有效出口 IP，不回显微信原始错误中的密钥', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        errcode: 40164,
        errmsg: `invalid ip 203.0.113.7 ipv6 ::ffff:203.0.113.7 secret=${secret} access_token=${accessToken}`,
      }),
    );
    const { wechat } = service(fetcher);
    try {
      await wechat.countDrafts(account);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(WechatError);
      expect(String(error)).toContain('203.0.113.7');
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain(accessToken);
    }
  });
  it('草稿新增中的通用错误、HTTP 错误和损坏响应都保留为不确定结果', async () => {
    for (const response of [
      json({ errcode: -1, errmsg: 'busy' }),
      json({}, 503),
      new Response('broken'),
      json({}),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const { wechat } = service(fetcher);
      await expect(wechat.createDraft(account, { articles: [] })).rejects.toMatchObject({
        uncertain: true,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('token 失效只清理匹配缓存，草稿写请求不自动重发', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ errcode: 42001, errmsg: 'expired' }));
    const { wechat } = service(fetcher);
    await expect(wechat.createDraft(account, { articles: [] })).rejects.toMatchObject({
      uncertain: false,
      errcode: 42001,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(account.tokenEncrypted).toBeNull();
  });
  it('网络异常消息不泄漏 token，并在危险写入中标为待核对', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValue(
        new Error(`failed http://test?access_token=${accessToken}&secret=${secret}`),
      );
    const { wechat } = service(fetcher);
    try {
      await wechat.createDraft(account, { articles: [] });
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ uncertain: true });
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain(accessToken);
    }
  });
  it('执行权失效时不发出远程请求', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ media_id: 'created' }));
    const { wechat } = service(fetcher);
    await expect(
      wechat.createDraft(
        account,
        { articles: [] },
        {
          assertActive() {
            throw new Error('lost lock');
          },
        },
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('响应体超过应用上限时不把新增草稿结果当成成功', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1)));
    const { wechat } = service(fetcher);
    await expect(wechat.createDraft(account, { articles: [] })).rejects.toMatchObject({
      code: 'WECHAT_RESPONSE_LIMIT',
      uncertain: true,
    });
  });
});
