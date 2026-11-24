import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../identity/identity.module';
import { SourcesService } from './service';

@Controller('sources')
@UseGuards(SessionGuard)
export class SourcesController {
  constructor(private readonly sources: SourcesService) {}
  @Get('feeds') async feeds(@Query() query: unknown) {
    return { data: await this.sources.listFeeds(query) };
  }
  @Post('feeds') async createFeed(@Body() body: unknown) {
    return { data: await this.sources.createFeed(body) };
  }
  @Delete('feeds/:id') async deleteFeed(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.sources.deleteFeed(id) };
  }
  @Get('search-config') async config() {
    return { data: await this.sources.getSearchConfig() };
  }
  @Put('search-config') async saveConfig(@Body() body: unknown) {
    return { data: await this.sources.saveSearchConfig(body) };
  }
  @Get('jobs') async jobs(@Query() query: unknown) {
    return { data: await this.sources.listJobs(query) };
  }
  @Post('jobs') async createJob(@Body() body: unknown) {
    return { data: await this.sources.createJob(body) };
  }
  @Get('jobs/:id') async job(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.sources.getJob(id) };
  }
  @Get() async list(@Query() query: unknown) {
    return { data: await this.sources.listSources(query) };
  }
  @Get(':id') async source(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.sources.getSource(id) };
  }
}
