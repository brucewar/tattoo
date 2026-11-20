import { ConflictException, Inject, Injectable, Module, Optional } from '@nestjs/common';
import type { Account } from '@prisma/client';
import { isIP } from 'node:net';
import { Database } from '../database';
import type { Config } from '../config';
import { SecretBox } from '../security';
import type { AccountLockGuard } from '../accounts/lock';
import { RENDER_VERSION, renderDocument } from '../content/render';
import type { DocumentNode } from '@tattoo/contracts';

export const WECHAT_RENDER_VERSION = RENDER_VERSION;

// Generic and unverified error codes remain uncertain after a draft write.
const definitiveRefusals = new Set([40001, 40007, 40013, 40125, 40164, 41001, 42001, 48001]);

export class WechatError extends Error {
  operation?: 'token' | 'readDraft' | 'cover' | 'saveDraft';
  get readPermissionDenied() {
    return this.errcode === 48001 && this.operation === 'readDraft';
  }
  get writePermissionDenied() {
    return this.errcode === 48001 && this.operation === 'saveDraft';
  }
  get invalidCover() {
    return this.errcode === 40007 && this.operation === 'saveDraft';
  }
  constructor(
    public readonly code: string,
    message: string,
    public readonly uncertain: boolean,
    public readonly errcode: number | null = null,
    public readonly suggestion: string = uncertain
      ? '请先在微信后台核对是否已经创建草稿，记录核对结果前不要重试'
      : '请检查账号配置、网络与微信后台权限后重试',
  ) {
    super(message);
    this.name = 'WechatError';
  }
}

function platformError(errcode: number, raw: unknown, draftWrite: boolean): WechatError {
  let reason = '微信接口拒绝了本次请求';
  let suggestion = '请在微信开发者后台核对当前账号的接口权限与调用额度';
  if (errcode === 48001) {
    reason = '该账号尚未获准调用此接口';
    suggestion =
      '请在微信开发者后台确认当前账号拥有对应接口权限，获取 token 成功不代表草稿写权限可用';
  } else if (errcode === 40164) {
    const candidate =
      typeof raw === 'string'
        ? raw.match(/(?:invalid\s+ip|\bip\s*:)\s*([0-9a-f:.]+)/i)?.[1]
        : undefined;
    const ip = candidate && isIP(candidate) ? candidate : undefined;
    reason = `微信拒绝当前出口 IP${ip ? `：${ip}` : ''}`;
    suggestion = '请将微信报告的实际公网出口 IP 加入白名单；内网地址和 DDNS 不能替代出口 IP';
  } else if ([40001, 40125, 41001, 42001, 40013].includes(errcode)) {
    reason = '微信接口凭证无效或已过期';
    suggestion = '请核对 AppID、AppSecret 和出口白名单；轮换密钥后重新验证';
  } else if ([45009, 45064].includes(errcode)) {
    reason = '微信接口调用频率或额度已受限';
    suggestion = '请稍后手动重试，并在微信后台检查调用额度';
  } else if (errcode === 50002) {
    reason = '微信账号当前受限';
    suggestion = '请在微信后台检查账号状态及平台通知';
  }
  const uncertain = draftWrite && !definitiveRefusals.has(errcode);
  if (uncertain)
    suggestion = `请先在微信后台核对是否已经创建草稿，记录核对结果前不要重试；${suggestion}`;
  return new WechatError(
    `WECHAT_${errcode}`,
    `${reason}（${errcode}）`,
    uncertain,
    errcode,
    suggestion,
  );
}

@Injectable()
export class WechatService {
  private readonly secrets: SecretBox;
  private readonly fetcher: typeof fetch;

  constructor(
    private readonly database: Database,
    @Inject('APP_CONFIG') private readonly config: Config,
    @Optional() @Inject('WECHAT_FETCH') fetcher?: typeof fetch,
  ) {
    this.secrets = new SecretBox(config.APP_ENCRYPTION_KEY);
    this.fetcher = fetcher ?? fetch;
  }

