import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../identity/identity.module';
import { TopicCreationService } from './topics';

@Controller('ai/topics')
@UseGuards(SessionGuard)
export class TopicCreationController {
  constructor(private readonly topics: TopicCreationService) {}
  @Post() async create(@Body() body: unknown) {
    return { data: await this.topics.create(body) };
  }
  @Get() async list(@Query() query: unknown) {
    return { data: await this.topics.list(query) };
  }
  @Get(':id') async get(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.topics.get(id) };
  }
  @Post(':id/retry-cover') async retryCover(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return { data: await this.topics.retryCover(id, body) };
  }
  @Post(':id/resume-save') async resumeSave(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return { data: await this.topics.resumeSave(id, body) };
  }
}
