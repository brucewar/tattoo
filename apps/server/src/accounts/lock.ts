import { ConflictException } from '@nestjs/common';
import { Client } from 'pg';
import type { Config } from '../config';

export type AccountLockGuard = { assertActive(): void };

/** The dedicated session owns the lock across API and Worker database connections. */
export async function withAccountLock<T>(
  config: Config,
  accountId: string,
  operation: (guard: AccountLockGuard) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
  });
  let active = false;
  client.on('error', () => {
    active = false;
  });
  await client.connect();
  try {
    const result = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired',
      [accountId],
    );
    if (!result.rows[0]?.acquired) {
      throw new ConflictException({
        code: 'ACCOUNT_BUSY',
        message: '账号正在执行接口操作，请稍后重试',
      });
    }
    active = true;
    const guard: AccountLockGuard = {
      assertActive() {
        if (!active) throw new Error('账号执行权连接已中断');
      },
    };
    return await operation(guard);
  } finally {
    active = false;
    // Ending the dedicated session releases its advisory lock even after an operation fails.
    await client.end().catch(() => undefined);
  }
}
