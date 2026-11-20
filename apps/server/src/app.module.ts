import { Controller, Get, Module, ServiceUnavailableException } from '@nestjs/common';
import { Database } from './database';

@Controller('health')
class HealthController {
  constructor(private readonly database: Database) {}

  @Get('live')
  live() {
    return { data: { status: 'ok' } };
  }

  @Get('ready')
  async ready() {
    try {
      await this.database.$queryRaw`SELECT 1`;
      return { data: { status: 'ready' } };
    } catch {
      throw new ServiceUnavailableException('数据库暂不可用');
    }
  }
}

@Module({ providers: [Database], controllers: [HealthController] })
export class AppModule {}
