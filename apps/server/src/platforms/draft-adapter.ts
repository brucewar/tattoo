import type { Account, Prisma } from '@prisma/client';
import type { DocumentNode } from '@tattoo/contracts';
import type { AccountLockGuard } from '../accounts/lock';

export { PlatformError } from './platform-error';
export const PLATFORM_DRAFT_ADAPTER = Symbol('PLATFORM_DRAFT_ADAPTER');
export type PlatformExecutionGuard = AccountLockGuard & {
  deadlineAt?: number;
  beforeRequest?: () => Promise<void>;
};
export type DraftContent = {
  title: string;
  author: string;
  digest: string;
  sourceUrl: string;
  coverId: string | null;
  document: DocumentNode;
};
export type DraftCheck = {
  problems: string[];
  warnings: string[];
  limitsVerified: boolean;
  limitSource: 'official' | 'unverified';
  allowed: boolean;
};
export type PreparedDraft = { payload: Prisma.InputJsonValue; html: string };

/** Only the operations needed by the current draft use case are exposed. */
export interface PlatformDraftAdapter {
  readonly platform: 'wechat';
  readonly renderVersion: string;
  check(input: DraftContent, finalHtml?: string): DraftCheck;
  prepareDraft(
    input: DraftContent & { coverReference: string; imageUrls: Record<string, string> },
  ): PreparedDraft;
  uploadCover(account: Account, buffer: Buffer, guard?: PlatformExecutionGuard): Promise<string>;
  uploadBodyImage(
    account: Account,
    buffer: Buffer,
    guard?: PlatformExecutionGuard,
  ): Promise<string>;
  createDraft(
    account: Account,
    payload: unknown,
    guard?: PlatformExecutionGuard,
  ): Promise<{ remoteId: string; platformResult: Prisma.InputJsonValue }>;
}
