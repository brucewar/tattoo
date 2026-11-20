import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class PublicErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const parserType = error && typeof error === 'object' && 'type' in error ? error.type : null;
    const status =
      parserType === 'entity.too.large'
        ? 413
        : parserType === 'entity.parse.failed'
          ? 400
          : error instanceof HttpException
            ? error.getStatus()
            : 500;
    const body = error instanceof HttpException ? error.getResponse() : null;
    const detail =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
    response.status(status).json({
      error: {
        code:
          typeof detail?.code === 'string'
            ? detail.code
            : status === 500
              ? 'INTERNAL_ERROR'
              : `HTTP_${status}`,
        message:
          parserType === 'entity.too.large'
            ? '请求超过允许大小'
            : parserType === 'entity.parse.failed'
              ? 'JSON 格式无效'
              : typeof detail?.message === 'string'
                ? detail.message
                : error instanceof HttpException
                  ? error.message
                  : '服务暂时不可用，请稍后重试',
        ...(detail?.details ? { details: detail.details } : {}),
      },
    });
  }
}
