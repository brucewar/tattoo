import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type {
  Prisma,
  Source as SourceRow,
  SourceFeed as FeedRow,
  SourceJob as JobRow,
  SourceSearchConfig as SearchRow,
} from '@prisma/client';
import { z } from 'zod';
import {
  sourceFeedInput,
  sourceJobInput,
  sourceSearchConfigInput,
  type Source,
  type SourceFeed,
  type SourceJob,
  type SourceJobResult,
  type SourceSearchConfig,
  type SourceSummary,
} from '@tattoo/contracts';
import { Database } from '../database';
import type { Config } from '../config';
import { SecretBox } from '../security';
import { normalizeSourceUrl, SourceReader, SourceReaderError } from './reader';
import { normalizeSearchBaseUrl, SourceSearchError, TavilySearch } from './tavily';

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new BadRequestException(result.error.issues.map((issue) => issue.message).join('；'));
  return result.data;
}
const pageInput = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(200).optional(),
});
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const searchLock = 'tattoo-sources-search-config';
const feedLock = (id: string) => `tattoo-source-feed:${id}`;

@Injectable()
export class SourcesService {
  private readonly secrets: SecretBox;
  private readonly reader: SourceReader;
  private readonly search: TavilySearch;
  constructor(
    private readonly database: Database,
    @Inject('APP_CONFIG') private readonly config: Config,
  ) {
    this.secrets = new SecretBox(config.APP_ENCRYPTION_KEY);
    const testOrigin = config.NODE_ENV === 'test' ? config.SOURCES_TEST_ORIGIN : undefined;
    this.reader = new SourceReader({ testOrigin });
    this.search = new TavilySearch(fetch, 30000, testOrigin);
  }

