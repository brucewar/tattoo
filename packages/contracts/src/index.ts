import { z } from 'zod';

export const platforms = ['wechat'] as const;
export type Platform = (typeof platforms)[number];
export type Capability = 'supported' | 'unsupported' | 'unverified';
export type DeliveryState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNCERTAIN';
export type DocumentNode = {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: DocumentNode[];
};
const nodeShape = z.object({
  type: z.string().max(40),
  text: z.string().max(100000).optional(),
  attrs: z.record(z.unknown()).optional(),
  marks: z
    .array(z.object({ type: z.string(), attrs: z.record(z.unknown()).optional() }))
    .max(10)
    .optional(),
  content: z.array(z.unknown()).max(1000).optional(),
});
// Validate breadth/depth before traversing children: a recursive Zod schema can overflow first.
export const documentSchema = z
  .unknown()
  .superRefine((document, context) => {
    const root = nodeShape.safeParse(document);
    if (!root.success || root.data.type !== 'doc') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: '正文必须是结构化文档' });
      return;
    }
    const pending = [{ value: document, depth: 0 }];
    let count = 0;
    while (pending.length) {
      const entry = pending.pop()!;
      if (++count > 5000 || entry.depth > 30) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: '正文结构过深或节点过多' });
        return;
      }
      const parsed = nodeShape.safeParse(entry.value);
      if (!parsed.success) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: '正文节点结构无效' });
        return;
      }
      for (const child of parsed.data.content ?? [])
        pending.push({ value: child, depth: entry.depth + 1 });
    }
  })
  .transform((value) => value as DocumentNode);
export const articleInput = z.object({
  title: z
    .string()
    .trim()
    .max(200)
    .transform((value) => value || '未命名文章'),
  digest: z.string().max(500).default(''),
  author: z.string().max(50).default(''),
  document: documentSchema,
  coverId: z.string().uuid().nullable().default(null),
  sourceUrl: z
    .union([
      z.literal(''),
      z
        .string()
        .url()
        .refine((u) => /^https?:\/\//.test(u)),
    ])
    .default(''),
});
export const saveArticleInput = articleInput.extend({
  expectedVersion: z.number().int().positive(),
});
export const accountInput = z.object({
  name: z.string().trim().min(1).max(60),
  appId: z.string().regex(/^wx[a-zA-Z0-9]{8,40}$/, '请输入公众号 AppID'),
  appSecret: z.string().trim().min(16).max(128),
});
export const loginInput = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(256),
});
export const deliveryInput = z.object({
  revisionId: z.string().uuid(),
  accountId: z.string().uuid(),
});
export type ArticleInput = z.infer<typeof articleInput>;
export type Article = ArticleInput & {
  id: string;
  version: number;
  revisionId: string;
  updatedAt: string;
};
export type Account = {
  id: string;
  name: string;
  platform: Platform;
  appId: string;
  credentialVersion: number;
  capabilities: { readDraft: CapabilityCheck; saveDraft: CapabilityCheck };
};
export type CapabilityCheck = {
  status: Capability;
  verifiedAt?: string;
  source?: 'api';
  error?: string;
};
export type Asset = { id: string; name: string; mime: string; size: number; url: string };
export type Delivery = {
  id: string;
  state: DeliveryState;
  revisionId: string;
  createdAt: string;
  updatedAt: string;
  remoteId: string | null;
  error: string | null;
  stage: string;
  account: { id: string; name: string; platform: Platform };
  revision: { id: string; title: string; version: number; articleId: string };
};
export const initialDocument: DocumentNode = { type: 'doc', content: [{ type: 'paragraph' }] };
