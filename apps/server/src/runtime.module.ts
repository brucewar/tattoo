import { Global, Module } from '@nestjs/common';
import { loadConfig } from './config';
import { Database } from './database';

@Global()
@Module({
  providers: [Database, { provide: 'APP_CONFIG', useFactory: () => loadConfig() }],
  exports: [Database, 'APP_CONFIG'],
})
export class RuntimeModule {}
