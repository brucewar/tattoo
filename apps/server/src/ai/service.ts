import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AiModel, GenerationJob, Prisma } from '@prisma/client';
import { z } from 'zod';
import {
  aiGenerationInput,
  aiModelInput,
  type AiCapability,
  type AiGenerationInput,
  type AiGenerationJob,
  type AiGenerationResult,
  type AiGenerationSummary,
  type AiModelConfig,
  type AiModels,
} from '@tattoo/contracts';
import { Database } from '../database';
import type { Config } from '../config';
import { SecretBox } from '../security';
import { AssetsService } from '../assets/assets.module';
import { AiProviderError, normalizeModelBaseUrl, OpenAiProvider } from './provider';

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new BadRequestException(parsed.error.issues.map((item) => item.message).join('；'));
  return parsed.data;
}

function capability(kind: string): AiCapability {
  return ['COVER', 'ILLUSTRATION', 'TEST_IMAGE'].includes(kind) ? 'image' : 'text';
}

const pageInput = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  articleId: z.string().uuid().optional(),
});

@Injectable()
export class AiService {
  private readonly secrets: SecretBox;
  constructor(
    private readonly database: Database,
    @Inject('APP_CONFIG') private readonly config: Config,
    private readonly assets: AssetsService,
    private readonly provider: OpenAiProvider = new OpenAiProvider(),
  ) {
    this.secrets = new SecretBox(config.APP_ENCRYPTION_KEY);
  }

