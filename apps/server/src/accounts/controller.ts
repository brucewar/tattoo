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
import { AccountsService } from './service';

@Controller('accounts')
@UseGuards(SessionGuard)
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}
  @Get() async list(@Query() query: unknown) {
    return { data: await this.accounts.list(query) };
  }
  @Post() async create(@Body() body: unknown) {
    return { data: await this.accounts.create(body) };
  }
  @Patch(':id') async update(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return { data: await this.accounts.update(id, body) };
  }
  @Post(':id/verify') async verify(@Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.accounts.verify(id) };
  }
}
