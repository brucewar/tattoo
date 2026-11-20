import { ConflictException, Inject, Injectable, Optional } from '@nestjs/common';
import type { Account } from '@prisma/client';
import sharp from 'sharp';
import { Database } from '../../database';
import type { Config } from '../../config';
import { SecretBox } from '../../security';
import { inspectDocument } from '../../content/document';
import { PlatformError } from '../platform-error';
import type {
  DraftContent,
  DraftCheck,
  PreparedDraft,
  PlatformDraftAdapter,
  PlatformExecutionGuard,
} from '../draft-adapter';
import { RENDER_VERSION, renderDocument } from './renderer';
import { checkWechatDraft } from './check';
import { WECHAT_LIMITS } from './limits';
import { isWechatImageUrl } from './image-url';
import { WechatError, platformError } from './error';

@Injectable()
export class WechatService implements PlatformDraftAdapter {
  readonly platform = 'wechat' as const;
  readonly renderVersion = RENDER_VERSION;
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
    guard?: PlatformExecutionGuard,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      guard?.assertActive();
      await guard?.beforeRequest?.();
      guard?.assertActive();
      const remaining = guard?.deadlineAt === undefined ? 30000 : guard.deadlineAt - Date.now();
      if (remaining <= 0)
        throw new WechatError('WECHAT_TASK_TIMEOUT', '本次后台任务已超过执行时限', draftWrite);
      timer = setTimeout(() => controller.abort(), Math.min(30000, remaining));
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
            : path.startsWith('/cgi-bin/media/uploadimg')
              ? 'bodyImage'
              : path.startsWith('/cgi-bin/material/')
                ? 'cover'
                : 'token';
        throw error;
      }
      // Never expose fetch errors: they can contain a full URL with access_token.
      throw new WechatError('WECHAT_NETWORK_ERROR', '微信接口连接中断或请求超时', draftWrite);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Caller must hold AccountsService.withLockedAccount across token and API operations. */
  async token(account: Account, guard?: PlatformExecutionGuard): Promise<string> {
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
      data.expires_in > 7200
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
    guard?: PlatformExecutionGuard,
  ) {
    try {
      return await this.request(path, options, draftWrite, guard);
    } catch (error) {
      // Invalidation must not hide the original write-result classification, and never retries.
      await this.invalidateToken(account, token, error).catch(() => undefined);
      throw error;
    }
  }

  async countDrafts(account: Account, guard?: PlatformExecutionGuard): Promise<number> {
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

  async uploadCover(
    account: Account,
    buffer: Buffer,
    guard?: PlatformExecutionGuard,
  ): Promise<string> {
    const mime = await this.validateImage(buffer, 'cover');
    const token = await this.token(account, guard);
    const body = new FormData();
    body.set(
      'media',
      new Blob([new Uint8Array(buffer)], { type: mime }),
      mime === 'image/jpeg' ? 'cover.jpg' : 'cover.png',
    );
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

  async uploadBodyImage(
    account: Account,
    buffer: Buffer,
    guard?: PlatformExecutionGuard,
  ): Promise<string> {
    const mime = await this.validateImage(buffer, 'body');
    const token = await this.token(account, guard);
    const body = new FormData();
    body.set(
      'media',
      new Blob([new Uint8Array(buffer)], { type: mime }),
      mime === 'image/jpeg' ? 'body.jpg' : 'body.png',
    );
    const data = await this.authenticatedRequest(
      account,
      token,
      `/cgi-bin/media/uploadimg?access_token=${encodeURIComponent(token)}`,
      { method: 'POST', body },
      false,
      guard,
    );
    if (!isWechatImageUrl(data.url)) {
      const error = new WechatError(
        'WECHAT_INVALID_IMAGE_URL',
        '微信正文图片响应未包含可信图片地址；可能留下远程图片，请在后台检查',
        false,
      );
      error.operation = 'bodyImage';
      throw error;
    }
    return data.url;
  }

  private async validateImage(
    buffer: Buffer,
    use: 'cover' | 'body',
  ): Promise<'image/jpeg' | 'image/png'> {
    const maxBytes = use === 'cover' ? WECHAT_LIMITS.coverImageBytes : WECHAT_LIMITS.bodyImageBytes;
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length >= maxBytes)
      throw new PlatformError(
        'INVALID_UPLOAD_IMAGE',
        use === 'body'
          ? '正文图片上传副本必须小于 1,000,000 字节，请压缩后再试'
          : '封面上传副本必须小于 10,000,000 字节，请压缩后再试',
        false,
      );
    try {
      const metadata = await sharp(buffer, {
        limitInputPixels: 20_000_000,
        failOn: 'warning',
      }).metadata();
      if (!['jpeg', 'png'].includes(metadata.format ?? '') || (metadata.pages ?? 1) !== 1)
        throw new Error('invalid image');
      return metadata.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    } catch {
      throw new PlatformError('INVALID_UPLOAD_IMAGE', '上传副本必须是有效的 JPG/PNG 图片', false);
    }
  }

  check(input: DraftContent, finalHtml?: string): DraftCheck {
    return checkWechatDraft(input, finalHtml);
  }

  prepareDraft(
    input: DraftContent & { coverReference: string; imageUrls: Record<string, string> },
  ): PreparedDraft {
    for (const id of inspectDocument(input.document).assetIds) {
      if (!isWechatImageUrl(input.imageUrls[id]))
        throw new PlatformError(
          'INVALID_BODY_IMAGE_REFERENCE',
          '正文图片尚未获得有效的平台上传地址',
          false,
          '请重新上传正文图片后再试',
          { invalidBodyImage: true },
        );
    }
    if (!input.coverReference.trim())
      throw new PlatformError(
        'INVALID_COVER_REFERENCE',
        '封面尚未获得有效的平台素材标识',
        false,
        '请重新上传封面后再试',
        { invalidCover: true },
      );
    const html = renderDocument(input.document, input.imageUrls);
    return {
      html,
      payload: {
        articles: [
          {
            article_type: 'news',
            title: input.title,
            author: input.author,
            digest: input.digest,
            content: html,
            content_source_url: input.sourceUrl,
            thumb_media_id: input.coverReference,
            need_open_comment: 0,
            only_fans_can_comment: 0,
          },
        ],
      },
    };
  }

  async createDraft(
    account: Account,
    payload: unknown,
    guard?: PlatformExecutionGuard,
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
