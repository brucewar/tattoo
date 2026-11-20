import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { ContentService } from './service';
import { ContentController } from './controller';
export { ContentService } from './service';

@Module({
  imports: [IdentityModule],
  controllers: [ContentController],
  providers: [ContentService],
  exports: [ContentService],
})
export class ContentModule {}
