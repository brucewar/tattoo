import { z } from 'zod';
import type { AiGenerationResult, AiGenerationState } from './ai';

export const topicCreationInput = z
  .object({
    requestKey: z.string().uuid(),
    topic: z
      .string()
      .trim()
      .min(1, '请填写创作主题')
      .max(2000)
      .refine((value) => !/[\u0000\uD800-\uDFFF]/u.test(value), '主题包含无效文字'),
  })
  .strict();
export type TopicCreationInput = z.infer<typeof topicCreationInput>;
export type TopicCreationStage = 'ARTICLE' | 'COVER' | 'SAVE' | 'DONE';
export type TopicCreationTask = {
  id: string;
  requestKey: string;
  topic: string;
  state: AiGenerationState;
  stage: TopicCreationStage;
  articleJobId: string | null;
  coverJobId: string | null;
  articleId: string | null;
  articleResult: Extract<AiGenerationResult, { type: 'article' }> | null;
  error: string | null;
  canRetryCover: boolean;
  canResumeSave: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};
