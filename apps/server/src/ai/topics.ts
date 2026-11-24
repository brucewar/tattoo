import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, TopicCreation } from '@prisma/client';
import { z } from 'zod';
import {
  topicCreationInput,
  type AiGenerationResult,
  type TopicCreationTask,
} from '@tattoo/contracts';
import { Database } from '../database';
import { ContentService } from '../content/service';
import { inspectDocument } from '../content/document';

const pages = z
  .object({
    page: z.coerce.number().int().min(1).max(1000000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
const retryInput = z.object({ requestKey: z.string().uuid() }).strict();
type ArticleResult = Extract<AiGenerationResult, { type: 'article' }>;

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BadRequestException(result.error.issues.map((issue) => issue.message).join('；'));
  return result.data;
}

function articleResult(result: Prisma.JsonValue | null): ArticleResult | null {
  return result && typeof result === 'object' && !Array.isArray(result) && result.type === 'article'
    ? (result as unknown as ArticleResult)
    : null;
}

@Injectable()
export class TopicCreationService {
  constructor(
    private readonly database: Database,
    private readonly content: ContentService,
  ) {}

  private async publicTask(task: TopicCreation): Promise<TopicCreationTask> {
    const article = task.articleJobId
      ? await this.database.generationJob.findUnique({
          where: { id: task.articleJobId },
          select: { result: true, state: true },
        })
      : null;
    const result = article?.state === 'SUCCEEDED' ? articleResult(article.result) : null;
    const cover = task.coverJobId
      ? await this.database.generationJob.findUnique({
          where: { id: task.coverJobId },
          select: { state: true },
        })
      : null;
    const paused = ['FAILED', 'UNCERTAIN'].includes(task.state) && !task.articleId;
    return {
      id: task.id,
      requestKey: task.requestKey,
      topic: task.topic,
      state: task.state,
      stage: task.stage as TopicCreationTask['stage'],
      articleJobId: task.articleJobId,
      coverJobId: task.coverJobId,
      articleId: task.articleId,
      articleResult: result,
      error: task.error,
      canRetryCover: Boolean(
        result && paused && (!cover || ['FAILED', 'UNCERTAIN'].includes(cover.state)),
      ),
      canResumeSave: Boolean(result && paused && cover?.state === 'SUCCEEDED'),
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      completedAt: task.completedAt?.toISOString() ?? null,
    };
  }

  private async locked(tx: Prisma.TransactionClient, id: string) {
    const found = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM "TopicCreation" WHERE id = ${id}::uuid FOR UPDATE`;
    if (!found.length) throw new NotFoundException('主题创作任务不存在');
    return tx.topicCreation.findUniqueOrThrow({ where: { id } });
  }

  private async enqueue(
    tx: Prisma.TransactionClient,
    task: TopicCreation,
    kind: 'ARTICLE' | 'COVER',
    requestKey: string,
    modelId: string,
    version: number,
    article?: ArticleResult,
  ) {
    const capability = kind === 'ARTICLE' ? 'text' : 'image';
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`tattoo-ai-model:${capability}`}, 0))`;
    const model = await tx.aiModel.findUnique({ where: { capability } });
    if (!model || model.id !== modelId || model.version !== version)
      throw new BadRequestException(
        '主题创作期间模型配置已更改，未使用新配置自动调用；请检查配置后重新生成',
      );
    const prompt =
      kind === 'ARTICLE'
        ? `请围绕下面的主题，自行确定适合中文读者的切入角度、标题、篇幅和文章结构，创作一篇完整、清晰、有观点的文章。直接给出成稿，不要反问用户，不要输出提纲或写作说明。没有参考资料时，不捏造具体数据、引文、来源或未经核实的时事；需要时采用明确的假设和一般性分析。\n\n主题：${task.topic}`
        : `为下面这篇文章设计一张适合内容分享的横向封面。自行选择与主题和文章内容契合的视觉隐喻、风格和构图，画面有重点，清晰耐看。无需文字、字母、标志或水印，避免把整段文章画成文字海报。\n\n创作主题：${task.topic}\n文章标题：${article!.title}\n摘要：${article!.digest}`;
    const sourceText = article
      ? inspectDocument(article.document)
          .text.slice(0, 6000)
          .replace(/[\uD800-\uDBFF]$/, '')
      : '';
    const inputHash = createHash('sha256')
      .update(JSON.stringify({ kind, prompt, sourceText, articleId: null }))
      .digest('hex');
    return tx.generationJob.create({
      data: {
        requestKey,
        topicId: task.id,
        kind,
        capability,
        modelId: model.id,
        model: model.model,
        protocol: model.protocol,
        configVersion: model.version,
        prompt,
        sourceText,
        inputHash,
      },
    });
  }

  async create(value: unknown): Promise<TopicCreationTask> {
    const input = parse(topicCreationInput, value);
    const task = await this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`tattoo-topic:${input.requestKey}`}, 0))`;
      const existing = await tx.topicCreation.findUnique({
        where: { requestKey: input.requestKey },
      });
      if (existing) {
        if (existing.topic !== input.topic)
          throw new ConflictException('同一请求标识已用于其他主题');
        return existing;
      }
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('tattoo-ai-model:text', 0))`;
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('tattoo-ai-model:image', 0))`;
      const text = await tx.aiModel.findUnique({ where: { capability: 'text' } });
      const image = await tx.aiModel.findUnique({ where: { capability: 'image' } });
      if (!text || !image)
        throw new BadRequestException('主题创作需要文本与图片模型，请先在模型配置中分别保存');
      const created = await tx.topicCreation.create({
        data: {
          ...input,
          textModelId: text.id,
          textConfigVersion: text.version,
          imageModelId: image.id,
          imageConfigVersion: image.version,
          coverRequestKey: randomUUID(),
        },
      });
      const job = await this.enqueue(tx, created, 'ARTICLE', randomUUID(), text.id, text.version);
      return tx.topicCreation.update({ where: { id: created.id }, data: { articleJobId: job.id } });
    });
    return this.publicTask(task);
  }

  async get(id: string) {
    const task = await this.database.topicCreation.findUnique({ where: { id } });
    if (!task) throw new NotFoundException('主题创作任务不存在');
    return this.publicTask(task);
  }

  async list(value: unknown) {
    const { page, pageSize } = parse(pages, value);
    const [rows, total] = await this.database.$transaction([
      this.database.topicCreation.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.database.topicCreation.count(),
    ]);
    return {
      items: await Promise.all(rows.map((row) => this.publicTask(row))),
      total,
      page,
      pageSize,
    };
  }

  async retryCover(id: string, value: unknown) {
    const { requestKey } = parse(retryInput, value);
    const updated = await this.database.$transaction(async (tx) => {
      const task = await this.locked(tx, id);
      const repeated = await tx.generationJob.findUnique({ where: { requestKey } });
      if (repeated) {
        if (repeated.topicId !== id || repeated.kind !== 'COVER')
          throw new ConflictException('同一请求标识已用于其他生成内容');
        return task;
      }
      const articleJob = task.articleJobId
        ? await tx.generationJob.findUnique({ where: { id: task.articleJobId } })
        : null;
      const coverJob = task.coverJobId
        ? await tx.generationJob.findUnique({ where: { id: task.coverJobId } })
        : null;
      const article = articleJob?.state === 'SUCCEEDED' ? articleResult(articleJob.result) : null;
      if (
        !article ||
        task.articleId ||
        !['FAILED', 'UNCERTAIN'].includes(task.state) ||
        (coverJob && !['FAILED', 'UNCERTAIN'].includes(coverJob.state))
      )
        throw new ConflictException('当前任务不能单独重新生成封面，请刷新任务状态');
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended('tattoo-ai-model:image', 0))`;
      const model = await tx.aiModel.findUnique({ where: { capability: 'image' } });
      if (!model) throw new BadRequestException('请先配置图片模型');
      const cover = await this.enqueue(
        tx,
        task,
        'COVER',
        requestKey,
        model.id,
        model.version,
        article,
      );
      return tx.topicCreation.update({
        where: { id },
        data: {
          state: 'RUNNING',
          stage: 'COVER',
          error: null,
          completedAt: null,
          coverRequestKey: requestKey,
          coverJobId: cover.id,
          imageModelId: model.id,
          imageConfigVersion: model.version,
        },
      });
    });
    return this.publicTask(updated);
  }

  private async save(
    tx: Prisma.TransactionClient,
    task: TopicCreation,
    assertActive?: () => Promise<void>,
  ) {
    const articleJob = task.articleJobId
      ? await tx.generationJob.findUnique({ where: { id: task.articleJobId } })
      : null;
    const coverJob = task.coverJobId
      ? await tx.generationJob.findUnique({ where: { id: task.coverJobId } })
      : null;
    const article = articleJob?.state === 'SUCCEEDED' ? articleResult(articleJob.result) : null;
    const image =
      coverJob?.state === 'SUCCEEDED' ? (coverJob.result as AiGenerationResult | null) : null;
    if (!article || image?.type !== 'image')
      throw new ConflictException('文章和封面尚未全部成功，不能完成保存');
    const saved = await this.content.createInTransaction(tx, {
      title: article.title,
      digest: article.digest,
      document: article.document,
      coverId: image.asset.id,
      author: '',
      sourceUrl: '',
    });
    await assertActive?.();
    await tx.generationJob.updateMany({
      where: { topicId: task.id },
      data: { articleId: saved.id },
    });
    const updated = await tx.topicCreation.update({
      where: { id: task.id },
      data: {
        state: 'SUCCEEDED',
        stage: 'DONE',
        articleId: saved.id,
        error: null,
        completedAt: new Date(),
      },
    });
    await assertActive?.();
    return updated;
  }

  async resumeSave(id: string, value: unknown) {
    parse(retryInput, value);
    const updated = await this.database.$transaction(async (tx) => {
      const task = await this.locked(tx, id);
      if (task.state === 'SUCCEEDED') return task;
      if (!['FAILED', 'UNCERTAIN'].includes(task.state))
        throw new ConflictException('当前任务无需恢复保存');
      return this.save(tx, task);
    });
    return this.publicTask(updated);
  }

  async recover() {
    return this.database.$transaction(async (tx) => {
      const active = await tx.topicCreation.findMany({
        where: { state: 'RUNNING' },
        select: { id: true },
      });
      if (!active.length) return;
      const ids = active.map((task) => task.id);
      const error = '上次主题创作已中断，未自动继续收费调用；文章候选已保留，请核对后明确重新生成';
      await tx.generationJob.updateMany({
        where: { topicId: { in: ids }, state: { in: ['QUEUED', 'RUNNING'] } },
        data: {
          state: 'UNCERTAIN',
          error,
          executionId: null,
          heartbeatAt: null,
          completedAt: new Date(),
        },
      });
      await tx.topicCreation.updateMany({
        where: { id: { in: ids }, state: 'RUNNING' },
        data: { state: 'UNCERTAIN', error, completedAt: new Date() },
      });
    });
  }

  async processNext(assertActive: () => Promise<void>): Promise<boolean> {
    await assertActive();
    const candidates = await this.database.topicCreation.findMany({
      where: { state: { in: ['QUEUED', 'RUNNING'] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
    });
    for (const candidate of candidates) {
      await assertActive();
      let changed: boolean;
      try {
        changed = await this.database.$transaction(async (tx) => {
          const task = await this.locked(tx, candidate.id);
          if (!['QUEUED', 'RUNNING'].includes(task.state)) return false;
          if (task.state === 'QUEUED') {
            await assertActive();
            await tx.topicCreation.update({ where: { id: task.id }, data: { state: 'RUNNING' } });
            await assertActive();
            return true;
          }
          const articleJob = task.articleJobId
            ? await tx.generationJob.findUnique({ where: { id: task.articleJobId } })
            : null;
          const coverJob = task.coverJobId
            ? await tx.generationJob.findUnique({ where: { id: task.coverJobId } })
            : null;
          const current = task.stage === 'ARTICLE' ? articleJob : coverJob;
          if (!current || ['QUEUED', 'RUNNING'].includes(current.state)) return false;
          await assertActive();
          if (['FAILED', 'UNCERTAIN'].includes(current.state)) {
            await tx.topicCreation.update({
              where: { id: task.id },
              data: { state: current.state, error: current.error, completedAt: new Date() },
            });
            await assertActive();
            return true;
          }
          const article = articleResult(articleJob?.result ?? null);
          if (!article) throw new Error('主题文章结果无效');
          if (task.stage === 'ARTICLE') {
            try {
              const cover = await this.enqueue(
                tx,
                task,
                'COVER',
                task.coverRequestKey,
                task.imageModelId,
                task.imageConfigVersion,
                article,
              );
              await tx.topicCreation.update({
                where: { id: task.id },
                data: { stage: 'COVER', coverJobId: cover.id },
              });
            } catch (error) {
              if (!(error instanceof BadRequestException)) throw error;
              await tx.topicCreation.update({
                where: { id: task.id },
                data: {
                  state: 'FAILED',
                  stage: 'COVER',
                  error: error.message,
                  completedAt: new Date(),
                },
              });
            }
          } else {
            await this.save(tx, task, assertActive);
          }
          await assertActive();
          return true;
        });
      } catch (error) {
        // Losing the Worker lock must abort, rather than turn into an ordinary retryable failure.
        await assertActive();
        const task = await this.database.topicCreation.findUnique({ where: { id: candidate.id } });
        if (!task || !['QUEUED', 'RUNNING'].includes(task.state)) continue;
        const saving = task.stage === 'COVER' || task.stage === 'SAVE';
        await this.database.topicCreation.updateMany({
          where: { id: task.id, state: task.state },
          data: {
            state: 'FAILED',
            stage: saving ? 'SAVE' : task.stage,
            error: saving
              ? '图文结果已保留，保存稿件失败；请检查后恢复保存'
              : '主题任务处理失败，未自动重发模型调用，请检查任务记录',
            completedAt: new Date(),
          },
        });
        return true;
      }
      if (changed) return true;
    }
    return false;
  }
}