  private normalizeUrl(value: string) {
    try {
      return normalizeSourceUrl(value);
    } catch (error) {
      throw new BadRequestException(
        error instanceof SourceReaderError ? error.message : '请输入有效的公开资料地址',
      );
    }
  }
  private publicSource(row: SourceRow): Source {
    return {
      id: row.id,
      url: row.url,
      resolvedUrl: row.resolvedUrl,
      title: row.title,
      text: row.text,
      contentHash: row.contentHash,
      contentKind: row.contentKind as Source['contentKind'],
      origin: row.origin as Source['origin'],
      feedId: row.feedId,
      feedUrl: row.feedUrl,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      fetchedAt: row.fetchedAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  private publicFeed(row: FeedRow): SourceFeed {
    return {
      id: row.id,
      url: row.url,
      title: row.title,
      lastFetchedAt: row.lastFetchedAt?.toISOString() ?? null,
      lastError: row.lastError,
      createdAt: row.createdAt.toISOString(),
    };
  }
  private publicJob(row: JobRow): SourceJob {
    return {
      id: row.id,
      requestKey: row.requestKey,
      kind: row.kind,
      state: row.state,
      url: row.url,
      feedId: row.feedId,
      query: row.query,
      origin: row.origin as SourceJob['origin'],
      configVersion: row.configVersion,
      result: row.result as SourceJobResult | null,
      error: row.error,
      startedAt: row.startedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
  private publicConfig(row: SearchRow): SourceSearchConfig {
    return {
      baseUrl: row.baseUrl,
      hasApiKey: Boolean(row.apiKeyEncrypted),
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async listSources(query: unknown) {
    const { page, pageSize, search } = parse(pageInput, query);
    const where: Prisma.SourceWhereInput = search
      ? {
          OR: [
            { title: { contains: search, mode: 'insensitive' } },
            { text: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};
    const [rows, total] = await this.database.$transaction([
      this.database.source.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.database.source.count({ where }),
    ]);
    const items: SourceSummary[] = rows.map((row) => {
      const { text, ...source } = this.publicSource(row);
      return { ...source, textLength: text.length };
    });
    return { items, total, page, pageSize };
  }
  async getSource(id: string) {
    const row = await this.database.source.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('资料不存在');
    return this.publicSource(row);
  }
  async listFeeds(query: unknown) {
    const { page, pageSize } = parse(pageInput, query);
    const [rows, total] = await this.database.$transaction([
      this.database.sourceFeed.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.database.sourceFeed.count(),
    ]);
    return { items: rows.map((row) => this.publicFeed(row)), total, page, pageSize };
  }
  async createFeed(value: unknown) {
    const input = parse(sourceFeedInput, value);
    const url = this.normalizeUrl(input.url);
    const row = await this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('tattoo-source-feeds', 0))`;
      const existing = await tx.sourceFeed.findUnique({ where: { urlHash: digest(url) } });
      if (existing) return existing;
      if ((await tx.sourceFeed.count()) >= 100)
        throw new BadRequestException('最多保存 100 个 RSS 订阅，请先取消不需要的订阅');
      return tx.sourceFeed.create({ data: { url, urlHash: digest(url), title: input.title } });
    });
    return this.publicFeed(row);
  }
  async deleteFeed(id: string) {
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${feedLock(id)}, 0))`;
      if (!(await tx.sourceFeed.findUnique({ where: { id } })))
        throw new NotFoundException('RSS 订阅不存在');
      if (
        await tx.sourceJob.findFirst({
          where: { feedId: id, state: 'RUNNING' },
          select: { id: true },
        })
      )
        throw new ConflictException('该订阅正在拉取，请等待任务结束后再取消');
      await tx.sourceFeed.delete({ where: { id } });
      return { id };
    });
  }
  async getSearchConfig(): Promise<SourceSearchConfig | null> {
    const row = await this.database.sourceSearchConfig.findUnique({ where: { id: 'default' } });
    return row ? this.publicConfig(row) : null;
  }
  async saveSearchConfig(value: unknown) {
    const input = parse(sourceSearchConfigInput, value);
    if (input.clearApiKey && input.apiKey)
      throw new BadRequestException('清除密钥和设置新密钥不能同时执行');
    let baseUrl: string;
    try {
      baseUrl = normalizeSearchBaseUrl(input.baseUrl);
    } catch (error) {
      throw new BadRequestException(
        error instanceof SourceSearchError ? error.message : '搜索服务地址无效',
      );
    }
    const row = await this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${searchLock}, 0))`;
      if (
        await tx.sourceJob.findFirst({
          where: { kind: 'SEARCH', state: 'RUNNING' },
          select: { id: true },
        })
      )
        throw new ConflictException('搜索正在执行，请等待任务结束后修改配置');
      const existing = await tx.sourceSearchConfig.findUnique({ where: { id: 'default' } });
      if (
        existing?.apiKeyEncrypted &&
        new URL(existing.baseUrl).origin !== new URL(baseUrl).origin &&
        !input.apiKey &&
        !input.clearApiKey
      )
        throw new BadRequestException(
          '更改搜索服务来源时，请重新输入 API Key，或明确清除已保存密钥',
        );
      if (existing && existing.baseUrl === baseUrl && !input.apiKey && !input.clearApiKey)
        return existing;
      const apiKeyEncrypted = input.clearApiKey
        ? ''
        : input.apiKey
          ? this.secrets.encrypt(input.apiKey)
          : (existing?.apiKeyEncrypted ?? '');
      return existing
        ? tx.sourceSearchConfig.update({
            where: { id: existing.id },
            data: { baseUrl, apiKeyEncrypted, version: { increment: 1 } },
          })
        : tx.sourceSearchConfig.create({ data: { id: 'default', baseUrl, apiKeyEncrypted } });
    });
    return this.publicConfig(row);
  }
  async createJob(value: unknown): Promise<SourceJob> {
    const input = parse(sourceJobInput, value);
    const normalized = {
      kind: input.kind,
      url: input.kind === 'URL' ? this.normalizeUrl(input.url) : '',
      feedId: input.kind === 'FEED' ? input.feedId : null,
      query: input.kind === 'SEARCH' ? input.query : '',
      origin: input.kind === 'URL' ? input.origin : input.kind === 'FEED' ? 'rss' : 'search',
    };
    const inputHash = digest(JSON.stringify(normalized));
    const previous = await this.database.sourceJob.findUnique({
      where: { requestKey: input.requestKey },
    });
    if (previous) {
      if (previous.inputHash !== inputHash)
        throw new ConflictException('同一请求标识已用于其它资料获取，请重新发起');
      return this.publicJob(previous);
    }
    let url = normalized.url;
    let configVersion: number | null = null;
    if (input.kind === 'FEED') {
      const feed = await this.database.sourceFeed.findUnique({ where: { id: input.feedId } });
      if (!feed) throw new NotFoundException('RSS 订阅不存在');
      url = feed.url;
    } else if (input.kind === 'SEARCH') {
      const config = await this.database.sourceSearchConfig.findUnique({
        where: { id: 'default' },
      });
      if (!config?.apiKeyEncrypted)
        throw new BadRequestException('请先保存 Tavily 搜索配置和 API Key');
      configVersion = config.version;
    }
    try {
      const row = await this.database.sourceJob.create({
        data: {
          ...normalized,
          origin: normalized.origin,
          url,
          requestKey: input.requestKey,
          inputHash,
          configVersion,
        },
      });
      return this.publicJob(row);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        const row = await this.database.sourceJob.findUnique({
          where: { requestKey: input.requestKey },
        });
        if (row?.inputHash === inputHash) return this.publicJob(row);
        if (row) throw new ConflictException('同一请求标识已用于其它资料获取，请重新发起');
      }
      throw error;
    }
  }
  async listJobs(query: unknown) {
    const { page, pageSize } = parse(pageInput, query);
    const [rows, total] = await this.database.$transaction([
      this.database.sourceJob.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.database.sourceJob.count(),
    ]);
    return { items: rows.map((row) => this.publicJob(row)), total, page, pageSize };
  }
  async getJob(id: string) {
    const row = await this.database.sourceJob.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('资料获取任务不存在');
    return this.publicJob(row);
  }
  async recover() {
    return this.database.sourceJob.updateMany({
      where: { state: 'RUNNING' },
      data: {
        state: 'UNCERTAIN',
        error: '上次资料获取已中断，未自动重发；搜索请先核对服务记录再手动重试',
        executionId: null,
        heartbeatAt: null,
        completedAt: new Date(),
      },
    });
  }

  async processNext(assertActive: () => Promise<void>): Promise<boolean> {
    await assertActive();
    const candidate = await this.database.sourceJob.findFirst({
      where: { state: 'QUEUED' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!candidate) return false;
    const executionId = randomUUID();
    const claimed = await this.database.$transaction(async (tx) => {
      if (candidate.kind === 'SEARCH')
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${searchLock}, 0))`;
      if (candidate.feedId)
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${feedLock(candidate.feedId)}, 0))`;
      const job = await tx.sourceJob.findUnique({ where: { id: candidate.id } });
      if (!job || job.state !== 'QUEUED') return null;
      const search =
        job.kind === 'SEARCH'
          ? await tx.sourceSearchConfig.findUnique({ where: { id: 'default' } })
          : null;
      const feed = job.feedId
        ? await tx.sourceFeed.findUnique({ where: { id: job.feedId } })
        : null;
      const error =
        job.kind === 'SEARCH' && (!search?.apiKeyEncrypted || search.version !== job.configVersion)
          ? '排队期间搜索配置已更改，请检查新配置后重新搜索'
          : job.kind === 'FEED' && !feed
            ? '该 RSS 订阅已取消，未发出获取请求'
            : null;
      if (error) {
        await tx.sourceJob.updateMany({
          where: { id: job.id, state: 'QUEUED' },
          data: { state: 'FAILED', error, completedAt: new Date() },
        });
        return { invalidated: true as const };
      }
      const changed = await tx.sourceJob.updateMany({
        where: { id: job.id, state: 'QUEUED' },
        data: { state: 'RUNNING', executionId, heartbeatAt: new Date(), startedAt: new Date() },
      });
      return changed.count ? { invalidated: false as const, job, search, feed } : null;
    });
    if (!claimed) return false;
    if (claimed.invalidated) return true;
    const { job, search, feed } = claimed;
    const controller = new AbortController();
    const guard = async () => {
      try {
        await assertActive();
        const owned = await this.database.sourceJob.updateMany({
          where: { id: job.id, state: 'RUNNING', executionId },
          data: { heartbeatAt: new Date() },
        });
        if (!owned.count) throw new Error('资料获取执行权已改变');
        await assertActive();
      } catch (error) {
        controller.abort();
        throw error;
      }
    };
    let checking = false;
    const timer = setInterval(() => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      void guard()
        .catch(() => controller.abort())
        .finally(() => {
          checking = false;
        });
    }, 5000);
    try {
      await guard();
      const content =
        job.kind === 'URL' ? await this.reader.article(job.url, controller.signal) : null;
      const collected =
        job.kind === 'FEED' ? await this.reader.feed(job.url, controller.signal) : null;
      const items =
        job.kind === 'SEARCH' && search
          ? await this.search.search(
              search.baseUrl,
              this.secrets.decrypt(search.apiKeyEncrypted),
              job.query,
              controller.signal,
            )
          : [];
      await guard();
      await this.database.$transaction(async (tx) => {
        const owned = await tx.sourceJob.updateMany({
          where: { id: job.id, state: 'RUNNING', executionId },
          data: { heartbeatAt: new Date() },
        });
        if (!owned.count || controller.signal.aborted) throw new Error('资料获取执行权已改变');
        const result: SourceJobResult = { sourceIds: [], items, created: 0, updated: 0 };
        if (content) {
          const saved = await this.storeSource(tx, {
            ...content,
            origin: job.origin,
            contentKind: 'article',
          });
          result.sourceIds.push(saved.id);
          result.created += saved.created;
          result.updated += saved.updated;
        }
        if (collected && feed) {
          const seen = new Set<string>();
          for (const item of collected.items) {
            if (seen.has(item.url)) continue;
            seen.add(item.url);
            const saved = await this.storeSource(tx, {
              ...item,
              resolvedUrl: '',
              contentKind: 'feed',
              origin: 'rss',
              feedId: feed.id,
              feedUrl: feed.url,
            });
            result.sourceIds.push(saved.id);
            result.created += saved.created;
            result.updated += saved.updated;
          }
          await tx.sourceFeed.update({
            where: { id: feed.id },
            data: {
              lastFetchedAt: new Date(),
              lastError: null,
              ...(!feed.title && collected.title ? { title: collected.title } : {}),
            },
          });
        }
        try {
          await assertActive();
        } catch (error) {
          controller.abort();
          throw error;
        }
        if (controller.signal.aborted) throw new Error('资料获取执行权已改变');
        const finished = await tx.sourceJob.updateMany({
          where: { id: job.id, state: 'RUNNING', executionId },
          data: {
            state: 'SUCCEEDED',
            result: result as Prisma.InputJsonValue,
            error: null,
            executionId: null,
            heartbeatAt: null,
            completedAt: new Date(),
          },
        });
        if (!finished.count) throw new Error('资料获取执行权已改变');
      });
    } catch (error) {
      const known = error instanceof SourceReaderError || error instanceof SourceSearchError;
      const uncertain =
        controller.signal.aborted || (error instanceof SourceSearchError && error.uncertain);
      const message = known
        ? error.message
        : uncertain
          ? '获取执行已中断，未自动重发；搜索请先核对服务记录再手动重试'
          : '资料获取处理失败，请检查地址、内容格式或搜索配置';
      await this.database
        .$transaction(async (tx) => {
          const changed = await tx.sourceJob.updateMany({
            where: { id: job.id, state: 'RUNNING', executionId },
            data: {
              state: uncertain ? 'UNCERTAIN' : 'FAILED',
              error: message,
              executionId: null,
              heartbeatAt: null,
              completedAt: new Date(),
            },
          });
          if (changed.count && job.feedId)
            await tx.sourceFeed.updateMany({
              where: { id: job.feedId },
              data: { lastError: message },
            });
        })
        .catch(() => undefined);
    } finally {
      clearInterval(timer);
      controller.abort();
    }
    return true;
  }

  private async storeSource(
    tx: Prisma.TransactionClient,
    value: {
      url: string;
      resolvedUrl: string;
      title: string;
      text: string;
      publishedAt: string | null;
      origin: string;
      contentKind: 'article' | 'feed';
      feedId?: string;
      feedUrl?: string;
    },
  ) {
    const url = normalizeSourceUrl(value.url);
    const existing = await tx.source.findUnique({ where: { urlHash: digest(url) } });
    if (existing?.contentKind === 'article' && value.contentKind === 'feed') {
      if (!existing.feedUrl && value.feedUrl)
        await tx.source.update({
          where: { id: existing.id },
          data: { feedId: value.feedId, feedUrl: value.feedUrl },
        });
      return { id: existing.id, created: 0, updated: 0 };
    }
    const publishedAt = value.publishedAt ? new Date(value.publishedAt) : null;
    const fields = {
      resolvedUrl: value.resolvedUrl,
      title: value.title,
      text: value.text,
      contentHash: digest(value.text),
      contentKind: value.contentKind,
      publishedAt: publishedAt && Number.isFinite(publishedAt.getTime()) ? publishedAt : null,
    };
    if (existing) {
      const changed =
        existing.contentHash !== fields.contentHash ||
        existing.title !== fields.title ||
        existing.contentKind !== fields.contentKind ||
        existing.resolvedUrl !== fields.resolvedUrl ||
        existing.publishedAt?.getTime() !== fields.publishedAt?.getTime();
      await tx.source.update({
        where: { id: existing.id },
        data: {
          ...fields,
          fetchedAt: new Date(),
          ...(!existing.feedUrl && value.feedUrl
            ? { feedUrl: value.feedUrl, feedId: value.feedId }
            : {}),
        },
      });
      return { id: existing.id, created: 0, updated: changed ? 1 : 0 };
    }
    const row = await tx.source.create({
      data: {
        ...fields,
        url,
        urlHash: digest(url),
        origin: value.origin,
        feedId: value.feedId ?? null,
        feedUrl: value.feedUrl ?? null,
      },
    });
    return { id: row.id, created: 1, updated: 0 };
  }
}
