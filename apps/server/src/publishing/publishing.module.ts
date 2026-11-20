import { Module } from '@nestjs/common';
import { AccountsModule } from '../accounts/accounts.module';
import { AssetsModule } from '../assets/assets.module';
import { IdentityModule } from '../identity/identity.module';
import { WechatModule } from '../platforms/wechat.module';
import { DeliveriesController, TestDraftController } from './publishing.controller';
import { PublishingExecutor } from './publishing.executor';
import { PublishingService } from './publishing.service';

export { PublishingService } from './publishing.service';
export { WORKER_LOCK } from './publishing.constants';

@Module({
  imports: [IdentityModule, AccountsModule, AssetsModule, WechatModule],
  providers: [PublishingService, PublishingExecutor],
  controllers: [TestDraftController, DeliveriesController],
  exports: [PublishingService],
})
export class PublishingModule {}
