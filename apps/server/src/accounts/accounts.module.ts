import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { WechatModule } from '../platforms/wechat.module';
import { AccountsService } from './service';
import { AccountsController } from './controller';
export { AccountsService } from './service';

@Module({
  imports: [IdentityModule, WechatModule],
  providers: [AccountsService],
  controllers: [AccountsController],
  exports: [AccountsService],
})
export class AccountsModule {}
