import { expect, test, type Page, type Response } from '@playwright/test';
import { generate } from 'otplib';

const email = process.env.TATTOO_E2E_EMAIL;
const password = process.env.TATTOO_E2E_PASSWORD;
const origin = process.env.TATTOO_E2E_BASE_URL;
const loopback = (() => {
  try {
    return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin ?? '').hostname);
  } catch {
    return false;
  }
})();

test.skip(
  process.env.TATTOO_E2E_TEST_MODE !== '1' || !email || !password || !loopback,
  '需要隔离的真实 API、数据库与显式环回 E2E 测试配置',
);

async function enterPassword(page: Page) {
  await page.getByLabel('管理员邮箱', { exact: true }).fill(email!);
  await page.getByLabel('密码', { exact: true }).fill(password!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
}

async function openSecurity(page: Page) {
  await page.getByRole('button', { name: '账户安全', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账户安全', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '设置双重验证', exact: true })).toBeEnabled();
}

function writeResponse(page: Page, path: string) {
  return page.waitForResponse(
    (response: Response) =>
      new URL(response.url()).pathname === '/api/v1' + path &&
      response.request().method() === 'POST',
  );
}

async function cleanupAccount(page: Page, recoveryCodes: string[], secret: string | null) {
  const headers = { Origin: origin!, 'X-Tattoo-Request': '1' };
  const post = (path: string, data?: unknown) =>
    page.request.post('/api/v1' + path, { headers, data });
  let response = await page.request.get('/api/v1/auth/security');
  if (response.status() === 401) {
    const login = await post('/auth/login', { email, password });
    if (!login.ok()) throw new Error('隔离账户清理无法登录');
    if ((await login.json()).data.mfaRequired) {
      const code = recoveryCodes.at(-1);
      if (!code) throw new Error('隔离账户清理缺少恢复码');
      const verified = await post('/auth/login/verify', { code });
      if (!verified.ok()) throw new Error('隔离账户清理无法完成第二步验证');
    }
    response = await page.request.get('/api/v1/auth/security');
  }
  if (!response.ok()) throw new Error('隔离账户清理无法读取状态');
  if ((await response.json()).data.totpEnabled) {
    const code =
      recoveryCodes.at(-2) ??
      (secret
        ? await generate({
            secret,
            algorithm: 'sha1',
            digits: 6,
            period: 30,
            epoch: Math.floor(Date.now() / 1000) + 30,
          })
        : null);
    if (!code) throw new Error('隔离账户清理缺少双重验证证明');
    const disabled = await post('/auth/totp/disable', { currentPassword: password, code });
    if (!disabled.ok()) throw new Error('隔离账户清理无法关闭双重验证');
  }
  const logout = await post('/auth/logout');
  if (!logout.ok()) throw new Error('隔离账户清理无法退出会话');
}

test('真实浏览器完成TOTP绑定、拒绝OTP重放、恢复码登录和关闭2FA闭环', async ({ page }, testInfo) => {
  test.setTimeout(120000);
  let secret: string | null = null;
  let codes: string[] = [];
  let completed = false;
  try {
    await page.goto('/');
    await enterPassword(page);
    await expect(page.getByRole('heading', { name: '内容', exact: true })).toBeVisible();
    const initialSession = (await page.context().cookies()).find(
      (cookie) => cookie.name === 'tattoo_session',
    )?.value;
    await openSecurity(page);
    await page.getByRole('button', { name: '设置双重验证', exact: true }).click();
    const setup = page.getByRole('dialog', { name: '设置双重验证', exact: true });
    await setup.getByLabel('当前密码', { exact: true }).fill(password!);
    await setup.getByRole('button', { name: '继续设置', exact: true }).click();
    const manualSecret = setup.getByLabel('验证器设置密钥', { exact: true });
    await expect(manualSecret).toBeVisible();
    secret = (await manualSecret.textContent())!.replace(/\s/g, '');
    expect(/^[A-Z2-7]{52}$/.test(secret)).toBe(true);
    const usedCode = await generate({ secret, algorithm: 'sha1', digits: 6, period: 30 });
    await setup.getByLabel('验证器验证码', { exact: true }).fill(usedCode);
    const enableResponse = writeResponse(page, '/auth/totp/enable');
    await setup.getByRole('button', { name: '验证并启用', exact: true }).click();
    const enabled = await enableResponse;
    expect(enabled.status()).toBe(200);
    const result = (await enabled.json()).data;
    if (Array.isArray(result.recoveryCodes)) codes = result.recoveryCodes;
    const recovery = page.getByRole('dialog', { name: '保存恢复码', exact: true });
    await expect(recovery).toBeVisible();
    const displayedCodes = (await recovery.getByLabel('一次性恢复码', { exact: true }).inputValue())
      .split(/\r?\n/)
      .map((code) => code.trim())
      .filter(Boolean);
    expect(displayedCodes.length).toBe(10);
    expect(new Set(displayedCodes).size).toBe(10);
    expect(displayedCodes.every((code) => /^(?:[0-9a-f]{4}-){7}[0-9a-f]{4}$/i.test(code))).toBe(
      true,
    );
    codes = displayedCodes;
    await recovery
      .getByRole('checkbox', { name: '我已将这组恢复码保存到安全的地方', exact: true })
      .check();
    await recovery.getByRole('button', { name: '完成', exact: true }).click();
    await expect(recovery).not.toBeVisible();
    await expect(page.getByText('已启用', { exact: true })).toBeVisible();
    const enabledSession = (await page.context().cookies()).find(
      (cookie) => cookie.name === 'tattoo_session',
    )?.value;
    expect(Boolean(enabledSession && enabledSession !== initialSession)).toBe(true);

    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
    await enterPassword(page);
    await expect(page.getByLabel('验证器验证码', { exact: true })).toBeVisible();
    const challenge = (await page.context().cookies()).find(
      (cookie) => cookie.name === 'tattoo_login_challenge',
    );
    expect(challenge?.httpOnly).toBe(true);
    expect(challenge?.sameSite).toBe('Strict');
    expect(
      (await page.context().cookies()).some((cookie) => cookie.name === 'tattoo_session'),
    ).toBe(false);
    await page.getByLabel('验证器验证码', { exact: true }).fill(usedCode);
    const replayResponse = writeResponse(page, '/auth/login/verify');
    await page.getByRole('button', { name: '验证并登录', exact: true }).click();
    expect((await replayResponse).status()).toBe(400);
    await expect(page.getByLabel('验证器验证码', { exact: true })).toBeVisible();
    expect(
      (await page.context().cookies()).some((cookie) => cookie.name === 'tattoo_session'),
    ).toBe(false);
    await page.getByRole('button', { name: '使用恢复码', exact: true }).click();
    await page.getByLabel('一次性恢复码', { exact: true }).fill(codes[0]!);
    await page.getByRole('button', { name: '验证并登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '账户安全', exact: true })).toBeVisible();
    expect(
      (await page.context().cookies()).some((cookie) => cookie.name === 'tattoo_login_challenge'),
    ).toBe(false);

    await page.getByRole('button', { name: '账户安全', exact: true }).click();
    await expect(page.getByText(/剩余 9 个一次性恢复码/)).toBeVisible();
    await page.getByRole('button', { name: '关闭双重验证', exact: true }).click();
    const disable = page.getByRole('dialog', { name: '关闭双重验证', exact: true });
    await disable.getByLabel('当前密码', { exact: true }).fill(password!);
    await disable.getByRole('button', { name: '使用恢复码', exact: true }).click();
    await disable.getByLabel('一次性恢复码', { exact: true }).fill(codes[1]!);
    await disable.getByRole('button', { name: '关闭双重验证', exact: true }).click();
    await expect(disable).not.toBeVisible();
    await expect(page.getByText('未启用', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await enterPassword(page);
    await expect(page.getByRole('heading', { name: '账户安全', exact: true })).toBeVisible();
    await expect(page.getByLabel('验证器验证码', { exact: true })).toHaveCount(0);
    completed = true;
  } finally {
    try {
      await cleanupAccount(page, codes, secret);
    } catch {
      if (completed) throw new Error('账户安全闭环后的隔离状态清理失败');
      await testInfo.attach('account-security-cleanup', {
        body: '隔离测试账户清理未完成，请检查本例的首个失败；未输出密码、种子或恢复码。',
        contentType: 'text/plain',
      });
    }
  }
});
