import { describe, expect, it } from 'vitest';
import {
  SecretBox,
  hashPassword,
  verifyPassword,
  hashToken,
  redact,
} from '../../apps/server/src/security';

describe('凭证保护', () => {
  it('使用认证加密，篡改密文或使用错误主密钥不能解密', () => {
    const box = new SecretBox(Buffer.alloc(32, 3).toString('base64'));
    const encrypted = box.encrypt('private-app-secret');
    expect(encrypted).not.toContain('private-app-secret');
    expect(box.decrypt(encrypted)).toBe('private-app-secret');
    expect(() =>
      new SecretBox(Buffer.alloc(32, 4).toString('base64')).decrypt(encrypted),
    ).toThrow();
    const parts = encrypted.split('.');
    const tag = Buffer.from(parts[2]!, 'base64');
    tag[0] = tag[0]! ^ 1;
    parts[2] = tag.toString('base64');
    expect(() => box.decrypt(parts.join('.'))).toThrow();
  });
  it('密码使用独立随机盐，并拒绝错误密码与损坏哈希', () => {
    const hash = hashPassword('correct-password');
    expect(hashPassword('correct-password')).not.toBe(hash);
    expect(verifyPassword('correct-password', hash)).toBe(true);
    expect(verifyPassword('incorrect-password', hash)).toBe(false);
    expect(verifyPassword('correct-password', 'broken')).toBe(false);
    expect(hashToken('session-token')).not.toContain('session-token');
  });
  it('脱敏显式密钥与 URL 中的 token', () => {
    const result = redact('access_token=token-value&secret=secret-value private-app-secret', [
      'private-app-secret',
    ]);
    for (const secret of ['token-value', 'secret-value', 'private-app-secret'])
      expect(result).not.toContain(secret);
  });
});
