import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
import type { DocumentNode } from '@tattoo/contracts';
import { Database } from '../database';
import type { Config } from '../config';
import { AccountsService } from '../accounts/accounts.module';
import { AssetsService } from '../assets/assets.module';
import { inspectDocument } from '../content/document';
import { PLATFORM_DRAFT_ADAPTER, type PlatformDraftAdapter } from '../platforms/draft-adapter';
import { WORKER_LOCK, SAVE_DRAFT_ACTION } from './publishing.constants';
import {
  deliveryTargetInput,
  submitDeliveryInput,
  parse,
  testInput,
  retryInput,
  resolutionInput,
} from './publishing.dto';
import { publicDelivery } from './publishing.presenter';
import { PublishingExecutor } from './publishing.executor';

@Injectable()
export class PublishingService {
  constructor(
    private readonly database: Database,
    private readonly accounts: AccountsService,
    private readonly assets: AssetsService,
    @Inject(PLATFORM_DRAFT_ADAPTER) private readonly platform: PlatformDraftAdapter,
    @Inject('APP_CONFIG') private readonly config: Config,
    private readonly executor: PublishingExecutor,
  ) {}

  private requireWrites() {
    if (!this.config.REMOTE_WRITES_ENABLED)
      throw new ServiceUnavailableException({
        code: 'REMOTE_WRITES_DISABLED',
        message:
          '远程写入尚未启用，请在部署配置中设置 REMOTE_WRITES_ENABLED=true 并重启 API 和 Worker',
      });
  }

  private existing(revisionId: string, accountId: string) {
    return this.database.delivery.findUnique({
      where: { revisionId_accountId_action: { revisionId, accountId, action: SAVE_DRAFT_ACTION } },
      select: { id: true, state: true, remoteId: true, resultSource: true },
    });
  }

  async check(body: unknown) {
    const input = parse(deliveryTargetInput, body);
    const [revision, account, existingDelivery] = await Promise.all([
      this.database.revision.findFirst({
        where: { id: input.revisionId, article: { isTest: false } },
      }),
      this.database.account.findUnique({ where: { id: input.accountId } }),
      this.existing(input.revisionId, input.accountId),
    ]);
    if (!revision) throw new NotFoundException('已保存的文章修订不存在');
    if (!account) throw new NotFoundException('公众号账号不存在');
    if (account.platform !== this.platform.platform)
      throw new BadRequestException('当前平台尚未接入草稿投递');
    const draft = { ...revision, document: revision.document as unknown as DocumentNode };
    const result = this.platform.check(draft);
    const problems = [...result.problems];
    const warnings = [...result.warnings];
    if (!result.allowed && !problems.length)
      problems.push('平台校验规则尚未核验，暂不能创建普通文章草稿');
    if (!this.config.REMOTE_WRITES_ENABLED)
      problems.push('远程写入尚未启用，请修改部署配置并重启 API 和 Worker');
    const capabilities = account.capabilities as Prisma.JsonObject;
    const saveCapability = capabilities.saveDraft as Prisma.JsonObject | undefined;
    if (saveCapability?.status === 'unsupported')
      problems.push('该账号最近一次新增草稿接口验证未通过，请先核对权限或重新执行接入测试');
    else if (saveCapability?.status !== 'supported')
      warnings.push('新增草稿能力尚未通过接口验证，本次操作将上传素材并尝试创建一篇远程草稿');
    try {
      const assetIds = new Set(inspectDocument(draft.document).assetIds);
      if (revision.coverId) assetIds.add(revision.coverId);
      for (const assetId of assetIds) await this.assets.getFile(assetId);
    } catch {
      problems.push('文章引用的图片无法读取，请检查本地素材后再投递');
    }
    return {
      revisionId: revision.id,
      version: revision.version,
      title: revision.title,
      savedAt: revision.createdAt.toISOString(),
      account: { id: account.id, name: account.name, platform: account.platform },
      problems,
      warnings,
      limitsVerified: result.limitsVerified,
      existingDelivery,
      canSubmit: result.allowed && !problems.length && !existingDelivery,
    };
  }

