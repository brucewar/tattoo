import { spawn } from 'node:child_process';
import { loadConfig } from '../apps/server/dist/config.js';

loadConfig();
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('启动前步骤失败'))));
  });
}
await run([
  'node_modules/prisma/build/index.js',
  'migrate',
  'deploy',
  '--schema',
  'apps/server/prisma/schema.prisma',
]);
const api = spawn(process.execPath, ['apps/server/dist/main.js'], { stdio: 'inherit' });
process.once('SIGTERM', () => api.kill('SIGTERM'));
process.once('SIGINT', () => api.kill('SIGINT'));
api.once('error', () => {
  process.exitCode = 1;
});
api.once('exit', (code) => {
  process.exitCode = code ?? 1;
});
