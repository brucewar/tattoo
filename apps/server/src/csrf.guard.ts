import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Config } from './config';

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(@Inject('APP_CONFIG') private readonly config: Config) {}

  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;
    if (
      request.headers.origin !== this.config.APP_ORIGIN ||
      request.headers['x-tattoo-request'] !== '1'
    ) {
      throw new ForbiddenException({
        code: 'CSRF_REJECTED',
        message: '请求来源无效，请从工作台重新操作',
      });
    }
    return true;
  }
}