  async create(body: unknown, actor: string) {
    const input = parse(submitDeliveryInput, body);
    const previous = await this.existing(input.revisionId, input.accountId);
    if (previous) return this.get(previous.id);
    this.requireWrites();
    const checked = await this.check({ revisionId: input.revisionId, accountId: input.accountId });
    if (!checked.canSubmit) {
      if (checked.existingDelivery) return this.get(checked.existingDelivery.id);
      throw new BadRequestException({
        code: 'DELIVERY_NOT_READY',
        message: '文章尚未通过投递检查，请处理检查结果后重试',
        details: {
          problems: checked.problems,
          warnings: checked.warnings,
          limitsVerified: checked.limitsVerified,
        },
      });
    }
    const key = `delivery:${input.accountId}:${input.revisionId}:${SAVE_DRAFT_ACTION}`;
    try {
      const id = await this.database.$transaction(async (transaction) => {
        await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
        const existing = await transaction.delivery.findUnique({
          where: {
            revisionId_accountId_action: {
              revisionId: input.revisionId,
              accountId: input.accountId,
              action: SAVE_DRAFT_ACTION,
            },
          },
          select: { id: true },
        });
        if (existing) return existing.id;
        const delivery = await transaction.delivery.create({
          data: {
            accountId: input.accountId,
            revisionId: input.revisionId,
            platform: this.platform.platform,
            action: SAVE_DRAFT_ACTION,
            renderVersion: this.platform.renderVersion,
            events: {
              create: {
                actor,
                message: `用户确认将已保存修订 v${checked.version} 存入所选公众号草稿箱`,
              },
            },
          },
        });
        return delivery.id;
      });
      return this.get(id);
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        const winner = await this.existing(input.revisionId, input.accountId);
        if (winner) return this.get(winner.id);
      }
      throw error;
    }
  }

  async createTest(accountId: string, body: unknown, actor: string) {
    this.requireWrites();
    const input = parse(testInput, body);
    const key = `test:${accountId}:${input.requestId}`;
    const previous = await this.database.delivery.findUnique({
      where: { requestKey: key },
      include: { revision: { select: { coverId: true } } },
    });
    if (previous) {
      if (previous.revision.coverId !== input.coverId)
        throw new ConflictException('请求标识已用于另一张封面，请明确发起新的测试');
      return this.get(previous.id);
    }
    if (
      !(await this.database.account.findUnique({ where: { id: accountId }, select: { id: true } }))
    )
      throw new NotFoundException('公众号账号不存在');
    await this.assets.coverBuffer(input.coverId);
    const title = 'Tattoo 接入测试';
    const document: DocumentNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: '这是一篇由 Tattoo 创建的接口接入测试草稿。核对完成后，可在微信后台手动删除。',
            },
          ],
        },
      ],
    };
    const deliveryId = await this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))::text`;
      const existing = await transaction.delivery.findUnique({
        where: { requestKey: key },
        include: { revision: { select: { coverId: true } } },
      });
      if (existing) {
        if (existing.revision.coverId !== input.coverId)
          throw new ConflictException('请求标识已用于另一张封面，请明确发起新的测试');
        return existing.id;
      }
      const article = await transaction.article.create({ data: { isTest: true } });
      const revision = await transaction.revision.create({
        data: {
          articleId: article.id,
          version: 1,
          title,
          document: document as Prisma.InputJsonObject,
          coverId: input.coverId,
          contentHash: createHash('sha256')
            .update(JSON.stringify({ title, document, coverId: input.coverId }))
            .digest('hex'),
          assets: { create: { assetId: input.coverId } },
        },
      });
      await transaction.article.update({
        where: { id: article.id },
        data: { currentRevisionId: revision.id },
      });
      const delivery = await transaction.delivery.create({
        data: {
          accountId,
          revisionId: revision.id,
          requestKey: key,
          renderVersion: this.platform.renderVersion,
          events: {
            create: {
              actor,
              message: '用户确认上传测试封面并新增远程测试草稿；微信侧产物需手动清理',
            },
          },
        },
      });
      return delivery.id;
    });
    return this.get(deliveryId);
  }

  async get(id: string) {
    const row = await this.database.delivery.findUnique({ where: { id }, include: publicDelivery });
    if (!row) throw new NotFoundException('投递记录不存在');
    const { artifact: _artifact, executionId: _execution, heartbeatAt: _heartbeat, ...dto } = row;
    return dto;
  }

  async list(pageValue: unknown, sizeValue: unknown) {
    const pagination = z
      .object({
        page: z.coerce.number().int().min(1).max(2_147_483_647).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      })
      .safeParse({ page: pageValue, pageSize: sizeValue });
    if (!pagination.success) throw new BadRequestException('分页参数无效');
    const { page, pageSize } = pagination.data;
    if ((page - 1) * pageSize > 2_147_483_647) throw new BadRequestException('页码超出范围');
    const [rows, total] = await this.database.$transaction([
      this.database.delivery.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: publicDelivery,
      }),
      this.database.delivery.count(),
    ]);
    return {
      items: rows.map(
        ({ artifact: _artifact, executionId: _execution, heartbeatAt: _heartbeat, ...dto }) => dto,
      ),
      total,
      page,
      pageSize,
    };
  }

  async retry(id: string, body: unknown, actor: string) {
    this.requireWrites();
    parse(retryInput, body);
    await this.database.$transaction(async (transaction) => {
      const changed = await transaction.delivery.updateMany({
        where: { id, state: 'FAILED' },
        data: {
          state: 'QUEUED',
          stage: '等待重试',
          executionId: null,
          heartbeatAt: null,
          submissionStartedAt: null,
          completedAt: null,
          error: null,
          resultSource: null,
          remoteId: null,
        },
      });
      if (changed.count !== 1) throw new ConflictException('只有已确定失败的任务可显式重试');
      await transaction.deliveryEvent.create({
        data: { deliveryId: id, actor, message: '用户显式重试已确定失败的任务' },
      });
    });
    return this.get(id);
  }

  async resolve(id: string, body: unknown, actor: string) {
    const input = parse(resolutionInput, body);
    const lock = new Client({
      connectionString: this.config.DATABASE_URL,
      connectionTimeoutMillis: 10000,
    });
    await lock.connect();
    try {
      const held = await lock.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [WORKER_LOCK],
      );
      if (!held.rows[0]?.acquired)
        throw new ConflictException({
          code: 'WORKER_STILL_RUNNING',
          message: '请先停止 Worker，并确认旧执行进程已结束，再进行人工核对',
        });
      const record = await this.database.delivery.findUnique({
        where: { id },
        select: { accountId: true },
      });
      if (!record) throw new NotFoundException('投递记录不存在');
      await this.accounts.withLockedAccount(record.accountId, async (_account, guard) => {
        guard.assertActive();
        await this.database.$transaction(async (transaction) => {
          const changed = await transaction.delivery.updateMany({
            where: { id, state: 'UNCERTAIN' },
            data: {
              state: input.outcome === 'created' ? 'SUCCEEDED' : 'FAILED',
              resultSource: 'manual',
              remoteId: input.outcome === 'created' ? (input.remoteId ?? null) : null,
              stage:
                input.outcome === 'created' ? '已存草稿（人工确认）' : '人工确认未创建，可显式重试',
              error: null,
              executionId: null,
              completedAt: new Date(),
            },
          });
          if (changed.count !== 1)
            throw new ConflictException('记录已变化，只有结果待核对的任务可人工确认');
          await transaction.deliveryEvent.create({
            data: {
              deliveryId: id,
              actor,
              message: `用户确认旧 Worker 已停止；${input.outcome === 'created' ? '确认已创建' : '确认未创建'}；核对说明：${input.note}`,
            },
          });
        });
      });
    } finally {
      await lock.end();
    }
    return this.get(id);
  }

  recover() {
    return this.executor.recover();
  }
  processNext(assertWorkerActive: () => Promise<void>) {
    return this.executor.processNext(assertWorkerActive);
  }
}
