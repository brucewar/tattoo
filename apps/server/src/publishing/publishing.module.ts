import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID, createHash } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
import { Database } from '../database';
import type { Config } from '../config';
import { AccountsModule, AccountsService } from '../accounts/accounts.module';
import { AssetsModule, AssetsService } from '../assets/assets.module';
import {
  WechatModule,
  WechatService,
  WechatError,
  WECHAT_RENDER_VERSION,
} from '../platforms/wechat.module';
import { IdentityModule, SessionGuard } from '../identity/identity.module';
import type { DocumentNode } from '@tattoo/contracts';

export const WORKER_LOCK = 8472901;
const testInput = z
  .object({ coverId: z.string().uuid(), requestId: z.string().uuid(), confirmed: z.literal(true) })
  .strict();
const resolutionInput = z
  .object({
    outcome: z.enum(['created', 'not_created']),
    note: z.string().trim().min(5).max(1000),
    remoteId: z.string().trim().min(1).max(512).optional(),
    workerStoppedConfirmed: z.literal(true),
  })
  .strict();
const retryInput = z.object({ confirmed: z.literal(true) }).strict();
const publicDelivery = {
  account: { select: { id: true, name: true, platform: true } },
  revision: { select: { id: true, title: true, version: true, articleId: true } },
  events: {
    orderBy: { createdAt: 'asc' as const },
    select: { actor: true, message: true, createdAt: true },
  },
};
type ActorRequest = { user: { id: string; email: string } };

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BadRequestException({
      code: 'INVALID_INPUT',
      message: '请检查输入并明确确认本次操作',
    });
  return result.data;
}

@Injectable()
export class PublishingService {
  constructor(
    private readonly database: Database,
    private readonly accounts: AccountsService,
    private readonly assets: AssetsService,
    private readonly wechat: WechatService,
    @Inject('APP_CONFIG') private readonly config: Config,
  ) {}

