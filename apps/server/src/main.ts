import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { PublicErrorFilter } from './http';

async function main() {
  const config = loadConfig();
  const app = await NestFactory.create(AppModule, { logger: ['warn', 'error'] });
  app.setGlobalPrefix('api/v1');
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