  private async request(
    path: string,
    options: RequestInit,
    draftWrite = false,
    guard?: AccountLockGuard,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      guard?.assertActive();
      const response = await this.fetcher(`${this.config.WECHAT_API_BASE}${path}`, {
        ...options,
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok)
        throw new WechatError(
          'WECHAT_HTTP_ERROR',
          `微信接口 HTTP 请求失败（${response.status}）`,
          draftWrite,
        );
      if (Number(response.headers.get('content-length') ?? 0) > 1024 * 1024) {
        controller.abort();
        throw new WechatError('WECHAT_RESPONSE_LIMIT', '微信接口响应超出处理上限', draftWrite);
      }
      const reader = response.body?.getReader();
      if (!reader)
        throw new WechatError('WECHAT_INVALID_RESPONSE', '微信接口返回了空响应', draftWrite);
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 1024 * 1024) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          throw new WechatError('WECHAT_RESPONSE_LIMIT', '微信接口响应超出处理上限', draftWrite);
        }
        chunks.push(item.value);
      }
      let data: unknown;
      try {
        data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new WechatError('WECHAT_INVALID_RESPONSE', '微信接口响应无法解析', draftWrite);
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new WechatError('WECHAT_INVALID_RESPONSE', '微信接口响应结构无效', draftWrite);
      }
      const object = data as Record<string, unknown>;
      if (typeof object.errcode === 'number' && object.errcode !== 0)
        throw platformError(object.errcode, object.errmsg, draftWrite);
      return object;
    } catch (error) {
      if (error instanceof WechatError) {
        error.operation = path.startsWith('/cgi-bin/draft/add')
          ? 'saveDraft'
          : path.startsWith('/cgi-bin/draft/count')
            ? 'readDraft'
            : path.startsWith('/cgi-bin/material/')
              ? 'cover'
              : 'token';
        throw error;
      }
      // Never expose fetch errors: they can contain a full URL with access_token.
      throw new WechatError('WECHAT_NETWORK_ERROR', '微信接口连接中断或请求超时', draftWrite);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Caller must hold AccountsService.withLockedAccount across token and API operations. */
  async token(account: Account, guard?: AccountLockGuard): Promise<string> {
    guard?.assertActive();
    const current = await this.database.account.findUnique({ where: { id: account.id } });
    if (!current || current.credentialVersion !== account.credentialVersion) {
      throw new ConflictException('账号凭证已变化，请重新执行操作');
    }
    if (
      current.tokenEncrypted &&
      current.tokenExpiresAt &&
      current.tokenExpiresAt.getTime() > Date.now() + 120000
    ) {
      return this.secrets.decrypt(current.tokenEncrypted);
    }
    const data = await this.request(
      '/cgi-bin/stable_token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'client_credential',
          appid: account.appId,
          secret: this.secrets.decrypt(current.secretEncrypted),
          force_refresh: false,
        }),
      },
      false,
      guard,
    );
    if (
      typeof data.access_token !== 'string' ||
      !data.access_token ||
      typeof data.expires_in !== 'number' ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 ||
      data.expires_in > 86400
    ) {
      throw new WechatError('WECHAT_INVALID_RESPONSE', '微信凭证响应不完整', false);
    }
    const stored = await this.database.account.updateMany({
      where: { id: account.id, credentialVersion: account.credentialVersion },
      data: {
        tokenEncrypted: this.secrets.encrypt(data.access_token),
        tokenExpiresAt: new Date(Date.now() + data.expires_in * 1000),
      },
    });
    if (stored.count !== 1) throw new ConflictException('账号凭证已变化，请重新验证');
    return data.access_token;
  }

  private async invalidateToken(account: Account, token: string, error: unknown) {
    if (!(error instanceof WechatError) || ![40001, 41001, 42001].includes(error.errcode ?? 0))
      return;
    const current = await this.database.account.findUnique({ where: { id: account.id } });
    if (
      !current ||
      current.credentialVersion !== account.credentialVersion ||
      !current.tokenEncrypted ||
      this.secrets.decrypt(current.tokenEncrypted) !== token
    )
      return;
    await this.database.account.updateMany({
      where: {
        id: account.id,
        credentialVersion: account.credentialVersion,
        tokenEncrypted: current.tokenEncrypted,
      },
      data: { tokenEncrypted: null, tokenExpiresAt: null },
    });
  }

  private async authenticatedRequest(
    account: Account,
    token: string,
    path: string,
    options: RequestInit,
    draftWrite: boolean,
    guard?: AccountLockGuard,
  ) {
    try {
      return await this.request(path, options, draftWrite, guard);
    } catch (error) {
      // Invalidation must not hide the original write-result classification, and never retries.
      await this.invalidateToken(account, token, error).catch(() => undefined);
      throw error;
    }
  }

  async countDrafts(account: Account, guard?: AccountLockGuard): Promise<number> {
    const token = await this.token(account, guard);
    const data = await this.authenticatedRequest(
      account,
      token,
      `/cgi-bin/draft/count?access_token=${encodeURIComponent(token)}`,
      { method: 'GET' },
      false,
      guard,
    );
    if (
      typeof data.total_count !== 'number' ||
      !Number.isSafeInteger(data.total_count) ||
      data.total_count < 0
    ) {
      throw new WechatError('WECHAT_INVALID_RESPONSE', '微信草稿计数响应不完整', false);
    }
    return data.total_count;
  }

  async uploadCover(account: Account, buffer: Buffer, guard?: AccountLockGuard): Promise<string> {
    const token = await this.token(account, guard);
    const body = new FormData();
    body.set('media', new Blob([new Uint8Array(buffer)], { type: 'image/jpeg' }), 'cover.jpg');
    const data = await this.authenticatedRequest(
      account,
      token,
      `/cgi-bin/material/add_material?access_token=${encodeURIComponent(token)}&type=image`,
      { method: 'POST', body },
      false,
      guard,
    );
    if (typeof data.media_id !== 'string' || !data.media_id)
      throw new WechatError(
        'WECHAT_INVALID_RESPONSE',
        '微信封面上传结果不完整；可能留下远程素材，请在后台检查',
        false,
      );
    return data.media_id;
  }

  prepareDraft(input: { title: string; document: DocumentNode; coverReference: string }) {
    return {
      articles: [
        {
          title: input.title,
          content: renderDocument(input.document),
          thumb_media_id: input.coverReference,
        },
      ],
    };
  }

  async createDraft(
    account: Account,
    payload: unknown,
    guard?: AccountLockGuard,
  ): Promise<{ remoteId: string; platformResult: { media_id: string } }> {
    const token = await this.token(account, guard);
    const data = await this.authenticatedRequest(
      account,
      token,
      `/cgi-bin/draft/add?access_token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      true,
      guard,
    );
    if (typeof data.media_id !== 'string' || !data.media_id)
      throw new WechatError(
        'WECHAT_INVALID_RESPONSE',
        '微信未返回可确认的草稿 ID，请人工核对',
        true,
      );
    return { remoteId: data.media_id, platformResult: { media_id: data.media_id } };
  }
}

@Module({ providers: [WechatService], exports: [WechatService] })
export class WechatModule {}
