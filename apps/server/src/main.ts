import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { json, raw } from 'express';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { PublicErrorFilter } from './http';

async function main() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { logger: ['warn', 'error'], bodyParser: false });
  app.setGlobalPrefix('api/v1');
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.use((_request: unknown, response: import('express').Response, next: () => void) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/v1/assets', raw({ type: () => true, limit: 10 * 1024 * 1024 }));
  app.use(json({ limit: 2 * 1024 * 1024 }));
  app.use(helmet());
  app.useGlobalFilters(new PublicErrorFilter());
  app.enableShutdownHooks();
  await app.listen(config.PORT, '0.0.0.0');
  console.info('Tattoo API 已启动');
}

main().catch(() => {
  console.error('Tattoo API 启动失败，请检查配置、迁移与数据库连接');
  process.exitCode = 1;
});
