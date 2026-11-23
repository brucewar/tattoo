import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard } from '../identity/identity.module';
import { AiService } from './service';

@Controller('ai')
@UseGuards(SessionGuard)
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('models') async models() {
    return { data: await this.ai.listModels() };
  }
  @Put('models/:capability') async saveModel(
    @Param('capability') capability: string,
    @Body() body: unknown,
  ) {
    return { data: await this.ai.saveModel(capability, body) };
  }
  @Post('jobs') async create(@Body() body: unknown) {
    return { data: await this.ai.createJob(body) };
  }
  @Get('jobs') async list(@Query() query: unknown) {
    return { data: await this.ai.listJobs(query) };
  }
  @Get('jobs/:id') async get(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.ai.getJob(id) };
  }
}
