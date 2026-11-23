import type { IncomingMessage, ServerResponse } from 'node:http';

export type AiMockMode =
  'success' | 'refused' | 'malformed' | 'disconnect' | 'invalid-image' | 'url' | 'hold';
export type AiMockRequest = {
  capability: 'text' | 'image';
  task: string;
  model: string;
  prompt: string;
  size: string | null;
  responseFormat: string | null;
  authorizationHash: string;
};
export function createAiMock(png: Buffer): {
  calls: { text: number; image: number };
  requests: AiMockRequest[];
  setNext(input: { nextText?: AiMockMode; nextImage?: AiMockMode; release?: boolean }): void;
  releaseAll(): void;
  handle(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    pathname: string,
    body: Buffer,
  ): Promise<boolean>;
};
