import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { AssetsService } from './service';
import { AssetsController } from './controller';
export { AssetsService } from './service';

@Module({
  imports: [IdentityModule],
  providers: [AssetsService],
  controllers: [AssetsController],
  exports: [AssetsService],
})
export class AssetsModule {}
