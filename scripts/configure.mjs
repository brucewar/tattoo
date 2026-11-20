import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    output: { type: 'string', default: '.env' },
    origin: { type: 'string', default: 'http://localhost:8080' },
  },
});
const origin = new URL(values.origin);
if (
  !['http:', 'https:'].includes(origin.protocol) ||
  origin.origin !== values.origin ||
  /[\r\n]/.test(values.output)
)
  throw new Error('origin 必须是 http/https 来源，不包含路径');
const password = randomBytes(24).toString('hex');
const content = [
  '# Generated locally. Do not commit this file.',
  `POSTGRES_PASSWORD=${password}`,
  `DATABASE_URL=postgresql://tattoo:${password}@127.0.0.1:55433/tattoo`,
  `APP_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`,
  `APP_ORIGIN=${origin.origin}`,
  'ADMIN_EMAIL=admin@example.com',
  `ADMIN_PASSWORD=${randomBytes(24).toString('base64url')}`,
  `COOKIE_SECURE=${origin.protocol === 'https:'}`,
  'STORAGE_PATH=./data/assets',
  'REMOTE_WRITES_ENABLED=false',
  'WEB_PORT=8080',
  '',
].join('\n');
try {
  await writeFile(values.output, content, { flag: 'wx', mode: 0o600 });
  console.info('已生成本地配置文件。请在本机查看并修改管理员邮箱；不要提交或分享文件内容。');
} catch (error) {
  if (error.code === 'EEXIST') throw new Error('配置文件已存在，拒绝覆盖已有密钥');
  throw error;
}
