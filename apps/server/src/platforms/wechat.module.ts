import { Module } from '@nestjs/common';
import { PLATFORM_DRAFT_ADAPTER } from './draft-adapter';
import { WechatService } from './wechat/service';

export { WechatService } from './wechat/service';
export { WechatError } from './wechat/error';
export { RENDER_VERSION as WECHAT_RENDER_VERSION } from './wechat/renderer';

@Module({
  providers: [WechatService, { provide: PLATFORM_DRAFT_ADAPTER, useExisting: WechatService }],
  exports: [WechatService, PLATFORM_DRAFT_ADAPTER],
})
export class WechatModule {}
