import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export const deliveryTargetInput = z.object({ revisionId: uuid, accountId: uuid }).strict();
export const submitDeliveryInput = deliveryTargetInput.extend({ confirmed: z.literal(true) });
export const testInput = z
  .object({ coverId: uuid, requestId: uuid, confirmed: z.literal(true) })
  .strict();
export const resolutionInput = z
  .object({
    outcome: z.enum(['created', 'not_created']),
    note: z.string().trim().min(5).max(1000),
    remoteId: z.string().trim().min(1).max(512).optional(),
    workerStoppedConfirmed: z.literal(true),
  })
  .strict();
export const retryInput = z.object({ confirmed: z.literal(true) }).strict();
export type ActorRequest = { user: { id: string; email: string } };

export function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BadRequestException({
      code: 'INVALID_INPUT',
      message: result.error.issues.map((issue) => issue.message).join('；'),
    });
  return result.data;
}
