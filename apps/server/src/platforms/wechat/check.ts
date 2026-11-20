import { safeHttpUrl } from '@tattoo/contracts';
import { ContentError } from '../../content/document';
import type { DraftCheck, DraftContent } from '../draft-adapter';
import { WECHAT_LIMITS } from './limits';
import { validateWechat } from './renderer';

/** Pure platform checks are shared by local preview, preflight and final payload validation. */
export function checkWechatDraft(input: DraftContent, finalHtml?: string): DraftCheck {
  const warnings: string[] = [];
  try {
    const problems = validateWechat(input, WECHAT_LIMITS, finalHtml);
    if (input.sourceUrl && !safeHttpUrl.safeParse(input.sourceUrl).success)
      problems.push('原文链接必须是有效的 HTTP 或 HTTPS 地址');
    return {
      problems,
      warnings,
      allowed: problems.length === 0,
      limitsVerified: true,
      limitSource: 'official',
    };
  } catch (error) {
    if (!(error instanceof ContentError)) throw error;
    return {
      problems: [error.message],
      warnings,
      allowed: false,
      limitsVerified: true,
      limitSource: 'official',
    };
  }
}
