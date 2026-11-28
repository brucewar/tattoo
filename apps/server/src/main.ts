import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { json, raw } from 'express';
import { resolve } from 'node:path';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { PublicErrorFilter } from './http';
import { installWeb } from './web';

async function main() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { logger: ['warn', 'error'], bodyParser: false });
  app.setGlobalPrefix('api/v1');
  // The container is now the public entry; untrusted forwarded headers must not
  // let a direct client evade the login limit by inventing a different address.
  app.getHttpAdapter().getInstance().set('trust proxy', false);
  app.use((_request: unknown, response: import('express').Response, next: () => void) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/v1/assets', raw({ type: () => true, limit: 10 * 1024 * 1024 }));
  app.use(json({ limit: 2 * 1024 * 1024 }));
  installWeb(
    app.getHttpAdapter().getInstance(),
    resolve(__dirname, '../../web/dist'),
    config.NODE_ENV === 'production',
  );
  app.useGlobalFilters(new PublicErrorFilter());
  app.enableShutdownHooks();
  await app.listen(config.PORT, config.TEST_BIND_LOOPBACK ? '127.0.0.1' : '0.0.0.0');
  console.info('Tattoo API 已启动');
}

main().catch(() => {
  console.error('Tattoo API 启动失败，请检查配置、迁移与数据库连接');
  process.exitCode = 1;
});
