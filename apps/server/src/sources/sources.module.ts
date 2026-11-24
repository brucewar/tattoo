import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { SourcesController } from './controller';
import { SourcesService } from './service';

export { SourcesService } from './service';
@Module({
  imports: [IdentityModule],
  controllers: [SourcesController],
  providers: [SourcesService],
  exports: [SourcesService],
})
export class SourcesModule {}
