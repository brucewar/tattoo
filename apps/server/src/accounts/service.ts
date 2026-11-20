import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Account as AccountRecord, Prisma } from '@prisma/client';
import type { Account, CapabilityCheck } from '@tattoo/contracts';
import { accountInput } from '@tattoo/contracts';
import { z } from 'zod';
import type { Config } from '../config';
import { Database } from '../database';
import { SecretBox } from '../security';
import { WechatError, WechatService } from '../platforms/wechat.module';
import { withAccountLock, type AccountLockGuard } from './lock';

const updateInput = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    appSecret: z.string().trim().min(16).max(128).optional(),
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.appSecret !== undefined,
    '请提供账号名称或新密钥',
  );
const pageInput = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
const unverified = () => ({
  readDraft: { status: 'unverified' },
  saveDraft: { status: 'unverified' },
});

function parse<T extends z.ZodTypeAny>(schema: T, input: unknown): z.output<T> {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BadRequestException(result.error.issues.map((issue) => issue.message).join('；'));
  return result.data;
}

function capability(value: unknown): CapabilityCheck {
  if (!value || typeof value !== 'object') return { status: 'unverified' };
  const stored = value as Record<string, unknown>;
  const status = ['supported', 'unsupported', 'unverified'].includes(String(stored.status))
    ? (stored.status as CapabilityCheck['status'])
    : 'unverified';
  return {
    status,
    ...(typeof stored.verifiedAt === 'string' ? { verifiedAt: stored.verifiedAt } : {}),
    ...(stored.source === 'api' ? { source: 'api' as const } : {}),
    ...(typeof stored.error === 'string' ? { error: stored.error } : {}),
  };
}

@Injectable()
export class AccountsService {
  private readonly secrets: SecretBox;
  constructor(
    private readonly database: Database,
    @Inject('APP_CONFIG') private readonly config: Config,
    private readonly wechat: WechatService,
  ) {
    this.secrets = new SecretBox(config.APP_ENCRYPTION_KEY);
  }

  publicAccount(account: AccountRecord): Account {
    const capabilities = account.capabilities as Record<string, unknown>;
    return {
      id: account.id,
      name: account.name,
      platform: account.platform,
      appId: account.appId,
      credentialVersion: account.credentialVersion,
      capabilities: {
        readDraft: capability(capabilities?.readDraft),
        saveDraft: capability(capabilities?.saveDraft),
      },
    };
  }

  async withLockedAccount<T>(
    id: string,
    operation: (account: AccountRecord, guard: AccountLockGuard) => Promise<T>,
  ): Promise<T> {
    return withAccountLock(this.config, id, async (guard) => {
      const account = await this.database.account.findUnique({ where: { id } });
      if (!account) throw new NotFoundException('公众号账号不存在');
      guard.assertActive();
      return operation(account, guard);
    });
  }

  async list(input: unknown = {}) {
    const { page, pageSize } = parse(pageInput, input);
    const [items, total] = await this.database.$transaction([
      this.database.account.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.database.account.count(),
    ]);
    return { items: items.map((item) => this.publicAccount(item)), total, page, pageSize };
  }

  async create(input: unknown) {
    const data = parse(accountInput.strict(), input);
    try {
      return this.publicAccount(
        await this.database.account.create({
          data: {
            name: data.name,
            appId: data.appId,
            secretEncrypted: this.secrets.encrypt(data.appSecret),
            capabilities: unverified(),
          },
        }),
      );
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002')
        throw new ConflictException('该 AppID 已配置，请编辑已有账号');
      throw error;
    }
  }

  async update(id: string, input: unknown) {
    const changes = parse(updateInput, input);
    return this.withLockedAccount(id, async (account, guard) => {
      if (
        changes.appSecret &&
        (await this.database.delivery.count({ where: { accountId: id, state: 'RUNNING' } }))
      ) {
        throw new ConflictException('该账号仍有执行中的任务，请先完成或核对任务后再轮换密钥');
      }
      guard.assertActive();
      const result = await this.database.account.updateMany({
        where: { id, credentialVersion: account.credentialVersion },
        data: {
          ...(changes.name !== undefined ? { name: changes.name } : {}),
          ...(changes.appSecret !== undefined
            ? {
                secretEncrypted: this.secrets.encrypt(changes.appSecret),
                credentialVersion: { increment: 1 },
                tokenEncrypted: null,
                tokenExpiresAt: null,
                capabilities: unverified(),
              }
            : {}),
        },
      });
      if (result.count !== 1) throw new ConflictException('账号已变化，请刷新后重试');
      return this.publicAccount(await this.database.account.findUniqueOrThrow({ where: { id } }));
    });
  }

  async verify(id: string) {
    return this.withLockedAccount(id, async (account, guard) => {
      let count: number | null = null;
      let readDraft: CapabilityCheck;
      try {
        count = await this.wechat.countDrafts(account, guard);
        readDraft = { status: 'supported', source: 'api', verifiedAt: new Date().toISOString() };
      } catch (error) {
        if (!(error instanceof WechatError)) throw error;
        readDraft = {
          status: error.readPermissionDenied ? 'unsupported' : 'unverified',
          source: 'api',
          verifiedAt: new Date().toISOString(),
          error: `${error.message}；${error.suggestion}`,
        };
      }
      guard.assertActive();
      const old = account.capabilities as Record<string, unknown>;
      const updated = await this.database.account.updateMany({
        where: { id, credentialVersion: account.credentialVersion },
        data: {
          capabilities: {
            readDraft,
            saveDraft: capability(old?.saveDraft),
          } as unknown as Prisma.InputJsonValue,
        },
      });
      if (updated.count !== 1) throw new ConflictException('账号凭证已变化，请重新验证');
      return {
        account: this.publicAccount(
          await this.database.account.findUniqueOrThrow({ where: { id } }),
        ),
        draftCount: count,
      };
    });
  }
}
