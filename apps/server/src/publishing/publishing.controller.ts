import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../identity/identity.module';
import type { ActorRequest } from './publishing.dto';
import { PublishingService } from './publishing.service';

@Controller('accounts')
@UseGuards(SessionGuard)
export class TestDraftController {
  constructor(private readonly publishing: PublishingService) {}
  @Post(':id/test-draft')
  async test(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: ActorRequest,
  ) {
    return { data: await this.publishing.createTest(id, body, request.user.email) };
  }
}

@Controller('deliveries')
@UseGuards(SessionGuard)
export class DeliveriesController {
  constructor(private readonly publishing: PublishingService) {}
  @Post('check') async check(@Body() body: unknown) {
    return { data: await this.publishing.check(body) };
  }
  @Post() async create(@Body() body: unknown, @Req() request: ActorRequest) {
    return { data: await this.publishing.create(body, request.user.email) };
  }
  @Get() async list(@Query('page') page: unknown, @Query('pageSize') pageSize: unknown) {
    return { data: await this.publishing.list(page, pageSize) };
  }
  @Get(':id') async get(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.publishing.get(id) };
  }
  @Post(':id/retry') async retry(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: ActorRequest,
  ) {
    return { data: await this.publishing.retry(id, body, request.user.email) };
  }
  @Post(':id/resolve') async resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() request: ActorRequest,
  ) {
    return { data: await this.publishing.resolve(id, body, request.user.email) };
  }
}
