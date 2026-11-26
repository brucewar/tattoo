import { WECHAT_DIGEST_MAX_LENGTH } from '@tattoo/contracts';

/** Verified from the subscription-account official docs on 2026-11-20. */
export const WECHAT_RULE_SOURCES = {
  draft:
    'https://developers.weixin.qq.com/doc/subscription/api/draftbox/draftmanage/api_draft_add.html',
  bodyImage:
    'https://developers.weixin.qq.com/doc/subscription/api/material/permanent/api_uploadimage.html',
  permanentImage:
    'https://developers.weixin.qq.com/doc/subscription/api/material/permanent/api_addmaterial.html',
  token: 'https://developers.weixin.qq.com/doc/subscription/api/base/api_getstableaccesstoken.html',
} as const;

// Official wording does not define supplementary Unicode or M/kb precisely. We use
// conservative UTF-16 units and decimal bytes; this is an application policy, not
// a claim that WeChat defines its accounting that way. No content is truncated.
export const WECHAT_LIMITS = Object.freeze({
  titleCharacters: 32,
  authorCharacters: 16,
  digestCharacters: WECHAT_DIGEST_MAX_LENGTH,
  htmlCharacters: 20_000,
  htmlBytes: 1_000_000,
  sourceUrlBytes: 1_000,
  bodyImageBytes: 1_000_000,
  coverImageBytes: 10_000_000,
});

export const WECHAT_RULES_VERIFIED_AT = '2026-11-20';
