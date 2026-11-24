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
export const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const encoder = new TextEncoder();
const byteLength = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const validStoredText = (value: string) => !/[\u0000\uD800-\uDFFF]/u.test(value);
const storedText = z
  .string()
  .max(MAX_CONTENT_BYTES)
  .refine(validStoredText, '内容不能包含空字符或无效 Unicode 字符');
const nodeShape = z
  .object({
    type: z.string().max(40),
    text: storedText.optional(),
    attrs: z.unknown().optional(),
    marks: z
      .array(z.object({ type: z.string(), attrs: z.unknown().optional() }).strict())
      .max(6)
      .optional(),
    content: z.array(z.unknown()).max(5000).optional(),
  })
  .strict();
const emptyAttrs = z.object({}).strict();
const nodeAttrs: Record<string, z.ZodTypeAny> = {
  doc: emptyAttrs,
  text: emptyAttrs,
  paragraph: emptyAttrs,
  heading: z.object({ level: z.union([z.literal(2), z.literal(3)]) }).strict(),
  bulletList: emptyAttrs,
  orderedList: z.object({ start: z.number().int().positive().max(2147483647).optional() }).strict(),
  listItem: emptyAttrs,
  blockquote: emptyAttrs,
  codeBlock: z
    .object({ language: z.string().max(100).refine(validStoredText).nullable().optional() })
    .strict(),
  hardBreak: emptyAttrs,
  horizontalRule: emptyAttrs,
  image: z.object({ assetId: z.string().uuid(), alt: storedText.optional() }).strict(),
};
export const safeHttpUrl = z
  .string()
  .max(MAX_CONTENT_BYTES)
  .refine((value) => {
    if (
      !/^https?:\/\//i.test(value) ||
      /[\u0000-\u0020\u007f]/.test(value) ||
      !validStoredText(value)
    )
      return false;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, '链接必须使用有效的 HTTP 或 HTTPS 地址');
const markAttrs: Record<string, z.ZodTypeAny> = {
  bold: emptyAttrs,
  italic: emptyAttrs,
  strike: emptyAttrs,
  underline: emptyAttrs,
  code: emptyAttrs,
  link: z
    .object({
      href: safeHttpUrl,
      target: z.union([z.literal('_blank'), z.literal('_self'), z.null()]).optional(),
      rel: z
        .union([
          z.literal('noopener noreferrer nofollow'),
          z.literal('noopener noreferrer'),
          z.literal('noreferrer noopener'),
          z.null(),
        ])
        .optional(),
      class: z.null().optional(),
    })
    .strict(),
};
const blockNodes = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'blockquote',
  'codeBlock',
  'horizontalRule',
  'image',
]);
function validChild(parent: string, child: string): boolean {
  if (parent === 'doc' || parent === 'blockquote' || parent === 'listItem')
    return blockNodes.has(child);
  if (parent === 'paragraph' || parent === 'heading')
    return child === 'text' || child === 'hardBreak';
  if (parent === 'bulletList' || parent === 'orderedList') return child === 'listItem';
  return parent === 'codeBlock' && child === 'text';
}
// Validate breadth/depth before traversing children: a recursive Zod schema can overflow first.
export const documentSchema = z
  .unknown()
  .superRefine((document, context) => {
    const root = nodeShape.safeParse(document);
    if (!root.success || root.data.type !== 'doc') {
      context.addIssue({ code: z.ZodIssueCode.custom, message: '正文必须是结构化文档' });
      return;
    }
    const pending: { value: unknown; depth: number; parent?: string }[] = [
      { value: document, depth: 0 },
    ];
    let count = 0;
    let bytes = 0;
    const fail = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, message });
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
      const node = parsed.data;
      const attrs = Object.hasOwn(nodeAttrs, node.type) ? nodeAttrs[node.type] : undefined;
      if (!attrs || !attrs.safeParse(node.attrs === undefined ? {} : node.attrs).success) {
        fail(`不支持的正文块或属性：${node.type}`);
        return;
      }
      if (entry.parent && !validChild(entry.parent, node.type)) {
        fail('正文节点层次无效');
        return;
      }
      if (node.type === 'text') {
        if (!node.text || node.content !== undefined) {
          fail('文字节点必须包含非空文本且不能包含子节点');
          return;
        }
      } else if (
        node.text !== undefined ||
        (node.type !== 'hardBreak' && node.marks !== undefined)
      ) {
        fail('仅文字和换行节点可以包含文字样式');
        return;
      }
      if (
        ['image', 'hardBreak', 'horizontalRule'].includes(node.type) &&
        node.content !== undefined
      ) {
        fail('该正文节点不能包含子节点');
        return;
      }
      if (
        ['bulletList', 'orderedList', 'listItem', 'blockquote'].includes(node.type) &&
        !node.content?.length
      ) {
        fail('列表、列表项和引用不能为空');
        return;
      }
      if (
        node.type === 'listItem' &&
        (node.content?.[0] as { type?: string } | undefined)?.type !== 'paragraph'
      ) {
        fail('列表项必须以段落开头');
        return;
      }
      const marks = new Set<string>();
      for (const mark of node.marks ?? []) {
        const schema = Object.hasOwn(markAttrs, mark.type) ? markAttrs[mark.type] : undefined;
        if (
          !schema ||
          !schema.safeParse(mark.attrs === undefined ? {} : mark.attrs).success ||
          marks.has(mark.type)
        ) {
          fail(`不支持的文字样式或链接：${mark.type}`);
          return;
        }
        marks.add(mark.type);
      }
      if (entry.parent === 'codeBlock' && node.marks?.length) {
        fail('代码块不能包含文字样式');
        return;
      }
      // Count scalar content before serializing the entire tree. Validation above makes
      // attrs/marks flat, so unknown nested objects cannot bypass the traversal bounds.
      bytes += byteLength({ ...node, content: undefined });
      if (bytes > MAX_CONTENT_BYTES) {
        fail('正文超过 2 MiB 应用大小限制');
        return;
      }
      for (const child of node.content ?? [])
        pending.push({ value: child, depth: entry.depth + 1, parent: node.type });
    }
    if (byteLength(document) > MAX_CONTENT_BYTES) fail('正文超过 2 MiB 应用大小限制');
  })
  .transform((value) => value as DocumentNode);
