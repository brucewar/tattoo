import { isIP } from 'node:net';
import { PlatformError } from '../platform-error';

// Generic and unverified error codes remain uncertain after a draft write.
const definitiveRefusals = new Set([40001, 40007, 40013, 40125, 40164, 41001, 42001, 48001]);

export class WechatError extends PlatformError {
  operation?: 'token' | 'readDraft' | 'cover' | 'bodyImage' | 'saveDraft';
  get readPermissionDenied() {
    return this.errcode === 48001 && this.operation === 'readDraft';
  }
  get writePermissionDenied() {
    return this.errcode === 48001 && this.operation === 'saveDraft';
  }
  get invalidCover() {
    return this.errcode === 40007 && this.operation === 'saveDraft';
  }
  get invalidBodyImage() {
    return this.code === 'WECHAT_INVALID_IMAGE_URL' && this.operation === 'bodyImage';
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
    super(code, message, uncertain, suggestion);
    this.name = 'WechatError';
  }
}

export function platformError(errcode: number, raw: unknown, draftWrite: boolean): WechatError {
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
