import { z } from 'zod';

export const sourceOrigins = ['url', 'rss', 'search'] as const;
export type SourceOrigin = (typeof sourceOrigins)[number];
export const sourceJobKinds = ['URL', 'FEED', 'SEARCH'] as const;
export type SourceJobKind = (typeof sourceJobKinds)[number];
export type SourceJobState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNCERTAIN';

const safeText = (maximum: number) =>
  z
    .string()
    .max(maximum)
    .refine((value) => !/[\u0000\uD800-\uDFFF]/u.test(value), '内容包含无效字符');

export const sourceFeedInput = z
  .object({
    url: z.string().trim().min(1).max(4000),
    title: safeText(200)
      .transform((value) => value.trim())
      .default(''),
  })
  .strict();
export type SourceFeedInput = z.infer<typeof sourceFeedInput>;

export const sourceSearchConfigInput = z
  .object({
    baseUrl: z.string().trim().min(1).max(2000).default('https://api.tavily.com'),
    apiKey: z
      .string()
      .trim()
      .max(4096)
      .refine((value) => !/[^\x21-\x7e]/.test(value), 'API Key 只能包含不带空格的可打印英文字符')
      .optional(),
    clearApiKey: z.boolean().default(false),
  })
  .strict();
export type SourceSearchConfigInput = z.infer<typeof sourceSearchConfigInput>;

export const sourceJobInput = z.discriminatedUnion('kind', [
  z
    .object({
      requestKey: z.string().uuid(),
      kind: z.literal('URL'),
      url: z.string().trim().min(1).max(4000),
      origin: z.enum(['url', 'search']).default('url'),
    })
    .strict(),
  z
    .object({ requestKey: z.string().uuid(), kind: z.literal('FEED'), feedId: z.string().uuid() })
    .strict(),
  z
    .object({
      requestKey: z.string().uuid(),
      kind: z.literal('SEARCH'),
      query: safeText(1000)
        .transform((value) => value.trim())
        .refine(Boolean, '请输入搜索词'),
    })
    .strict(),
]);
export type SourceJobInput = z.infer<typeof sourceJobInput>;

export type Source = {
  id: string;
  url: string;
  resolvedUrl: string;
  title: string;
  text: string;
  contentKind: 'article' | 'feed';
  origin: SourceOrigin;
  feedId: string | null;
  feedUrl: string | null;
  publishedAt: string | null;
  contentHash: string;
  fetchedAt: string;
  createdAt: string;
  updatedAt: string;
};
export type SourceSummary = Omit<Source, 'text'> & { textLength: number };
export type SourceReferenceSnapshot = Pick<
  Source,
  'id' | 'title' | 'url' | 'contentHash' | 'fetchedAt'
>;
export type SourceFeed = {
  id: string;
  url: string;
  title: string;
  lastFetchedAt: string | null;
  lastError: string | null;
  createdAt: string;
};
export type SourceSearchConfig = {
  baseUrl: string;
  hasApiKey: boolean;
  version: number;
  updatedAt: string;
};
export type SourceSearchResult = { title: string; url: string; snippet: string };
export type SourceJobResult = {
  sourceIds: string[];
  items: SourceSearchResult[];
  created: number;
  updated: number;
};
export type SourceJob = {
  id: string;
  requestKey: string;
  kind: SourceJobKind;
  state: SourceJobState;
  url: string;
  feedId: string | null;
  query: string;
  origin: SourceOrigin;
  configVersion: number | null;
  result: SourceJobResult | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
