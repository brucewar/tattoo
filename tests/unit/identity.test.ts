import { describe, expect, it } from 'vitest';
import { readSessionToken } from '../../apps/server/src/identity/service';
import { LoginRateLimiter } from '../../apps/server/src/identity/rate-limit';

describe('身份边界', () => {
  it('只接受一个格式正确的随机会话 Cookie', () => {
    const token = 'a'.repeat(64);
    expect(readSessionToken(`other=value; tattoo_session=${token}`)).toBe(token);
    expect(readSessionToken(undefined)).toBeNull();
    expect(readSessionToken('tattoo_session=%ZZ')).toBeNull();
    expect(readSessionToken(`tattoo_session=${token}; tattoo_session=${token}`)).toBeNull();
    expect(readSessionToken(`tattoo_session=${'a'.repeat(16385)}`)).toBeNull();
  });
  it('限制同一 IP 的尝试，窗口结束后恢复', () => {
    let now = 0;
    const limiter = new LoginRateLimiter(() => now);
    for (let attempt = 0; attempt < 5; attempt++) limiter.consume('one-client');
    expect(() => limiter.consume('one-client')).toThrow('频繁');
    expect(() => limiter.consume('another-client')).not.toThrow();
    now = 15 * 60 * 1000;
    expect(() => limiter.consume('one-client')).not.toThrow();
  });
  it('内存计数有上限且不通过淘汰活跃计数绕过限流', () => {
    let now = 0;
    const limiter = new LoginRateLimiter(() => now, 1);
    limiter.consume('first');
    expect(() => limiter.consume('second')).toThrow('频繁');
    now += 15 * 60 * 1000;
    expect(() => limiter.consume('second')).not.toThrow();
    limiter.clear('second');
    expect(() => limiter.consume('third')).not.toThrow();
  });
});
