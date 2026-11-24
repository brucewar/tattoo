import { config as readEnvironment } from 'dotenv';
import { resolve } from 'node:path';
import { z } from 'zod';

const repositoryRoot = resolve(__dirname, '../../..');
readEnvironment({ path: resolve(repositoryRoot, '.env') });

const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = z
    .object({
      NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
      DATABASE_URL: z
        .string()
        .url()
        .refine((value) => /^postgres(ql)?:\/\//.test(value)),
      APP_ORIGIN: z.string().url().default('http://localhost:8080'),
      APP_ENCRYPTION_KEY: z
        .string()
        .refine(
          (value) =>
            /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').length === 32,
          '需要 base64 编码的 32 字节密钥',
        ),
      ADMIN_EMAIL: z.string().email().default('admin@example.com'),
      ADMIN_PASSWORD: z.preprocess(
        (value) => (value === '' ? undefined : value),
        z.string().min(12).max(256).optional(),
      ),
      STORAGE_PATH: z.string().min(1).default('./data/assets'),
      PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      COOKIE_SECURE: flag.optional(),
      WECHAT_API_BASE: z.string().url().default('https://api.weixin.qq.com'),
      ALLOW_MOCK_WECHAT: flag.default('false'),
      REMOTE_WRITES_ENABLED: flag.default('false'),
      SOURCES_TEST_ORIGIN: z.string().url().optional(),
    })
    .safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `环境配置无效：${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
    );
  }
  const config = parsed.data;
  if (config.SOURCES_TEST_ORIGIN) {
    const testOrigin = new URL(config.SOURCES_TEST_ORIGIN);
    if (
      config.NODE_ENV !== 'test' ||
      testOrigin.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(testOrigin.hostname) ||
      testOrigin.origin !== config.SOURCES_TEST_ORIGIN ||
      testOrigin.username ||
      testOrigin.password
    )
      throw new Error('SOURCES_TEST_ORIGIN 只允许测试环境中的精确 HTTP 环回来源');
  }
  const origin = new URL(config.APP_ORIGIN);
  if (
    !['http:', 'https:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error('APP_ORIGIN 必须是 http/https 来源，不包含路径、凭证、查询或片段');
  }
  if (
    config.WECHAT_API_BASE !== 'https://api.weixin.qq.com' &&
    !(config.NODE_ENV === 'test' && config.ALLOW_MOCK_WECHAT)
  ) {
    throw new Error('非官方微信地址只允许在显式启用的 test 环境使用');
  }
  const secure = config.COOKIE_SECURE ?? origin.protocol === 'https:';
  if (origin.protocol === 'https:' && !secure) throw new Error('HTTPS 环境必须启用 Secure Cookie');
  return {
    ...config,
    APP_ORIGIN: origin.origin,
    COOKIE_SECURE: secure,
    STORAGE_PATH: resolve(repositoryRoot, config.STORAGE_PATH),
  };
}

export type Config = ReturnType<typeof loadConfig>;
