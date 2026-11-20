import { safeHttpUrl } from '@tattoo/contracts';

/** The official uploadimg example returns this CDN, including an HTTP example. */
export function isWechatImageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !safeHttpUrl.safeParse(value).success) return false;
  const url = new URL(value);
  return url.hostname === 'mmbiz.qpic.cn' && !url.port && !url.hash && url.pathname.length > 1;
}
