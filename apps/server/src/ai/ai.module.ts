import { Module } from '@nestjs/common';
import { AssetsModule } from '../assets/assets.module';
import { IdentityModule } from '../identity/identity.module';
import { AiController } from './controller';
import { OpenAiProvider } from './provider';
import { AiService } from './service';
import { ContentModule } from '../content/content.module';
import { TopicCreationService } from './topics';
import { TopicCreationController } from './topics.controller';

export { AiService } from './service';

@Module({
  imports: [IdentityModule, AssetsModule, ContentModule],
  providers: [
    AiService,
    TopicCreationService,
    { provide: OpenAiProvider, useFactory: () => new OpenAiProvider() },
  ],
  controllers: [AiController, TopicCreationController],
  exports: [AiService, TopicCreationService],
})
export class AiModule {}
