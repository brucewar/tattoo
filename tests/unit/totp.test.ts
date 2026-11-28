import { describe, expect, it } from 'vitest';
import { generate } from 'otplib';
import {
  createRecoveryCodes,
  createTotpSecret,
  createTotpUri,
  normalizeProof,
  recoveryCodeHash,
  verifyTotpStep,
} from '../../apps/server/src/identity/totp';
import { readChallengeToken } from '../../apps/server/src/identity/service';

const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('标准 TOTP 与账户恢复凭据', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('验证 RFC 6238 SHA1 向量的六位形式：epoch=%i', async (epoch, code) => {
    expect(await verifyTotpStep(rfcSecret, code, null, epoch * 1000)).toBe(Math.floor(epoch / 30));
  });

  it('仅容忍相邻一个时间步，持久时间步下限阻止重放', async () => {
    const epoch = 1234567890;
    const step = Math.floor(epoch / 30);
    const nextCode = await generate({
      secret: rfcSecret,
      algorithm: 'sha1',
      digits: 6,
      period: 30,
      epoch: epoch + 30,
    });
    expect(await verifyTotpStep(rfcSecret, '005924', null, (epoch + 30) * 1000)).toBe(step);
    expect(await verifyTotpStep(rfcSecret, '005924', null, (epoch + 60) * 1000)).toBeNull();
    expect(await verifyTotpStep(rfcSecret, nextCode, null, epoch * 1000)).toBe(step + 1);
    expect(await verifyTotpStep(rfcSecret, nextCode, step, epoch * 1000)).toBe(step + 1);
    expect(await verifyTotpStep(rfcSecret, '005924', step, epoch * 1000)).toBeNull();
    expect(await verifyTotpStep(rfcSecret, nextCode, step + 1, epoch * 1000)).toBeNull();
    expect(await verifyTotpStep(rfcSecret, '005924', step + 100, epoch * 1000)).toBeNull();
  });

  it.each(['', '12345', '1234567', '１２３４５６', 'abc123', '000000x'])(
    '拒绝无效格式且不抛出内部库错误：%s',
    async (token) => {
      expect(await verifyTotpStep(rfcSecret, token, null, 1234567890000)).toBeNull();
    },
  );

  it('绑定使用随机 256 bit Base32 种子以及 Google/Microsoft 通用参数', () => {
    const secret = createTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{52}$/);
    expect(createTotpSecret()).not.toBe(secret);
    const uri = new URL(createTotpUri(secret, 'creator+test@example.com'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.hostname).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toContain('Tattoo:creator+test@example.com');
    expect(uri.searchParams.get('issuer')).toBe('Tattoo');
    expect(uri.searchParams.get('secret')).toBe(secret);
    expect(uri.searchParams.get('algorithm')?.toLowerCase()).toBe('sha1');
    expect(uri.searchParams.get('digits')).toBe('6');
    expect(uri.searchParams.get('period')).toBe('30');
  });

  it('生成十枚独立 128 bit 恢复码，仅产生用户绑定的哈希', () => {
    const codes = createRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) {
      expect(code).toMatch(/^(?:[0-9a-f]{4}-){7}[0-9a-f]{4}$/);
      const hashed = recoveryCodeHash('first-admin', code);
      expect(hashed).toMatch(/^[0-9a-f]{64}$/);
      expect(hashed).not.toContain(normalizeProof(code));
      expect(recoveryCodeHash('first-admin', code.toUpperCase().replaceAll('-', ' '))).toBe(hashed);
      expect(recoveryCodeHash('other-admin', code)).not.toBe(hashed);
    }
    expect(recoveryCodeHash('first-admin', '123456')).toBeNull();
    expect(recoveryCodeHash('first-admin', 'g'.repeat(32))).toBeNull();
    expect(recoveryCodeHash('first-admin', 'a'.repeat(33))).toBeNull();
  });

  it('验证码可以粘贴分组空格，挑战 Cookie 必须唯一且格式正确', async () => {
    expect(await verifyTotpStep(rfcSecret, '005 924', null, 1234567890000)).toBe(41152263);
    const token = 'b'.repeat(64);
    expect(
      readChallengeToken(`tattoo_session=${'a'.repeat(64)}; tattoo_login_challenge=${token}`),
    ).toBe(token);
    expect(
      readChallengeToken(`tattoo_login_challenge=${token}; tattoo_login_challenge=${token}`),
    ).toBeNull();
    expect(readChallengeToken('tattoo_login_challenge=%ZZ')).toBeNull();
    expect(readChallengeToken(undefined)).toBeNull();
  });
});
