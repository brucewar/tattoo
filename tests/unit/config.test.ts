import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../apps/server/src/config';
import { resolve } from 'node:path';

const valid = {
  DATABASE_URL: 'postgresql://tattoo:test@localhost/tattoo_test',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describe('部署配置', () => {
  it('隔离 HTTP 测试可显式只监听环回，生产与默认容器监听保持不变', () => {
    expect(loadConfig(valid).TEST_BIND_LOOPBACK).toBe(false);
    expect(
      loadConfig({ ...valid, NODE_ENV: 'test', TEST_BIND_LOOPBACK: 'true' }).TEST_BIND_LOOPBACK,
    ).toBe(true);
    expect(() =>
      loadConfig({ ...valid, NODE_ENV: 'production', TEST_BIND_LOOPBACK: 'true' }),
    ).toThrow('TEST_BIND_LOOPBACK');
  });
  it('资料抓取测试例外只允许 test 环境的精确 HTTP 环回来源', () => {
    expect(
      loadConfig({ ...valid, NODE_ENV: 'test', SOURCES_TEST_ORIGIN: 'http://127.0.0.1:8099' })
        .SOURCES_TEST_ORIGIN,
    ).toBe('http://127.0.0.1:8099');
    for (const settings of [
      { NODE_ENV: 'production', SOURCES_TEST_ORIGIN: 'http://127.0.0.1:8099' },
      { NODE_ENV: 'test', SOURCES_TEST_ORIGIN: 'http://169.254.169.254' },
      { NODE_ENV: 'test', SOURCES_TEST_ORIGIN: 'http://127.0.0.1:8099/path' },
      { NODE_ENV: 'test', SOURCES_TEST_ORIGIN: 'http://user:secret@127.0.0.1:8099' },
    ])
      expect(() => loadConfig({ ...valid, ...settings })).toThrow('SOURCES_TEST_ORIGIN');
  });
  it('相对素材路径固定在仓库根目录，不依赖 workspace 启动目录', () => {
    expect(loadConfig({ ...valid, STORAGE_PATH: './data/assets' }).STORAGE_PATH).toBe(
      resolve(__dirname, '../../data/assets'),
    );
  });
  it('没有加密主密钥时拒绝启动，并且错误不泄漏其他配置值', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://tattoo:private-password@localhost/db' }),
    ).toThrow('APP_ENCRYPTION_KEY');
    try {
      loadConfig({ DATABASE_URL: 'private-connection-secret' });
    } catch (error) {
      expect(String(error)).not.toContain('private-connection-secret');
    }
  });
  it('允许初始化后移除初始密码，远程写入默认关闭', () => {
    const config = loadConfig(valid);
    expect(config.ADMIN_PASSWORD).toBeUndefined();
    expect(loadConfig({ ...valid, ADMIN_PASSWORD: '' }).ADMIN_PASSWORD).toBeUndefined();
    expect(config.REMOTE_WRITES_ENABLED).toBe(false);
    expect(config).not.toHaveProperty('REDIS_URL');
  });
  it('生产环境不能通过模拟开关转发凭证到任意域名', () => {
    expect(() =>
      loadConfig({
        ...valid,
        NODE_ENV: 'production',
        ALLOW_MOCK_WECHAT: 'true',
        WECHAT_API_BASE: 'http://localhost:9000',
      }),
    ).toThrow('test');
    expect(
      loadConfig({
        ...valid,
        NODE_ENV: 'test',
        ALLOW_MOCK_WECHAT: 'true',
        WECHAT_API_BASE: 'http://localhost:9000',
      }).WECHAT_API_BASE,
    ).toBe('http://localhost:9000');
  });
  it('来源不能带路径或凭证，HTTPS 自动开启安全 Cookie', () => {
    expect(() => loadConfig({ ...valid, APP_ORIGIN: 'https://example.com/extra' })).toThrow(
      'APP_ORIGIN',
    );
    expect(() =>
      loadConfig({ ...valid, APP_ORIGIN: 'https://example.com', COOKIE_SECURE: 'false' }),
    ).toThrow('Secure');
    expect(loadConfig({ ...valid, APP_ORIGIN: 'https://example.com' }).COOKIE_SECURE).toBe(true);
  });
});
