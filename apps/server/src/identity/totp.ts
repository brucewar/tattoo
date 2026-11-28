import { randomBytes } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import { hashToken } from '../security';

export const totpPeriodSeconds = 30;
export const recoveryCodeCount = 10;

export function createTotpSecret(): string {
  return generateSecret({ length: 32 });
}

export function createTotpUri(secret: string, email: string): string {
  const uri = new URL(
    generateURI({
      strategy: 'totp',
      issuer: 'Tattoo',
      label: email,
      secret,
      algorithm: 'sha1',
      digits: 6,
      period: totpPeriodSeconds,
    }),
  );
  // The library omits standard defaults; include them explicitly in enrollment.
  uri.searchParams.set('algorithm', 'SHA1');
  uri.searchParams.set('digits', '6');
  uri.searchParams.set('period', String(totpPeriodSeconds));
  return uri.toString();
}

export function normalizeProof(value: string): string {
  return value.replace(/[\s-]/g, '').toLowerCase();
}

export async function verifyTotpStep(
  secret: string,
  token: string,
  lastStep: number | null,
  now = Date.now(),
): Promise<number | null> {
  const normalized = normalizeProof(token);
  if (!/^\d{6}$/.test(normalized)) return null;
  try {
    const result = await verify({
      strategy: 'totp',
      secret,
      token: normalized,
      algorithm: 'sha1',
      digits: 6,
      period: totpPeriodSeconds,
      epoch: Math.floor(now / 1000),
      epochTolerance: totpPeriodSeconds,
      ...(lastStep === null ? {} : { afterTimeStep: lastStep }),
    });
    return result.valid && 'timeStep' in result ? result.timeStep : null;
  } catch {
    // Invalid clocks, stored state and malformed tokens all fail closed.
    return null;
  }
}

export function createRecoveryCodes(): string[] {
  return Array.from({ length: recoveryCodeCount }, () =>
    randomBytes(16).toString('hex').match(/.{4}/g)!.join('-'),
  );
}

export function recoveryCodeHash(userId: string, code: string): string | null {
  const normalized = normalizeProof(code);
  return /^[0-9a-f]{32}$/.test(normalized)
    ? hashToken(`tattoo:recovery:v1:${userId}:${normalized}`)
    : null;
}
