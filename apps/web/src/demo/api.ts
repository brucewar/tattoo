import {
  articleInput,
  aiGenerationInput,
  topicCreationInput,
  type Article,
  type ArticleInput,
  type Revision,
  type DocumentNode,
  type AiModels,
  type AiGenerationJob,
  type TopicCreationTask,
  type Asset,
  type Source,
} from '@tattoo/contracts';
import { ApiError } from '../api';
import { fields, fingerprint } from '../components/article/model';
import { renderDemoDocument } from './preview';

const stateKey = 'tattoo:demo:v1';
export const assetPrefix = 'tattoo:demo:asset:';
export const coverId = '00000000-0000-4000-8000-000000000001';
const coverUrl = new URL('./cover.svg', import.meta.url).href;
const createdAt = '2026-11-28T00:00:00.000Z';
type StorageAccess = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
type State = {
  articles: Article[];
  revisions: Revision[];
  jobs: AiGenerationJob[];
  topics: TopicCreationTask[];
};
const paragraph = (text: string): DocumentNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

function sampleArticle(topic: string): ArticleInput {
  return {
    title: topic,
    author: 'Tattoo 演示',
    digest: '从一个想法开始，体验资料整理、文章编辑、保存修订与微信预览。',
    sourceUrl: '',
    coverId,
    document: {
      type: 'doc',
      content: [
        paragraph(
          '这是一篇本地演示文章。你可以修改标题和正文，插入图片，保存后查看修订历史与微信排版预览。',
        ),
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: '从灵感到可回看的内容' }],
        },
        paragraph(
          '把零散的想法留在自己的工作台。先记录核心观点，再整理资料，最后让文章形成清晰的结构。每次明确保存，都会留下一份独立修订。',
        ),
        { type: 'blockquote', content: [paragraph('好的写作，从留下第一个想法开始。')] },
        {
          type: 'heading',
          attrs: { level: 2 },
          content: [{ type: 'text', text: '试着完成第一篇文章' }],
        },
        {
          type: 'bulletList',
          content: [
            '修改文章标题、作者与摘要。',
            '在正文中添加段落、列表或图片。',
            '保存文章，打开修订历史和微信预览。',
          ].map((text) => ({ type: 'listItem', content: [paragraph(text)] })),
        },
        paragraph(
          '演示中的 AI 返回固定示例内容，不会调用真实模型。完整版本支持配置自己的模型与公众号；请在自己的实例中进行真实投递。',
        ),
      ],
    },
  };
}

function seed(): State {
  const articles = [
    '把一个主题，变成一篇有封面的文章',
    '为自己的写作建立一个资料库',
    '周末写作计划：留一点时间给灵感',
  ].map((title, index): Article => ({
    ...sampleArticle(title),
    id: `00000000-0000-4000-8000-00000000001${index}`,
    revisionId: `00000000-0000-4000-8000-00000000002${index}`,
    version: 1,
    updatedAt: createdAt,
  }));
  return { articles, revisions: articles.map(toRevision), jobs: [], topics: [] };
}

function toRevision(article: Article): Revision {
  return {
    ...fields(article),
    id: article.revisionId,
    articleId: article.id,
    version: article.version,
    createdAt: article.updatedAt,
  };
}

const models: AiModels = {
  text: {
    capability: 'text',
    protocol: 'chat-completions',
    baseUrl: 'https://demo.invalid/v1',
    model: '本地示例文本（模拟）',
    hasApiKey: true,
    version: 1,
    imageSize: '',
    imageResponseFormat: 'auto',
    anthropicMaxTokens: 4096,
    updatedAt: createdAt,
    lastValidation: null,
  },
  image: {
    capability: 'image',
    protocol: 'images-generations',
    baseUrl: 'https://demo.invalid/v1',
    model: '本地示例封面（模拟）',
    hasApiKey: true,
    version: 1,
    imageSize: '1200x675',
    imageResponseFormat: 'auto',
    anthropicMaxTokens: 4096,
    updatedAt: createdAt,
    lastValidation: null,
  },
};
const sources: Source[] = [
  {
    id: '00000000-0000-4000-8000-000000000030',
    title: 'Tattoo：从灵感到草稿',
    url: 'https://github.com/brucewar/tattoo',
    resolvedUrl: 'https://github.com/brucewar/tattoo',
    text: '这是一份预置演示资料。Tattoo 是为个人与 NAS 自托管准备的内容工作台：收集资料、AI 创作、编辑修订，再把确认后的文章存入微信公众号草稿。演示站不联网采集资料。',
    contentKind: 'article',
    origin: 'url',
    feedId: null,
    feedUrl: null,
    publishedAt: null,
    contentHash: 'demo-local-source',
    fetchedAt: createdAt,
    createdAt,
    updatedAt: createdAt,
  },
];

