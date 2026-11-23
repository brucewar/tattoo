import 'reflect-metadata';
import { Module, type INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { loadConfig } from './config';
import { RuntimeModule } from './runtime.module';
import { PublishingModule, PublishingService, WORKER_LOCK } from './publishing/publishing.module';
import { AiModule } from './ai/ai.module';
import { AiService } from './ai/service';

const heartbeat = join(tmpdir(), 'tattoo-worker-health');

@Module({ imports: [RuntimeModule, PublishingModule, AiModule] })
class WorkerModule {}

async function main() {
  const config = loadConfig();
  const client = new Client({
    connectionString: config.DATABASE_URL,
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
  });
  let stopping = false;
  let connectionError = false;
  let ownsLock = false;
  let application: INestApplicationContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
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
      [WORKER_LOCK],
    );
    if (!lock.rows[0]?.acquired) throw new Error('另一个 Worker 正在运行');
    ownsLock = true;
    application = await NestFactory.createApplicationContext(WorkerModule, {
      logger: ['warn', 'error'],
    });
    const publishing = application.get(PublishingService);
    const ai = application.get(AiService);
    const assertActive = async () => {
      if (stopping || connectionError || !ownsLock) throw new Error('Worker 执行权已停止');
      await client.query('SELECT 1');
      if (stopping || connectionError) throw new Error('Worker 执行权已停止');
    };
    await publishing.recover();
    await ai.recover();
    await writeFile(heartbeat, String(Date.now()), { mode: 0o600 });
    let refreshing = false;
    timer = setInterval(() => {
      if (refreshing || stopping) return;
      refreshing = true;
      void assertActive()
        .then(() => writeFile(heartbeat, String(Date.now()), { mode: 0o600 }))
        .catch(() => {
          connectionError = true;
          stopping = true;
        })
        .finally(() => {
          refreshing = false;
        });
    }, 5000);
    console.info(
      `Tattoo Worker 已就绪，远程写入${config.REMOTE_WRITES_ENABLED ? '已启用' : '已暂停'}`,
    );
    while (!stopping) {
      await assertActive();
      const processed = await publishing.processNext(assertActive);
      await assertActive();
      const generated = await ai.processNext(assertActive);
      if (!processed && !generated) await setTimeout(1000);
    }
    if (connectionError) throw new Error('执行权连接中断');
  } finally {
    if (timer) clearInterval(timer);
    if (ownsLock) await unlink(heartbeat).catch(() => undefined);
    await application?.close().catch(() => undefined);
    await client.end().catch(() => undefined);
  }
}

main().catch(() => {
  console.error('Tattoo Worker 停止：请检查配置、数据库及是否已有 Worker');
  process.exitCode = 1;
});
