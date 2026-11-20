import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Article as ArticleRecord, Prisma, Revision as RevisionRecord } from '@prisma/client';
import {
  articleInput,
  saveArticleInput,
  type Article,
  type ArticleInput,
  type DocumentNode,
} from '@tattoo/contracts';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Database } from '../database';
import { ContentError, inspectDocument } from './document';
import { renderDocument, RENDER_VERSION } from '../platforms/wechat/renderer';
import { checkWechatDraft } from '../platforms/wechat/check';

const pageInput = z
  .object({
    page: z.coerce.number().int().min(1).max(2_147_483_647).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()
  .refine(({ page, pageSize }) => (page - 1) * pageSize <= 2_147_483_647, '页码超出范围');
const previewInput = z.object({ revisionId: z.string().uuid() }).strict();
type CurrentArticle = ArticleRecord & { currentRevision: RevisionRecord | null };

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BadRequestException(result.error.issues.map((issue) => issue.message).join('；'));
  return result.data;
}

// Document validation bounds the depth before canonical serialization is reached.
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function revisionFields(revision: RevisionRecord): ArticleInput {
  return {
    title: revision.title,
    author: revision.author,
    digest: revision.digest,
    sourceUrl: revision.sourceUrl,
    coverId: revision.coverId,
    document: revision.document as DocumentNode,
  };
}

function publicArticle(article: CurrentArticle): Article {
  if (!article.currentRevision) throw new NotFoundException('稿件尚无可用修订');
  return {
    ...revisionFields(article.currentRevision),
    id: article.id,
    version: article.version,
    revisionId: article.currentRevision.id,
    updatedAt: article.updatedAt.toISOString(),
  };
}

function publicRevision(revision: RevisionRecord) {
  return {
    ...revisionFields(revision),
    id: revision.id,
    articleId: revision.articleId,
    version: revision.version,
    createdAt: revision.createdAt.toISOString(),
  };
}

function content(input: unknown, expectedVersion: boolean) {
  const parsed = expectedVersion
    ? parse(saveArticleInput.strict(), input)
    : parse(articleInput.strict(), input);
  const data: ArticleInput = {
    title: parsed.title,
    digest: parsed.digest,
    author: parsed.author,
    sourceUrl: parsed.sourceUrl,
    document: parsed.document,
    coverId: parsed.coverId,
  };
  if (Buffer.byteLength(JSON.stringify(data), 'utf8') > 2 * 1024 * 1024)
    throw new BadRequestException('稿件超过 2 MiB 应用保存上限');
  let assetIds: string[];
  try {
    assetIds = inspectDocument(data.document).assetIds;
  } catch (error) {
    if (error instanceof ContentError) throw new BadRequestException(error.message);
    throw error;
  }
  if (data.coverId) assetIds.push(data.coverId);
  return {
    data,
    assetIds: [...new Set(assetIds)],
    hash: createHash('sha256').update(stableJson(data)).digest('hex'),
    expectedVersion: 'expectedVersion' in parsed ? (parsed.expectedVersion as number) : undefined,
  };
}

async function checkAssets(transaction: Prisma.TransactionClient, assetIds: string[]) {
  if (!assetIds.length) return;
  const count = await transaction.asset.count({ where: { id: { in: assetIds } } });
  if (count !== assetIds.length)
    throw new BadRequestException('稿件引用的素材不存在，请重新上传图片后保存');
}

@Injectable()
export class ContentService {
  constructor(private readonly database: Database) {}

  async list(input: unknown = {}) {
    const { page, pageSize } = parse(pageInput, input);
    const where = { isTest: false, currentRevisionId: { not: null } };
    const [items, total] = await this.database.$transaction([
      this.database.article.findMany({
        where,
        select: {
          id: true,
          version: true,
          updatedAt: true,
          currentRevision: { select: { id: true, title: true } },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.database.article.count({ where }),
    ]);
    return {
      items: items.map((article) => ({
        id: article.id,
        title: article.currentRevision!.title,
        version: article.version,
        revisionId: article.currentRevision!.id,
        updatedAt: article.updatedAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  async get(id: string) {
    const article = await this.database.article.findFirst({
      where: { id, isTest: false },
      include: { currentRevision: true },
    });
    if (!article) throw new NotFoundException('稿件不存在');
    return publicArticle(article);
  }

  async create(input: unknown) {
    const { data, hash, assetIds } = content(input, false);
    return this.database.$transaction(async (transaction) => {
      await checkAssets(transaction, assetIds);
      const article = await transaction.article.create({ data: {} });
      const revision = await transaction.revision.create({
        data: {
          ...data,
          document: data.document as Prisma.InputJsonValue,
          articleId: article.id,
          version: 1,
          contentHash: hash,
          assets: { create: assetIds.map((assetId) => ({ assetId })) },
        },
      });
      return publicArticle(
        await transaction.article.update({
          where: { id: article.id },
          data: { currentRevisionId: revision.id },
          include: { currentRevision: true },
        }),
      );
    });
  }

  async update(id: string, input: unknown) {
    const { data, hash, assetIds, expectedVersion } = content(input, true);
    return this.database.$transaction(async (transaction) => {
      // The row lock also serializes unchanged saves against concurrent changed saves.
      const locked = await transaction.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Article" WHERE id = ${id}::uuid AND "isTest" = false FOR UPDATE
      `;
      if (!locked.length) throw new NotFoundException('稿件不存在');
      const article = await transaction.article.findUniqueOrThrow({
        where: { id },
        include: { currentRevision: true },
      });
      if (article.version !== expectedVersion)
        throw new ConflictException({
          code: 'VERSION_CONFLICT',
          message: '稿件已被其他窗口修改，请保留当前内容并重新载入后再保存',
          details: {
            currentVersion: article.version,
            currentRevisionId: article.currentRevisionId,
          },
        });
      if (article.currentRevision?.contentHash === hash) return publicArticle(article);
      await checkAssets(transaction, assetIds);
      const version = article.version + 1;
      const revision = await transaction.revision.create({
        data: {
          ...data,
          document: data.document as Prisma.InputJsonValue,
          articleId: id,
          version,
          contentHash: hash,
          assets: { create: assetIds.map((assetId) => ({ assetId })) },
        },
      });
      const updated = await transaction.article.updateMany({
        where: { id, version: expectedVersion },
        data: { version, currentRevisionId: revision.id },
      });
      if (updated.count !== 1) throw new ConflictException('稿件已变化，请重新载入后再保存');
      return publicArticle(
        await transaction.article.findUniqueOrThrow({
          where: { id },
          include: { currentRevision: true },
        }),
      );
    });
  }

  async revisions(id: string, input: unknown = {}) {
    const { page, pageSize } = parse(pageInput, input);
    if (
      !(await this.database.article.findFirst({
        where: { id, isTest: false, currentRevisionId: { not: null } },
        select: { id: true },
      }))
    )
      throw new NotFoundException('稿件不存在');
    const [items, total] = await this.database.$transaction([
      this.database.revision.findMany({
        where: { articleId: id },
        orderBy: { version: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: { id: true, articleId: true, version: true, title: true, createdAt: true },
      }),
      this.database.revision.count({ where: { articleId: id } }),
    ]);
    return {
      items: items.map((revision) => ({
        ...revision,
        createdAt: revision.createdAt.toISOString(),
      })),
      total,
      page,
      pageSize,
    };
  }

  async revision(id: string, revisionId: string) {
    const revision = await this.database.revision.findFirst({
      where: { id: revisionId, articleId: id, article: { isTest: false } },
    });
    if (!revision) throw new NotFoundException('稿件修订不存在');
    return publicRevision(revision);
  }

  async preview(id: string, input: unknown) {
    const { revisionId } = parse(previewInput, input);
    const revision = await this.revision(id, revisionId);
    try {
      const inspected = inspectDocument(revision.document);
      const warnings: string[] = [];
      if (!revision.coverId) warnings.push('尚未设置封面；投递前需要补齐');
      if (!inspected.text.trim() && !inspected.assetIds.length)
        warnings.push('正文为空；投递前需要补齐');
      const html = renderDocument(revision.document);
      const checked = checkWechatDraft(revision, html);
      warnings.push(
        ...checked.problems.filter(
          (problem) => !['请上传文章封面', '正文不能为空'].includes(problem),
        ),
        ...checked.warnings,
      );
      return {
        revisionId,
        version: revision.version,
        renderVersion: RENDER_VERSION,
        html,
        warnings,
        platformLimitsVerified: checked.limitsVerified,
      };
    } catch (error) {
      if (error instanceof ContentError) throw new BadRequestException(error.message);
      throw error;
    }
  }
}