function notFound(): never {
  throw new ApiError('演示内容不存在，请重置演示后重试。', 404, 'DEMO_NOT_FOUND');
}
function blocked(): never {
  throw new ApiError(
    '在线演示不执行此操作，也不保存凭证。请部署自己的工作台后使用。',
    403,
    'DEMO_DISABLED',
  );
}
function bodyOf(options: RequestInit): unknown {
  try {
    return JSON.parse(String(options.body ?? '{}'));
  } catch {
    throw new ApiError('演示请求格式无效。', 400, 'DEMO_INVALID_INPUT');
  }
}
function persist(storage: StorageAccess, state: State) {
  try {
    storage.setItem(stateKey, JSON.stringify(state));
  } catch {
    throw new ApiError(
      '浏览器无法保存演示数据，可能存储已满或被禁用。请减少图片大小或重置演示后重试。',
      507,
      'DEMO_STORAGE_FULL',
    );
  }
}

export function createDemoApi(storage: StorageAccess) {
  return async (path: string, options: RequestInit = {}): Promise<unknown> => {
    options.signal?.throwIfAborted();
    const method = (options.method ?? 'GET').toUpperCase();
    const url = new URL(path, 'https://demo.invalid');
    const route = url.pathname;
    let state: State;
    try {
      const stored = storage.getItem(stateKey);
      state = stored ? JSON.parse(stored) : seed();
      if (
        !['articles', 'revisions', 'jobs', 'topics'].every((key) =>
          Array.isArray(state[key as keyof State]),
        )
      )
        state = seed();
    } catch {
      state = seed();
    }
    const page = <T>(items: T[]) => {
      const current = Math.max(1, Number(url.searchParams.get('page')) || 1);
      const size = Math.max(1, Math.min(100, Number(url.searchParams.get('pageSize')) || 20));
      return {
        items: items.slice((current - 1) * size, current * size),
        total: items.length,
        page: current,
        pageSize: size,
      };
    };
    const saveArticle = (input: ArticleInput, previous?: Article) => {
      if (previous && fingerprint(previous) === fingerprint(input)) return previous;
      const article: Article = {
        ...input,
        id: previous?.id ?? crypto.randomUUID(),
        revisionId: crypto.randomUUID(),
        version: (previous?.version ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
      state.articles = [article, ...state.articles.filter((item) => item.id !== article.id)];
      state.revisions.unshift(toRevision(article));
      return article;
    };
    if (method === 'GET') {
      if (route === '/auth/me')
        return { id: 'demo', email: 'demo@tattoo.local', remoteWritesEnabled: false };
      if (route === '/auth/security')
        return { totpEnabled: false, recoveryCodesRemaining: 0, otherSessionsCount: 0 };
      if (route === '/articles') return page(state.articles);
      if (route === '/ai/models') return structuredClone(models);
      if (route === '/ai/jobs') return page(state.jobs);
      if (route === '/ai/topics') return page(state.topics);
      if (route === '/accounts')
        return page([
          {
            id: '00000000-0000-4000-8000-000000000040',
            name: 'Tattoo 演示公众号（未连接）',
            platform: 'wechat',
            appId: 'wxDEMO00000000',
            credentialVersion: 1,
            capabilities: {
              readDraft: { status: 'unverified' },
              saveDraft: { status: 'unverified' },
            },
          },
        ]);
      if (route === '/deliveries' || route === '/sources/feeds' || route === '/sources/jobs')
        return page([]);
      if (route === '/sources/search-config') return null;
      if (route === '/sources') {
        const search = url.searchParams.get('search')?.toLowerCase() ?? '';
        return page(
          sources
            .filter((item) => `${item.title} ${item.text}`.toLowerCase().includes(search))
            .map(({ text, ...item }) => ({ ...item, textLength: text.length })),
        );
      }
      if (route.startsWith('/sources/'))
        return structuredClone(
          sources.find((item) => item.id === route.split('/')[2]) ?? notFound(),
        );
      if (route.startsWith('/ai/jobs/'))
        return state.jobs.find((item) => item.id === route.split('/')[3]) ?? notFound();
      if (route.startsWith('/ai/topics/'))
        return state.topics.find((item) => item.id === route.split('/')[3]) ?? notFound();
      const match = /^\/articles\/([^/]+)(?:\/revisions(?:\/([^/]+))?)?$/.exec(route);
      if (match) {
        const article = state.articles.find((item) => item.id === match[1]) ?? notFound();
        if (match[2])
          return (
            state.revisions.find((item) => item.articleId === article.id && item.id === match[2]) ??
            notFound()
          );
        if (route.endsWith('/revisions'))
          return page(
            state.revisions
              .filter((item) => item.articleId === article.id)
              .sort((a, b) => b.version - a.version),
          );
        return article;
      }
      return notFound();
    }
    if (method === 'POST' && route === '/assets') {
      if (
        !(options.body instanceof Blob) ||
        !['image/png', 'image/jpeg'].includes(options.body.type)
      )
        throw new ApiError('请选择 JPG 或 PNG 图片。', 400, 'DEMO_INVALID_IMAGE');
      if (options.body.size > 2 * 1024 * 1024)
        throw new ApiError('演示图片请控制在 2 MiB 以内。', 413, 'DEMO_IMAGE_TOO_LARGE');
      const id = crypto.randomUUID();
      const blob = options.body;
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () =>
          reject(new ApiError('无法读取本地图片。', 400, 'DEMO_IMAGE_READ_FAILED'));
        reader.readAsDataURL(blob);
      });
      options.signal?.throwIfAborted();
      try {
        storage.setItem(`${assetPrefix}${id}`, data);
      } catch {
        throw new ApiError(
          '浏览器图片存储已满或被禁用，请重置演示后重试。',
          507,
          'DEMO_STORAGE_FULL',
        );
      }
      return {
        id,
        url: data,
        name: '本地演示图片',
        mime: blob.type,
        size: blob.size,
      } satisfies Asset;
    }
    if (
      (method === 'POST' && route === '/articles') ||
      (method === 'PATCH' && /^\/articles\/[^/]+$/.test(route))
    ) {
      const input = bodyOf(options);
      const parsed = articleInput.safeParse(input);
      if (!parsed.success)
        throw new ApiError(
          parsed.error.issues[0]?.message ?? '文章格式无效。',
          400,
          'DEMO_INVALID_INPUT',
        );
      const previous =
        method === 'PATCH'
          ? (state.articles.find((item) => item.id === route.split('/')[2]) ?? notFound())
          : undefined;
      if (previous && (input as { expectedVersion?: number }).expectedVersion !== previous.version)
        throw new ApiError('文章已在另一处更新，请加载最新修订。', 409, 'DEMO_CONFLICT');
      const article = saveArticle(parsed.data, previous);
      persist(storage, state);
      return article;
    }
    const preview = /^\/articles\/([^/]+)\/preview$/.exec(route);
    if (method === 'POST' && preview) {
      const { revisionId } = bodyOf(options) as { revisionId?: string };
      const revision =
        state.revisions.find((item) => item.articleId === preview[1] && item.id === revisionId) ??
        notFound();
      return {
        revisionId: revision.id,
        version: revision.version,
        renderVersion: 'demo-v1',
        html: renderDemoDocument(revision.document),
        warnings: ['本地演示排版，未连接微信公众号；最终效果以自己实例中的微信后台为准。'],
        platformLimitsVerified: false,
      };
    }
    if (method === 'POST' && route === '/ai/topics') {
      const parsed = topicCreationInput.safeParse(bodyOf(options));
      if (!parsed.success) throw new ApiError('请填写有效的创作主题。', 400, 'DEMO_INVALID_INPUT');
      const previous = state.topics.find((item) => item.requestKey === parsed.data.requestKey);
      if (previous) return previous;
      const article = saveArticle(sampleArticle(`${parsed.data.topic}（演示示例）`));
      const task: TopicCreationTask = {
        id: crypto.randomUUID(),
        requestKey: parsed.data.requestKey,
        topic: parsed.data.topic,
        state: 'SUCCEEDED',
        stage: 'DONE',
        articleJobId: null,
        coverJobId: null,
        articleId: article.id,
        articleResult: {
          type: 'article',
          title: article.title,
          digest: article.digest,
          document: article.document,
        },
        error: null,
        canRetryCover: false,
        canResumeSave: false,
        createdAt: article.updatedAt,
        updatedAt: article.updatedAt,
        completedAt: article.updatedAt,
      };
      state.topics.unshift(task);
      persist(storage, state);
      return task;
    }
    if (method === 'POST' && route === '/ai/jobs') {
      const parsed = aiGenerationInput.safeParse(bodyOf(options));
      if (!parsed.success) throw new ApiError('请检查生成要求。', 400, 'DEMO_INVALID_INPUT');
      const input = parsed.data;
      const previous = state.jobs.find((item) => item.requestKey === input.requestKey);
      if (previous) return previous;
      const image = ['COVER', 'ILLUSTRATION', 'TEST_IMAGE'].includes(input.kind);
      const now = new Date().toISOString();
      const sample = sampleArticle(`${input.prompt.slice(0, 60) || '第一篇文章'}（演示示例）`);
      const job: AiGenerationJob = {
        id: crypto.randomUUID(),
        requestKey: input.requestKey,
        kind: input.kind,
        capability: image ? 'image' : 'text',
        protocol: image ? 'images-generations' : 'chat-completions',
        model: '本地固定示例（模拟）',
        configVersion: 1,
        state: 'SUCCEEDED',
        prompt: input.prompt,
        sourceText: input.sourceText ?? '',
        sourceReferences: [],
        articleId: input.articleId ?? null,
        result: image
          ? {
              type: 'image',
              asset: {
                id: coverId,
                url: coverUrl,
                mime: 'image/svg+xml',
                size: 1200,
                name: '演示封面',
              },
            }
          : input.kind === 'ARTICLE'
            ? {
                type: 'article',
                title: sample.title,
                digest: sample.digest,
                document: sample.document,
              }
            : {
                type: 'text',
                text: '这是本地固定的演示文字，用来体验候选内容的采用流程。部署自己的工作台并配置模型后，可以使用真实 AI 创作。',
              },
        error: null,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        completedAt: now,
      };
      state.jobs.unshift(job);
      persist(storage, state);
      return job;
    }
    // Never fall through to fetch: Pages has no API, and credentials must not be stored.
    return blocked();
  };
}

const browserStorage: StorageAccess = {
  getItem: (key) => localStorage.getItem(key),
  setItem: (key, value) => localStorage.setItem(key, value),
  removeItem: (key) => localStorage.removeItem(key),
  key: (index) => localStorage.key(index),
  get length() {
    return localStorage.length;
  },
};
export const demoApi = createDemoApi(browserStorage);

export function resetDemo() {
  // Keep theme preferences and unrelated data on the same GitHub Pages origin.
  for (const storage of [localStorage, sessionStorage]) {
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (
        key &&
        (key.startsWith('tattoo:demo:') ||
          key.startsWith('tattoo:topic-creation:') ||
          key.startsWith('tattoo:ai:'))
      )
        storage.removeItem(key);
    }
  }
}
