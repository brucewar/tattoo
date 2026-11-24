import type { IncomingMessage, ServerResponse } from 'node:http';

export type SourcesMockMode = 'success' | 'hold' | 'disconnect' | 'refused' | 'malformed';
export type SourcesMockControl = {
  nextArticle?: SourcesMockMode;
  nextFeed?: SourcesMockMode;
  nextSearch?: SourcesMockMode;
  articleVersion?: number;
  release?: boolean;
};
export function createSourcesMock(): {
  calls: { article: number; feed: number; search: number };
  requests: {
    kind: string;
    path: string;
    authorizationHash: string;
    query?: string;
    payload?: {
      topic: string;
      search_depth: string;
      auto_parameters: boolean;
      max_results: number;
      include_answer: boolean;
      include_raw_content: boolean;
      include_images: boolean;
      bodyHasApiKey: boolean;
    };
  }[];
  control(input?: SourcesMockControl): void;
  releaseAll(): void;
  handle(
    incoming: IncomingMessage,
    outgoing: ServerResponse,
    pathname: string,
    bytes: Buffer,
  ): Promise<boolean>;
};
