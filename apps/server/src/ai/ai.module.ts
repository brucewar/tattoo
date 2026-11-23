import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { IdentityModule } from '../identity/identity.module';
import { AiController } from './controller';
import { OpenAiProvider } from './provider';
import { AiService } from './service';

export { AiService } from './service';

@Module({
  imports: [IdentityModule, AssetsModule],
  providers: [AiService, { provide: OpenAiProvider, useFactory: () => new OpenAiProvider() }],
  controllers: [AiController],
  exports: [AiService],
})
export class AiModule {}
