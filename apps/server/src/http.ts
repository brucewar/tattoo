import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Response } from 'express';

@Catch()
export class PublicErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const status = error instanceof HttpException ? error.getStatus() : 500;
    response.status(status).json({
      error: {
        code: status === 500 ? 'INTERNAL_ERROR' : `HTTP_${status}`,
        message: error instanceof HttpException ? error.message : '服务暂时不可用，请稍后重试',
      },
    });
  }
}