  private async publicModel(model: AiModel): Promise<AiModelConfig> {
    const verification = await this.database.generationJob.findFirst({
      where: {
        modelId: model.id,
        configVersion: model.version,
        kind: model.capability === 'text' ? 'TEST_TEXT' : 'TEST_IMAGE',
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return {
      capability: model.capability,
      protocol: model.protocol as AiModelConfig['protocol'],
      baseUrl: model.baseUrl,
      model: model.model,
      hasApiKey: Boolean(model.apiKeyEncrypted),
      version: model.version,
      imageSize: model.imageSize,
      imageResponseFormat: model.imageResponseFormat as AiModelConfig['imageResponseFormat'],
      anthropicMaxTokens: model.anthropicMaxTokens,
      updatedAt: model.updatedAt.toISOString(),
      lastValidation: verification
        ? {
            jobId: verification.id,
            state: verification.state,
            checkedAt: verification.completedAt?.toISOString() ?? null,
            error: verification.error,
          }
        : null,
    };
  }

  async listModels(): Promise<AiModels> {
    const models = await this.database.aiModel.findMany();
    const result: AiModels = { text: null, image: null };
    for (const model of models) result[model.capability] = await this.publicModel(model);
    return result;
  }

  async saveModel(kind: unknown, value: unknown): Promise<AiModelConfig> {
    const selected = parse(z.enum(['text', 'image']), kind);
    const input = parse(aiModelInput, value);
    const protocol =
      input.protocol ?? (selected === 'text' ? 'chat-completions' : 'images-generations');
    if ((selected === 'image') !== (protocol === 'images-generations'))
      throw new BadRequestException('所选协议不支持这项模型能力，请分别配置文本与图片模型');
    if (input.clearApiKey && input.apiKey)
      throw new BadRequestException('清除密钥和设置新密钥不能同时执行');
    let baseUrl: string;
    try {
      baseUrl = normalizeModelBaseUrl(input.baseUrl, this.config.NODE_ENV === 'test');
    } catch (error) {
      throw new BadRequestException(
        error instanceof AiProviderError ? error.message : '模型服务地址无效',
      );
    }
    if (
      /[\u0000-\u001f\u007f]/.test(input.model) ||
      (input.apiKey && /[\u0000-\u0020\u007f]/.test(input.apiKey))
    )
      throw new BadRequestException('模型名称或密钥包含无效字符');
    if (input.imageSize && !/^(?:auto|[1-9]\d{1,4}x[1-9]\d{1,4})$/.test(input.imageSize))
      throw new BadRequestException('图片尺寸请留空、填写 auto 或形如 1536x1024 的尺寸');
    const model = await this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`tattoo-ai-model:${selected}`}, 0))`;
      const existing = await tx.aiModel.findUnique({ where: { capability: selected } });
      if (
        existing &&
        (await tx.generationJob.findFirst({
          where: { modelId: existing.id, state: 'RUNNING' },
          select: { id: true },
        }))
      )
        throw new ConflictException('该模型正在生成内容，请等待任务结束后再修改配置');
      const fields = {
        protocol,
        baseUrl,
        model: input.model,
        imageSize: selected === 'image' ? input.imageSize : '',
        imageResponseFormat: selected === 'image' ? input.imageResponseFormat : 'auto',
        anthropicMaxTokens: protocol === 'anthropic-messages' ? input.anthropicMaxTokens : 4096,
      };
      if (
        existing?.apiKeyEncrypted &&
        new URL(existing.baseUrl).origin !== new URL(baseUrl).origin &&
        !input.apiKey &&
        !input.clearApiKey
      )
        throw new BadRequestException('更改服务来源时，请重新输入 API Key，或明确清除已保存密钥');
      if (
        existing &&
        !input.apiKey &&
        !input.clearApiKey &&
        existing.baseUrl === fields.baseUrl &&
        existing.model === fields.model &&
        existing.protocol === fields.protocol &&
        existing.anthropicMaxTokens === fields.anthropicMaxTokens &&
        existing.imageSize === fields.imageSize &&
        existing.imageResponseFormat === fields.imageResponseFormat
      )
        return existing;
      const apiKeyEncrypted = input.clearApiKey
        ? ''
        : input.apiKey
          ? this.secrets.encrypt(input.apiKey)
          : (existing?.apiKeyEncrypted ?? '');
      return existing
        ? tx.aiModel.update({
            where: { id: existing.id },
            data: { ...fields, apiKeyEncrypted, version: { increment: 1 } },
          })
        : tx.aiModel.create({ data: { ...fields, apiKeyEncrypted, capability: selected } });
    });
    return this.publicModel(model);
  }

  private publicJob(job: GenerationJob): AiGenerationJob {
    return {
      id: job.id,
      requestKey: job.requestKey,
      kind: job.kind,
      capability: job.capability,
      protocol: job.protocol as AiGenerationJob['protocol'],
      model: job.model,
      configVersion: job.configVersion,
      state: job.state,
      prompt: job.prompt,
      sourceText: job.sourceText,
      sourceReferences: job.sourceReferences as AiGenerationJob['sourceReferences'],
      articleId: job.articleId,
      result: job.result as AiGenerationResult | null,
      error: job.error,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
    };
  }

  async createJob(value: unknown): Promise<AiGenerationJob> {
    const input = parse(aiGenerationInput, value);
    const providedSourceText = input.sourceText ?? '';
    const sourceIds = input.sourceIds ?? [];
    const inputHash = createHash('sha256')
      .update(
        JSON.stringify({
          kind: input.kind,
          prompt: input.prompt,
          sourceText: providedSourceText,
          ...(sourceIds.length ? { sourceIds } : {}),
          articleId: input.articleId ?? null,
        }),
      )
      .digest('hex');
    const previous = await this.database.generationJob.findUnique({
      where: { requestKey: input.requestKey },
    });
    if (previous) {
      if (previous.inputHash !== inputHash)
        throw new ConflictException('同一请求标识已用于其他生成内容，请重新发起');
      return this.publicJob(previous);
    }
    const selectedSources = sourceIds.length
      ? await this.database.source.findMany({ where: { id: { in: sourceIds } } })
      : [];
    if (selectedSources.length !== sourceIds.length)
      throw new NotFoundException('选择的资料不存在，请刷新资料列表后重新选择');
    const orderedSources = sourceIds.map((id) =>
      selectedSources.find((source) => source.id === id)!,
    );
    if (orderedSources.some((source) => !source.text.trim()))
      throw new BadRequestException('选择的资料没有文字，请先提取正文或选择其他资料');
    const sourceReferences = orderedSources.map((source) => ({
      id: source.id,
      title: source.title,
      url: source.url,
      contentHash: source.contentHash,
      fetchedAt: source.fetchedAt.toISOString(),
    }));
    const sourceText = [
      providedSourceText,
      ...orderedSources.map(
        (source, index) =>
          `参考资料 ${index + 1}\n标题：${source.title}\n来源：${source.url}\n获取时间：${source.fetchedAt.toISOString()}\n资料类型：${source.contentKind === 'feed' ? 'RSS 文字（可能为摘要）' : '网页正文'}\n正文：\n${source.text}`,
      ),
    ]
      .filter(Boolean)
      .join('\n\n');
    if (sourceText.length > 80000 || /[\u0000\uD800-\uDFFF]/u.test(sourceText))
      throw new BadRequestException(
        '参考资料总长度超过 80000 字符或包含无效文字，请减少资料后重新生成',
      );
    if (
      input.articleId &&
      !(await this.database.article.findUnique({
        where: { id: input.articleId },
        select: { id: true },
      }))
    )
      throw new NotFoundException('关联文章不存在');
    const selected = capability(input.kind);
    const model = await this.database.aiModel.findUnique({ where: { capability: selected } });
    if (!model)
      throw new BadRequestException(
        `请先在模型配置中保存${selected === 'text' ? '文本' : '图片'}模型`,
      );
    try {
      const job = await this.database.generationJob.create({
        data: {
          requestKey: input.requestKey,
          kind: input.kind,
          capability: selected,
          modelId: model.id,
          model: model.model,
          protocol: model.protocol,
          configVersion: model.version,
          prompt: input.prompt,
          sourceText,
          sourceReferences: sourceReferences as Prisma.InputJsonValue,
          articleId: input.articleId ?? null,
          inputHash,
        },
      });
      return this.publicJob(job);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        const repeated = await this.database.generationJob.findUnique({
          where: { requestKey: input.requestKey },
        });
        if (repeated?.inputHash === inputHash) return this.publicJob(repeated);
        if (repeated) throw new ConflictException('同一请求标识已用于其他生成内容，请重新发起');
      }
      throw error;
    }
  }

  async getJob(id: string): Promise<AiGenerationJob> {
    const job = await this.database.generationJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('生成任务不存在');
    return this.publicJob(job);
  }

  async listJobs(query: unknown) {
    const { page, pageSize, articleId } = parse(pageInput, query);
    const where = articleId ? { articleId } : {};
    const [rows, total] = await this.database.$transaction([
      this.database.generationJob.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.database.generationJob.count({ where }),
    ]);
    const items: AiGenerationSummary[] = rows.map((row) => {
      const {
        prompt: _prompt,
        sourceText: _sourceText,
        result: _result,
        ...summary
      } = this.publicJob(row);
      return summary;
    });
    return { items, total, page, pageSize };
  }

  async recover() {
    return this.database.generationJob.updateMany({
      where: { state: 'RUNNING' },
      data: {
        state: 'UNCERTAIN',
        error: '上次模型执行已中断，未自动重发；请核对服务记录后手动重新生成',
        executionId: null,
        heartbeatAt: null,
        completedAt: new Date(),
      },
    });
  }

  async processNext(assertActive: () => Promise<void>): Promise<boolean> {
    await assertActive();
    const candidate = await this.database.generationJob.findFirst({
      where: { state: 'QUEUED' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!candidate) return false;
    const executionId = randomUUID();
    const claimed = await this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtextextended(${`tattoo-ai-model:${candidate.capability}`}, 0))`;
      const job = await tx.generationJob.findUnique({
        where: { id: candidate.id },
        include: { modelConfig: true },
      });
      if (!job || job.state !== 'QUEUED') return null;
      if (job.modelConfig.version !== job.configVersion) {
        await tx.generationJob.update({
          where: { id: job.id },
          data: {
            state: 'FAILED',
            error: '排队期间模型配置已更改，请检查新配置后重新生成',
            completedAt: new Date(),
          },
        });
        return { invalidated: true as const };
      }
      const changed = await tx.generationJob.updateMany({
        where: { id: job.id, state: 'QUEUED' },
        data: { state: 'RUNNING', executionId, heartbeatAt: new Date(), startedAt: new Date() },
      });
      return changed.count ? { invalidated: false as const, job, model: job.modelConfig } : null;
    });
    if (!claimed) return false;
    if (claimed.invalidated) return true;
    const { job, model } = claimed;
    const controller = new AbortController();
    let checking = false;
    const guard = async () => {
      try {
        await assertActive();
        const owned = await this.database.generationJob.updateMany({
          where: { id: job.id, executionId, state: 'RUNNING' },
          data: { heartbeatAt: new Date() },
        });
        if (!owned.count) throw new Error('生成执行权已变更');
        await assertActive();
      } catch (error) {
        controller.abort();
        throw error;
      }
    };
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
      const key = model.apiKeyEncrypted ? this.secrets.decrypt(model.apiKeyEncrypted) : '';
      const input: AiGenerationInput = {
        requestKey: job.requestKey,
        kind: job.kind,
        prompt: job.prompt,
        sourceText: job.sourceText,
        ...(job.articleId ? { articleId: job.articleId } : {}),
      };
      const generated = await this.provider.generate(model, input, key, controller.signal);
      await guard();
      let result: AiGenerationResult;
      if (generated.type === 'image') {
        const asset = await this.assets.upload(
          generated.buffer,
          `ai-${job.kind.toLowerCase()}-${job.id}.png`,
        );
        result = { type: 'image', asset };
      } else result = generated;
      await guard();
      await this.database.generationJob.updateMany({
        where: { id: job.id, executionId, state: 'RUNNING' },
        data: {
          state: 'SUCCEEDED',
          result: result as Prisma.InputJsonValue,
          error: null,
          completedAt: new Date(),
          executionId: null,
          heartbeatAt: null,
        },
      });
    } catch (error) {
      const uncertain =
        controller.signal.aborted || (error instanceof AiProviderError && error.uncertain);
      const message =
        error instanceof AiProviderError
          ? error.message
          : controller.signal.aborted
            ? '生成执行已中断，未自动重发；请核对服务记录后手动生成'
            : '生成内容处理失败，请检查模型输出和图片格式后重新生成';
      await this.database.generationJob
        .updateMany({
          where: { id: job.id, executionId, state: 'RUNNING' },
          data: {
            state: uncertain ? 'UNCERTAIN' : 'FAILED',
            error: message,
            completedAt: new Date(),
            executionId: null,
            heartbeatAt: null,
          },
        })
        .catch(() => undefined);
    } finally {
      clearInterval(timer);
      controller.abort();
    }
    return true;
  }
}
