import 'dotenv/config';
import { z } from 'zod';

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const c = z.object({
    NODE_ENV: z.string().default('development'),
    DATABASE_URL: z.string().min(1), REDIS_URL: z.string().url(),
    APP_ORIGIN: z.string().url().default('http://localhost:8080'),
    APP_ENCRYPTION_KEY: z.string().refine(v => /^[A-Za-z0-9+/]{43}=$/.test(v) && Buffer.from(v, 'base64').length === 32, '需要 base64 编码的 32 字节密钥'),
    ADMIN_EMAIL: z.string().email(), ADMIN_PASSWORD: z.string().min(12).max(256),
    STORAGE_PATH: z.string().default('./data/assets'),
    PORT: z.coerce.number().int().positive().default(3000),
    COOKIE_SECURE: z.enum(['true','false']).default('false'),
    WECHAT_API_BASE: z.string().url().default('https://api.weixin.qq.com'),
    ALLOW_MOCK_WECHAT: z.enum(['true','false']).default('false'),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  }).safeParse(env);
  if (!c.success) throw new Error(`环境配置无效：${c.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  if (c.data.WECHAT_API_BASE !== 'https://api.weixin.qq.com' && c.data.ALLOW_MOCK_WECHAT !== 'true') {
    throw new Error('非官方微信地址只允许在显式启用的模拟环境使用');
  }
  return c.data;
}
export type Config = ReturnType<typeof loadConfig>;
