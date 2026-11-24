import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RuntimeModule } from './runtime.module';
import { IdentityModule } from './identity/identity.module';
import { AccountsModule } from './accounts/accounts.module';
import { AssetsModule } from './assets/assets.module';
import { PublishingModule } from './publishing/publishing.module';
import { ContentModule } from './content/content.module';
import { AiModule } from './ai/ai.module';
import { SourcesModule } from './sources/sources.module';
import { CsrfGuard } from './csrf.guard';
import { HealthController } from './health.controller';

@Module({
  imports: [
    RuntimeModule,
    IdentityModule,
    AccountsModule,
    AssetsModule,
    PublishingModule,
    ContentModule,
    AiModule,
    SourcesModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: CsrfGuard }],
  controllers: [HealthController],
})
export class AppModule {}
