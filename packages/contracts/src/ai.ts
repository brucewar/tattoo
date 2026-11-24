import { z } from 'zod';
import type { Asset, DocumentNode } from './index';

export const aiCapabilities = ['text', 'image'] as const;
export type AiCapability = (typeof aiCapabilities)[number];
export const aiTextProtocols = ['chat-completions', 'responses', 'anthropic-messages'] as const;
export type AiTextProtocol = (typeof aiTextProtocols)[number];
export const aiProtocols = [...aiTextProtocols, 'images-generations'] as const;
export type AiProtocol = (typeof aiProtocols)[number];
export const aiGenerationKinds = [
  'ARTICLE',
  'REWRITE',
  'COVER',
  'ILLUSTRATION',
  'TEST_TEXT',
  'TEST_IMAGE',
] as const;
export type AiGenerationKind = (typeof aiGenerationKinds)[number];
export type AiGenerationState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'UNCERTAIN';
export type AiImageResponseFormat = 'auto' | 'b64_json' | 'url';

const safeText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !/[\u0000\uD800-\uDFFF]/u.test(value), '内容包含无效字符');

export const aiModelInput = z
  .object({
    protocol: z.enum(aiProtocols).optional(),
    baseUrl: z.string().trim().min(1).max(2000),
    model: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !/[\u0000\uD800-\uDFFF]/u.test(value), '模型名称包含无效字符'),
    apiKey: z
      .string()
      .trim()
      .max(4096)
      .refine((value) => !/[^\x21-\x7e]/.test(value), 'API Key 只能包含不带空格的可打印英文字符')
      .optional(),
    clearApiKey: z.boolean().default(false),
    imageSize: z.string().trim().max(30).default(''),
    imageResponseFormat: z.enum(['auto', 'b64_json', 'url']).default('auto'),
    anthropicMaxTokens: z.number().int().min(1).max(128000).default(4096),
  })
  .strict();
export type AiModelInput = z.infer<typeof aiModelInput>;

export const aiGenerationInput = z
  .object({
    requestKey: z.string().uuid(),
    kind: z.enum(aiGenerationKinds),
    prompt: safeText(6000).default(''),
    sourceText: safeText(80000).optional(),
    articleId: z.string().uuid().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.kind.startsWith('TEST_') && !value.prompt.trim())
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['prompt'],
        message: '请填写生成要求',
      });
    if (value.kind === 'REWRITE' && !value.sourceText?.trim())
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceText'],
        message: '请提供需要改写的内容',
      });
  });
export type AiGenerationInput = z.infer<typeof aiGenerationInput>;

export type AiValidation = {
  jobId: string;
  state: AiGenerationState;
  checkedAt: string | null;
  error: string | null;
};
export type AiModelConfig = {
  capability: AiCapability;
  protocol: AiProtocol;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  version: number;
  imageSize: string;
  imageResponseFormat: AiImageResponseFormat;
  anthropicMaxTokens: number;
  updatedAt: string;
  lastValidation: AiValidation | null;
};
export type AiModels = { text: AiModelConfig | null; image: AiModelConfig | null };
export type AiGenerationResult =
  | { type: 'article'; title: string; digest: string; document: DocumentNode }
  | { type: 'text'; text: string }
  | { type: 'image'; asset: Asset };
export type AiGenerationJob = {
  id: string;
  requestKey: string;
  kind: AiGenerationKind;
  capability: AiCapability;
  protocol: AiProtocol;
  model: string;
  configVersion: number;
  state: AiGenerationState;
  prompt: string;
  sourceText: string;
  articleId: string | null;
  result: AiGenerationResult | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};
export type AiGenerationSummary = Omit<AiGenerationJob, 'prompt' | 'sourceText' | 'result'>;
