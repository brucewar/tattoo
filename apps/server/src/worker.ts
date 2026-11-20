import { Client } from 'pg';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { loadConfig } from './config';

const workerLock = 8472901;
const heartbeat = join(tmpdir(), 'tattoo-worker-health');

async function main() {
  const config = loadConfig();
  const client = new Client({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: 10000,
  });
  let stopping = false;
  let connectionError = false;
  let ownsLock = false;
  process.once('SIGTERM', () => {
    stopping = true;
  });
  process.once('SIGINT', () => {
    stopping = true;
  });
  client.on('error', () => {
    connectionError = true;
    stopping = true;
  });
  await client.connect();
  try {
    const lock = await client.query<{ acquired: boolean }>(
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [workerLock],
    );
    if (!lock.rows[0]?.acquired) throw new Error('另一个 Worker 正在运行');
    ownsLock = true;
    console.info('Tattoo Worker 已连接数据库（P1：任务执行将在 P2 接入）');
    while (!stopping) {
      await client.query('SELECT 1');
      await writeFile(heartbeat, String(Date.now()), { mode: 0o600 });
      await setTimeout(5000);
    }
    if (connectionError) throw new Error('执行权连接中断');
  } finally {
    if (ownsLock) await unlink(heartbeat).catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

main().catch(() => {
  console.error('Tattoo Worker 停止：请检查配置、数据库及是否已有 Worker');
  process.exitCode = 1;
});
