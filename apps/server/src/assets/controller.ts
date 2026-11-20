import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createReadStream } from 'node:fs';
import { SessionGuard } from '../identity/identity.module';
import { AssetsService } from './service';

@Controller('assets')
@UseGuards(SessionGuard)
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}
  @Post() async upload(@Req() request: Request, @Headers('x-filename') filename?: string) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(filename ?? 'image');
    } catch {
      throw new BadRequestException('图片文件名编码无效');
    }
    return { data: await this.assets.upload(request.body as Buffer, decoded) };
  }
  @Get(':id') async get(@Param('id', ParseUUIDPipe) id: string, @Res() response: Response) {
    const { asset, path } = await this.assets.getFile(id);
    response.setHeader('Content-Type', asset.mime);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'private, no-store');
    const stream = createReadStream(path);
    stream.once('error', () => {
      if (!response.headersSent) response.status(404).end();
      else response.destroy();
    });
    stream.pipe(response);
  }
}
