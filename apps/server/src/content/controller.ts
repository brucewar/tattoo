import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../identity/identity.module';
import { ContentService } from './service';

@Controller('articles')
@UseGuards(SessionGuard)
export class ContentController {
  constructor(private readonly content: ContentService) {}
  @Get() async list(@Query() query: unknown) {
    return { data: await this.content.list(query) };
  }
  @Post() async create(@Body() body: unknown) {
    return { data: await this.content.create(body) };
  }
  @Get(':id') async get(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.content.get(id) };
  }
  @Patch(':id') async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return { data: await this.content.update(id, body) };
  }
  @Get(':id/revisions') async revisions(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ) {
    return { data: await this.content.revisions(id, query) };
  }
  @Get(':id/revisions/:revisionId') async revision(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
  ) {
    return { data: await this.content.revision(id, revisionId) };
  }
  @Post(':id/preview') async preview(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return { data: await this.content.preview(id, body) };
  }
}
