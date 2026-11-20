import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';
import sharp from 'sharp';
import { Database } from '../database';
import type { Config } from '../config';
import { IdentityModule, SessionGuard } from '../identity/identity.module';

const maxBytes = 10 * 1024 * 1024;
const maxPixels = 20_000_000;
const uuidFile = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|jpg)$/;

function kind(buffer: Buffer): 'png' | 'jpeg' | null {
  if (
    buffer.length >= 8 &&
    buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'png';
  if (buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255)
    return 'jpeg';
  return null;
}

@Injectable()
export class AssetsService {
  private readonly root: string;
  constructor(
    private readonly database: Database,
    @Inject('APP_CONFIG') config: Config,
  ) {
    this.root = resolve(config.STORAGE_PATH);
  }
  private publicAsset(asset: { id: string; name: string; mime: string; size: number }) {
    return {
      id: asset.id,
      name: asset.name,
      mime: asset.mime,
      size: asset.size,
      url: `/api/v1/assets/${asset.id}`,
    };
  }
  async upload(buffer: Buffer, name: string) {
    if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > maxBytes)
      throw new BadRequestException('图片不能为空，且不得超过 10 MiB');
    const format = kind(buffer);
    if (!format) throw new BadRequestException('仅支持真实的 JPG/PNG 图片');
    let normalized: Buffer;
    let width: number;
    let height: number;
    try {
      const image = sharp(buffer, {
        limitInputPixels: maxPixels,
        failOn: 'warning',
        animated: false,
      });
      const metadata = await image.metadata();
      if (
        metadata.format !== format ||
        !metadata.width ||
        !metadata.height ||
        metadata.width * metadata.height > maxPixels ||
        (metadata.pages ?? 1) > 1
      )
        throw new Error('invalid image');
      const result = await image
        .rotate()
        .timeout({ seconds: 10 })
        .toFormat(format === 'jpeg' ? 'jpeg' : 'png')
        .toBuffer({ resolveWithObject: true });
      normalized = result.data;
      width = result.info.width;
      height = result.info.height;
      if (normalized.length > maxBytes) throw new Error('normalized image too large');
    } catch {
      throw new BadRequestException('图片无法安全解码或超出像素/大小上限');
    }
    const hash = createHash('sha256').update(normalized).digest('hex');
    const existing = await this.database.asset.findUnique({ where: { sha256: hash } });
    if (existing) return this.publicAsset(existing);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const filename = `${randomUUID()}.${format === 'jpeg' ? 'jpg' : 'png'}`;
    const finalPath = resolve(this.root, filename);
    const temporary = resolve(this.root, `${filename}.tmp-${randomUUID()}`);
    let published = false;
    let committed = false;
    try {
      await writeFile(temporary, normalized, { flag: 'wx', mode: 0o600 });
      // A hard link publishes the complete file without replacing an existing path.
      await link(temporary, finalPath);
      published = true;
      await unlink(temporary);
      try {
        const asset = await this.database.asset.create({
          data: {
            id: randomUUID(),
            name: basename(name.replaceAll('\\', '/')).slice(0, 180) || 'image',
            mime: format === 'jpeg' ? 'image/jpeg' : 'image/png',
            size: normalized.length,
            width,
            height,
            sha256: hash,
            path: filename,
          },
        });
        committed = true;
        return this.publicAsset(asset);
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') {
          const winner = await this.database.asset.findUnique({ where: { sha256: hash } });
          if (winner) return this.publicAsset(winner);
        }
        throw error;
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
      if (published && !committed) await unlink(finalPath).catch(() => undefined);
    }
  }
  async getFile(id: string) {
    const asset = await this.database.asset.findUnique({ where: { id } });
    if (!asset || !uuidFile.test(asset.path)) throw new NotFoundException('素材不存在');
    const path = resolve(this.root, asset.path);
    if (!path.startsWith(`${this.root}${sep}`)) throw new NotFoundException('素材不存在');
    try {
      await access(path);
    } catch {
      throw new NotFoundException('素材文件不可用');
    }
    return { asset, path };
  }
  async coverBuffer(id: string): Promise<Buffer> {
    const { path } = await this.getFile(id);
    const original = await readFile(path);
    for (const size of [1600, 1200, 900, 640]) {
      const buffer = await sharp(original, { limitInputPixels: maxPixels })
        .rotate()
        .timeout({ seconds: 10 })
        .flatten({ background: '#ffffff' })
        .resize(size, size, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
      // This is an application-owned bound, not an assertion about a current official limit.
      if (buffer.length <= 512 * 1024) return buffer;
    }
    throw new BadRequestException('封面无法压缩到当前应用上传上限，请使用尺寸更小的图片');
  }
}

@Controller('assets')
@UseGuards(SessionGuard)
class AssetsController {
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

@Module({
  imports: [IdentityModule],
  providers: [AssetsService],
  controllers: [AssetsController],
  exports: [AssetsService],
})
export class AssetsModule {}
