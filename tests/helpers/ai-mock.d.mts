import type { IncomingMessage, ServerResponse } from 'node:http';

export type AiMockMode =
  | 'success'
  | 'refused'
  | 'malformed'
  | 'disconnect'
  | 'invalid-image'
  | 'url'
  | 'hold'
  | 'truncated'
  | 'content-refused'
  | 'tool-output';
export type AiMockRequest = {
  capability: 'text' | 'image';
  protocol: 'chat-completions' | 'responses' | 'anthropic-messages' | 'images-generations';
  task: string;
  model: string;
  prompt: string;
  size: string | null;
  responseFormat: string | null;
  authorizationHash: string;
  xApiKeyHash: string;
  anthropicVersion: string | null;
  maxTokens: number | null;
  store: boolean | null;
  stream: boolean | null;
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
