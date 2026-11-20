import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { Prisma, type Revision } from '@prisma/client';
import type { DocumentNode } from '@tattoo/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { AccountsService } from '../accounts/accounts.module';
import { AssetsService } from '../assets/assets.module';
import type { Config } from '../config';
import { inspectDocument } from '../content/document';
import { Database } from '../database';
import {
  PLATFORM_DRAFT_ADAPTER,
  PlatformError,
  type DraftContent,
  type PlatformDraftAdapter,
  type PlatformExecutionGuard,
} from '../platforms/draft-adapter';
import { MAX_TASK_MILLISECONDS, SAVE_DRAFT_ACTION } from './publishing.constants';

class PreparationError extends Error {}
function draftContent(revision: Revision): DraftContent {
  return {
    title: revision.title,
    author: revision.author,
    digest: revision.digest,
    sourceUrl: revision.sourceUrl,
    coverId: revision.coverId,
    document: revision.document as unknown as DocumentNode,
  };
}

@Injectable()
export class PublishingExecutor {
  constructor(
    private readonly database: Database,
    private readonly accounts: AccountsService,
    private readonly assets: AssetsService,
    @Inject(PLATFORM_DRAFT_ADAPTER) private readonly platform: PlatformDraftAdapter,
    @Inject('APP_CONFIG') private readonly config: Config,
  ) {}

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
            ...(uncertain ? { completedAt: new Date() } : {}),
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
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (!queued) return false;
    try {
      return await this.accounts.withLockedAccount(
        queued.accountId,
        async (account, accountGuard) => {
          await assertWorkerActive();
          const executionId = randomUUID();
          const deadlineAt = Date.now() + MAX_TASK_MILLISECONDS;
          const guard: PlatformExecutionGuard = {
            deadlineAt,
            assertActive() {
              accountGuard.assertActive();
              if (Date.now() >= deadlineAt)
                throw new PreparationError('后台任务超过十分钟截止时间');
            },
          };
          const claimed = await this.database.$transaction(async (transaction) => {
            const change = await transaction.delivery.updateMany({
              where: { id: queued.id, state: 'QUEUED' },
              data: {
                state: 'RUNNING',
                stage: '检查已保存修订',
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
                stage: '检查已保存修订',
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
          const activeWhere = { id: queued.id, state: 'RUNNING' as const, executionId };
          const assertExecution = async () => {
            guard.assertActive();
            await assertWorkerActive();
            guard.assertActive();
            const owned = await this.database.delivery.updateMany({
              where: activeWhere,
              data: { heartbeatAt: new Date() },
            });
            if (!owned.count) throw new PreparationError('任务执行权已变化');
          };
          guard.beforeRequest = assertExecution;
          const stage = async (message: string, record = false) => {
            await assertExecution();
            await this.database.$transaction(async (transaction) => {
              const owned = await transaction.delivery.updateMany({
                where: activeWhere,
                data: { stage: message, heartbeatAt: new Date() },
              });
              if (!owned.count) throw new PreparationError('任务执行权已变化');
              await transaction.deliveryAttempt.updateMany({
                where: { id: executionId, state: 'RUNNING' },
                data: { stage: message },
              });
              if (record)
                await transaction.deliveryEvent.create({
                  data: { deliveryId: queued.id, attemptId: executionId, actor: 'worker', message },
                });
            });
          };
          let danger = false;
          let knownRemoteId: string | null = null;
          let coverAssetId: string | null = null;
          let bodyAssetIds: string[] = [];
          try {
            if (queued.platform !== this.platform.platform || queued.action !== SAVE_DRAFT_ACTION)
              throw new PreparationError('当前执行器不支持此平台或动作');
            if (queued.renderVersion !== this.platform.renderVersion)
              throw new PreparationError('任务绑定的排版版本已不可用，请保存新修订后重新提交');
            const revision = await this.database.revision.findUniqueOrThrow({
              where: { id: queued.revisionId },
              include: { article: { select: { isTest: true } } },
            });
            const content = draftContent(revision);
            bodyAssetIds = inspectDocument(content.document).assetIds;
            if (!revision.article.isTest) {
              const checked = this.platform.check(content);
              if (!checked.allowed || checked.problems.length)
                throw new PreparationError(checked.problems.join('；') || '平台校验规则尚未核验');
            }
            if (!revision.coverId) throw new PreparationError('文章封面缺失');
            coverAssetId = revision.coverId;
            const proof: Prisma.InputJsonObject[] = [];
            await stage('准备封面素材', true);
            const coverFile = await this.assets.getFile(revision.coverId);
            const coverBuffer = await this.assets.coverBuffer(revision.coverId, deadlineAt);
            const coverKey = {
              accountId: account.id,
              assetId: revision.coverId,
              kind: 'COVER' as const,
            };
            const previousCover = await this.database.remoteAsset.findUnique({
              where: { accountId_assetId_kind: coverKey },
            });
            let coverReference = previousCover?.remoteId;
            const coverCacheHit = Boolean(coverReference);
            if (!coverReference) {
              await assertExecution();
              coverReference = await this.platform.uploadCover(account, coverBuffer, guard);
              await assertExecution();
              await this.database.remoteAsset.upsert({
                where: { accountId_assetId_kind: coverKey },
                create: { ...coverKey, remoteId: coverReference },
                update: { remoteId: coverReference },
              });
            }
            proof.push({
              assetId: revision.coverId,
              kind: 'COVER',
              originalSha256: coverFile.asset.sha256,
              cacheHit: coverCacheHit,
              preparedSha256: createHash('sha256').update(coverBuffer).digest('hex'),
              preparedBytes: coverBuffer.length,
              uploadSha256: coverCacheHit
                ? null
                : createHash('sha256').update(coverBuffer).digest('hex'),
              uploadBytes: coverCacheHit ? null : coverBuffer.length,
              remoteId: coverReference,
              url: null,
            });
            const imageUrls: Record<string, string> = {};
            if (bodyAssetIds.length)
              await stage(`准备正文图片，共 ${bodyAssetIds.length} 张`, true);
            for (const [index, assetId] of bodyAssetIds.entries()) {
              await stage(`准备正文图片 ${index + 1}/${bodyAssetIds.length}`);
              const file = await this.assets.getFile(assetId);
              const buffer = await this.assets.bodyBuffer(assetId, deadlineAt);
              const key = { accountId: account.id, assetId, kind: 'BODY' as const };
              const previous = await this.database.remoteAsset.findUnique({
                where: { accountId_assetId_kind: key },
              });
              let url = previous?.url;
              const bodyCacheHit = Boolean(url);
              if (!url) {
                await assertExecution();
                url = await this.platform.uploadBodyImage(account, buffer, guard);
                await assertExecution();
                await this.database.remoteAsset.upsert({
                  where: { accountId_assetId_kind: key },
                  create: { ...key, url },
                  update: { url },
                });
              }
              imageUrls[assetId] = url;
              proof.push({
                assetId,
                kind: 'BODY',
                originalSha256: file.asset.sha256,
                cacheHit: bodyCacheHit,
                preparedSha256: createHash('sha256').update(buffer).digest('hex'),
                preparedBytes: buffer.length,
                uploadSha256: bodyCacheHit
                  ? null
                  : createHash('sha256').update(buffer).digest('hex'),
                uploadBytes: bodyCacheHit ? null : buffer.length,
                remoteId: null,
                url,
              });
            }
            await stage('排版与最终投递检查', true);
            const prepared = this.platform.prepareDraft({ ...content, coverReference, imageUrls });
            const checked = revision.article.isTest
              ? null
              : this.platform.check(content, prepared.html);
            const artifact: Prisma.InputJsonObject = {
              revisionId: revision.id,
              accountId: account.id,
              credentialVersion: account.credentialVersion,
              renderVersion: queued.renderVersion,
              payload: prepared.payload,
              html: prepared.html,
              assets: proof,
            };
            await assertExecution();
            const persisted = await this.database.delivery.updateMany({
              where: activeWhere,
              data: { artifact, stage: '准备新增草稿', heartbeatAt: new Date() },
            });
            if (!persisted.count) return true;
            if (checked && (!checked.allowed || checked.problems.length))
              throw new PreparationError(
                checked.problems.join('；') || '最终投递产物未通过平台检查',
              );
            await assertExecution();
            await this.database.$transaction(async (transaction) => {
              const marker = await transaction.delivery.updateMany({
                where: activeWhere,
                data: {
                  submissionStartedAt: new Date(),
                  stage: '正在新增微信草稿',
                  heartbeatAt: new Date(),
                },
              });
              if (!marker.count) throw new PreparationError('任务执行权已变化');
              await transaction.deliveryAttempt.updateMany({
                where: { id: executionId, state: 'RUNNING' },
                data: { stage: '正在新增微信草稿' },
              });
              await transaction.deliveryEvent.create({
                data: {
                  deliveryId: queued.id,
                  attemptId: executionId,
                  actor: 'worker',
                  message: '最终产物已固化，即将调用新增草稿接口',
                },
              });
            });
            danger = true;
            await assertExecution();
            const result = await this.platform.createDraft(account, prepared.payload, guard);
            knownRemoteId = result.remoteId;
            await this.database.$transaction(async (transaction) => {
              const changed = await transaction.delivery.updateMany({
                where: activeWhere,
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
              await transaction.account.updateMany({
                where: { id: account.id, credentialVersion: account.credentialVersion },
                data: {
                  capabilities: {
                    ...(latest.capabilities as Prisma.JsonObject),
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
            const uncertain = danger && (!(error instanceof PlatformError) || error.uncertain);
            const message =
              Date.now() >= deadlineAt
                ? uncertain
                  ? '后台任务超过十分钟，远程提交结果待核对，请先核对微信后台'
                  : '后台任务超过十分钟截止时间，本次执行失败'
                : error instanceof PlatformError || error instanceof PreparationError
                  ? error.message
                  : danger
                    ? '远程提交结果无法确定，请核对微信后台'
                    : '准备草稿失败，请检查素材、数据库和 Worker 连接';
            await this.database.$transaction(async (transaction) => {
              const changed = await transaction.delivery.updateMany({
                where: activeWhere,
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
              if (error instanceof PlatformError && error.invalidCover && coverAssetId)
                await transaction.remoteAsset.deleteMany({
                  where: { accountId: account.id, assetId: coverAssetId, kind: 'COVER' },
                });
              if (error instanceof PlatformError && error.invalidBodyImage && bodyAssetIds.length)
                await transaction.remoteAsset.deleteMany({
                  where: { accountId: account.id, assetId: { in: bodyAssetIds }, kind: 'BODY' },
                });
              if (error instanceof PlatformError && danger && error.writePermissionDenied) {
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
        },
      );
    } catch (error) {
      if (error instanceof ConflictException) return false;
      throw error;
    }
  }
}
