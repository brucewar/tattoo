import { spawnSync } from 'node:child_process';

if (
  !process.env.TEST_DATABASE_URL ||
  !/test/i.test(new URL(process.env.TEST_DATABASE_URL).pathname)
)
  throw new Error('必须提供独立 TEST_DATABASE_URL，且数据库名包含 test');
const env = { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL };
for (const args of [
  [
    'node_modules/prisma/build/index.js',
    'migrate',
    'deploy',
    '--schema',
    'apps/server/prisma/schema.prisma',
  ],
  ['node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.integration.config.ts'],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