export const articleInput = z.object({
  title: z
    .string()
    .trim()
    .max(MAX_CONTENT_BYTES)
    .refine(validStoredText, '标题不能包含空字符或无效 Unicode 字符')
    .transform((value) => value || '未命名文章'),
  digest: storedText.default(''),
  author: storedText.default(''),
  document: documentSchema,
  coverId: z.string().uuid().nullable().default(null),
  sourceUrl: z.union([z.literal(''), safeHttpUrl]).default(''),
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
export const deliveryCheckInput = deliveryInput.strict();
export const deliverySubmissionInput = deliveryInput
  .extend({ confirmed: z.literal(true) })
  .strict();
export type DeliverySubmissionInput = z.infer<typeof deliverySubmissionInput>;
export type DeliveryCheck = {
  revisionId: string;
  version: number;
  title: string;
  savedAt: string;
  account: { id: string; name: string; platform: Platform };
  problems: string[];
  warnings: string[];
  limitsVerified: boolean;
  canSubmit: boolean;
  existingDelivery: {
    id: string;
    state: DeliveryState;
    remoteId: string | null;
    resultSource: string | null;
  } | null;
};
export type ArticleInput = z.infer<typeof articleInput>;
export type Article = ArticleInput & {
  id: string;
  version: number;
  revisionId: string;
  updatedAt: string;
};
export type ArticleSummary = Pick<Article, 'id' | 'title' | 'version' | 'revisionId' | 'updatedAt'>;
export type RevisionSummary = {
  id: string;
  articleId: string;
  version: number;
  title: string;
  createdAt: string;
};
export type Revision = ArticleInput & RevisionSummary;
export type ArticlePreview = {
  revisionId: string;
  version: number;
  renderVersion: string;
  html: string;
  warnings: string[];
  platformLimitsVerified: boolean;
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

export * from './ai';
export * from './sources';