  private requireWrites() {
    if (!this.config.REMOTE_WRITES_ENABLED)
      throw new ServiceUnavailableException({
        code: 'REMOTE_WRITES_DISABLED',
        message:
          '远程写入尚未启用，请在部署配置中设置 REMOTE_WRITES_ENABLED=true 并重启 API 和 Worker',
      });
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
          renderVersion: WECHAT_RENDER_VERSION,
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
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(100).default(20),
      })
      .safeParse({ page: pageValue, pageSize: sizeValue });
    if (!pagination.success) throw new BadRequestException('分页参数无效');
    const { page, pageSize } = pagination.data;
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

  async recover() {
    const rows = await this.database.delivery.findMany({ where: { state: 'RUNNING' } });
    for (const row of rows) {
      const uncertain = row.submissionStartedAt !== null;
      const stage = uncertain ? 'Worker 中断，远程结果待核对' : '准备阶段中断，重新排队';
      await this.database.$transaction(async (transaction) => {
        const changed = await transaction.delivery.updateMany({
          where: { id: row.id, state: 'RUNNING', executionId: row.executionId },
          data: {
            state: uncertain ? 'UNCERTAIN' : 'QUEUED',
            stage,
            executionId: null,
            heartbeatAt: null,
            error: uncertain ? '新增草稿可能已成功，请在微信后台核对，系统不会自动重复提交' : null,
          },
        });
        if (!changed.count) return;
        if (row.executionId)
          await transaction.deliveryAttempt.updateMany({
            where: { id: row.executionId },
            data: { state: uncertain ? 'UNCERTAIN' : 'FAILED', stage, completedAt: new Date() },
          });
        await transaction.deliveryEvent.create({
          data: { deliveryId: row.id, actor: 'worker', message: stage },
        });
      });
    }
  }

  async processNext(assertWorkerActive: () => Promise<void>) {
    if (!this.config.REMOTE_WRITES_ENABLED) return false;
    const queued = await this.database.delivery.findFirst({
      where: { state: 'QUEUED' },
      orderBy: { createdAt: 'asc' },
    });
    if (!queued) return false;
    try {
      return await this.accounts.withLockedAccount(queued.accountId, async (account, guard) => {
        await assertWorkerActive();
        const executionId = randomUUID();
        const claimed = await this.database.$transaction(async (transaction) => {
          const change = await transaction.delivery.updateMany({
            where: { id: queued.id, state: 'QUEUED' },
            data: {
              state: 'RUNNING',
              stage: '准备测试草稿',
              executionId,
              heartbeatAt: new Date(),
              submissionStartedAt: null,
              error: null,
            },
          });
          if (!change.count) return false;
          const count = await transaction.deliveryAttempt.count({
            where: { deliveryId: queued.id },
          });
          await transaction.deliveryAttempt.create({
            data: {
              id: executionId,
              deliveryId: queued.id,
              number: count + 1,
              stage: '准备测试草稿',
            },
          });
          await transaction.deliveryEvent.create({
            data: {
              deliveryId: queued.id,
              attemptId: executionId,
              actor: 'worker',
              message: 'Worker 已认领任务',
            },
          });
          return true;
        });
        if (!claimed) return false;
        let danger = false;
        let knownRemoteId: string | null = null;
        let coverAssetId: string | null = null;
        try {
          const revision = await this.database.revision.findUniqueOrThrow({
            where: { id: queued.revisionId },
          });
          if (!revision.coverId) throw new Error('测试封面缺失');
          coverAssetId = revision.coverId;
          const buffer = await this.assets.coverBuffer(revision.coverId);
          const previous = await this.database.remoteAsset.findUnique({
            where: {
              accountId_assetId_kind: {
                accountId: account.id,
                assetId: revision.coverId,
                kind: 'COVER',
              },
            },
          });
          let coverId = previous?.remoteId;
          if (!coverId) {
            guard.assertActive();
            await assertWorkerActive();
            coverId = await this.wechat.uploadCover(account, buffer, guard);
            guard.assertActive();
            await this.database.remoteAsset.upsert({
              where: {
                accountId_assetId_kind: {
                  accountId: account.id,
                  assetId: revision.coverId,
                  kind: 'COVER',
                },
              },
              create: {
                accountId: account.id,
                assetId: revision.coverId,
                kind: 'COVER',
                remoteId: coverId,
              },
              update: { remoteId: coverId },
            });
          }
          const payload = this.wechat.prepareDraft({
            title: revision.title,
            document: revision.document as unknown as DocumentNode,
            coverReference: coverId,
          });
          const prepared = await this.database.delivery.updateMany({
            where: { id: queued.id, state: 'RUNNING', executionId },
            data: { artifact: payload, stage: '准备新增草稿', heartbeatAt: new Date() },
          });
          if (!prepared.count) return true;
          guard.assertActive();
          await assertWorkerActive();
          const marker = await this.database.delivery.updateMany({
            where: { id: queued.id, state: 'RUNNING', executionId },
            data: {
              submissionStartedAt: new Date(),
              stage: '正在新增微信草稿',
              heartbeatAt: new Date(),
            },
          });
          if (!marker.count) return true;
          danger = true;
          guard.assertActive();
          await assertWorkerActive();
          const result = await this.wechat.createDraft(account, payload, guard);
          knownRemoteId = result.remoteId;
          await this.database.$transaction(async (transaction) => {
            const changed = await transaction.delivery.updateMany({
              where: { id: queued.id, state: 'RUNNING', executionId },
              data: {
                state: 'SUCCEEDED',
                stage: '已存入微信草稿箱',
                remoteId: result.remoteId,
                platformResult: result.platformResult,
                resultSource: 'api',
                error: null,
                completedAt: new Date(),
                executionId: null,
              },
            });
            if (!changed.count) return;
            await transaction.deliveryAttempt.update({
              where: { id: executionId },
              data: { state: 'SUCCEEDED', stage: '已存入微信草稿箱', completedAt: new Date() },
            });
            const latest = await transaction.account.findUniqueOrThrow({
              where: { id: account.id },
            });
            const capabilities = latest.capabilities as Prisma.JsonObject;
            await transaction.account.updateMany({
              where: { id: account.id, credentialVersion: account.credentialVersion },
              data: {
                capabilities: {
                  ...capabilities,
                  saveDraft: {
                    status: 'supported',
                    source: 'api',
                    verifiedAt: new Date().toISOString(),
                  },
                },
              },
            });
            await transaction.deliveryEvent.create({
              data: {
                deliveryId: queued.id,
                attemptId: executionId,
                actor: 'worker',
                message: '微信新增草稿接口返回成功，远程 ID 已保存',
              },
            });
          });
        } catch (error) {
          const uncertain = danger && (!(error instanceof WechatError) || error.uncertain);
          const message =
            error instanceof WechatError
              ? error.message
              : danger
                ? '远程提交结果无法确定，请核对微信后台'
                : '准备测试草稿失败，请检查素材、数据库和 Worker 连接';
          await this.database.$transaction(async (transaction) => {
            const changed = await transaction.delivery.updateMany({
              where: { id: queued.id, state: 'RUNNING', executionId },
              data: {
                state: uncertain ? 'UNCERTAIN' : 'FAILED',
                stage: uncertain ? '结果待核对' : '投递失败',
                error: message,
                remoteId: knownRemoteId,
                completedAt: new Date(),
                executionId: null,
              },
            });
            if (!changed.count) return;
            await transaction.deliveryAttempt.update({
              where: { id: executionId },
              data: {
                state: uncertain ? 'UNCERTAIN' : 'FAILED',
                stage: uncertain ? '结果待核对' : '投递失败',
                error: message,
                completedAt: new Date(),
              },
            });
            await transaction.deliveryEvent.create({
              data: { deliveryId: queued.id, attemptId: executionId, actor: 'worker', message },
            });
            if (error instanceof WechatError && error.invalidCover && coverAssetId) {
              await transaction.remoteAsset.deleteMany({
                where: { accountId: account.id, assetId: coverAssetId, kind: 'COVER' },
              });
            }
            if (error instanceof WechatError && danger && error.writePermissionDenied) {
              const current = await transaction.account.findUniqueOrThrow({
                where: { id: account.id },
              });
              await transaction.account.updateMany({
                where: { id: account.id, credentialVersion: account.credentialVersion },
                data: {
                  capabilities: {
                    ...(current.capabilities as Prisma.JsonObject),
                    saveDraft: {
                      status: 'unsupported',
                      source: 'api',
                      verifiedAt: new Date().toISOString(),
                      error: message,
                    },
                  },
                },
              });
            }
          });
        }
        return true;
      });
    } catch (error) {
      if (error instanceof ConflictException) return false;
      throw error;
    }
  }
}

@Controller('accounts')
@UseGuards(SessionGuard)
class TestDraftController {
  constructor(private readonly publishing: PublishingService) {}
  @Post(':id/test-draft')
  async test(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: ActorRequest,
  ) {
    return { data: await this.publishing.createTest(id, body, request.user.email) };
  }
}

@Controller('deliveries')
@UseGuards(SessionGuard)
class DeliveriesController {
  constructor(private readonly publishing: PublishingService) {}
  @Get() async list(@Query('page') page: unknown, @Query('pageSize') pageSize: unknown) {
    return { data: await this.publishing.list(page, pageSize) };
  }
  @Get(':id') async get(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.publishing.get(id) };
  }
  @Post(':id/retry') async retry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: ActorRequest,
  ) {
    return { data: await this.publishing.retry(id, body, request.user.email) };
  }
  @Post(':id/resolve') async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: ActorRequest,
  ) {
    return { data: await this.publishing.resolve(id, body, request.user.email) };
  }
}

@Module({
  imports: [IdentityModule, AccountsModule, AssetsModule, WechatModule],
  providers: [PublishingService],
  controllers: [TestDraftController, DeliveriesController],
  exports: [PublishingService],
})
export class PublishingModule {}
