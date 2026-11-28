import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AccountSecurityStatus, Article, ArticleInput } from '@tattoo/contracts';

test.skip(process.env.TATTOO_E2E_TEST_MODE !== '1', '需要隔离的前端验证环境');

const currentPassword = 'fixture-current-password';
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA';
const setupId = '15151515-1515-4515-8515-151515151515';
const codes = (prefix: string) =>
  Array.from({ length: 10 }, (_, index) =>
    `${prefix.repeat(30)}${index.toString(16).padStart(2, '0')}`
      .match(/.{4}/g)!
      .join('-')
      .toUpperCase(),
  );
const firstCodes = codes('a');
const nextCodes = codes('b');

async function fixture(
  page: Page,
  options: {
    loggedIn?: boolean;
    totpEnabled?: boolean;
    expireFirstSave?: boolean;
    loseEnableResponse?: boolean;
    loseVerifyResponse?: 'cookie-set' | 'cookie-lost';
    passwordFailures?: { status: number; message: string }[];
  } = {},
) {
  let loggedIn = options.loggedIn ?? true;
  let expireFirstSave = options.expireFirstSave ?? false;
  let loseEnableResponse = options.loseEnableResponse ?? false;
  let loseVerifyResponse = options.loseVerifyResponse;
  const passwordFailures = [...(options.passwordFailures ?? [])];
  let saved: Article | null = null;
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const unexpected: string[] = [];
  const status: AccountSecurityStatus = {
    totpEnabled: options.totpEnabled ?? false,
    recoveryCodesRemaining: options.totpEnabled ? 10 : 0,
    otherSessionsCount: 2,
  };
  const emptyPage = { items: [], total: 0, page: 1, pageSize: 20 };
  const user = { id: 'security-demo-user', email: 'demo@example.com', remoteWritesEnabled: false };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();
    const body = method === 'POST' ? (request.postDataJSON() as Record<string, unknown>) : {};
    let data: unknown;
    if (path === '/auth/me') {
      if (!loggedIn) {
        await route.fulfill({ status: 401, json: { error: { message: '请先登录' } } });
        return;
      }
      data = user;
    } else if (path === '/articles' && method === 'GET') {
      data = emptyPage;
    } else if (path === '/articles' && method === 'POST') {
      if (expireFirstSave) {
        expireFirstSave = false;
        loggedIn = false;
        await route.fulfill({ status: 401, json: { error: { message: '会话已过期' } } });
        return;
      }
      const input = body as unknown as ArticleInput;
      saved = {
        ...input,
        id: 'security-demo-article',
        revisionId: 'security-demo-revision',
        version: 1,
        updatedAt: new Date().toISOString(),
      };
      data = saved;
    } else if (path === '/auth/login' && method === 'POST') {
      writes.push({ path, body });
      data = {
        mfaRequired: true,
        challengeExpiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      };
    } else if (path === '/auth/login/verify' && method === 'POST') {
      writes.push({ path, body });
      if (loseVerifyResponse) {
        loggedIn = loseVerifyResponse === 'cookie-set';
        loseVerifyResponse = undefined;
        await route.abort('failed');
        return;
      }
      if (body.code === '000000') {
        await route.fulfill({ status: 400, json: { error: { message: '验证码错误，请重试' } } });
        return;
      }
      if (body.code === '111111') {
        await route.fulfill({
          status: 401,
          json: { error: { message: '本次登录验证已失效，请重新登录' } },
        });
        return;
      }
      loggedIn = true;
      data = user;
    } else if (path === '/auth/login/cancel' && method === 'POST') {
      writes.push({ path, body });
      data = { cancelled: true };
    } else if (path === '/auth/security' && method === 'GET') {
      data = status;
    } else if (path === '/auth/totp/setup' && method === 'POST') {
      writes.push({ path, body });
      data = {
        setupId,
        secret,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        otpauthUrl: `otpauth://totp/Tattoo:demo%40example.com?secret=${secret}&issuer=Tattoo&algorithm=SHA1&digits=6&period=30`,
      };
    } else if (path === '/auth/totp/enable' && method === 'POST') {
      writes.push({ path, body });
      status.totpEnabled = true;
      status.recoveryCodesRemaining = 10;
      status.otherSessionsCount = 0;
      if (loseEnableResponse) {
        loseEnableResponse = false;
        await route.abort('failed');
        return;
      }
      data = { ...status, recoveryCodes: firstCodes };
    } else if (path === '/auth/totp/cancel' && method === 'POST') {
      writes.push({ path, body });
      data = status;
    } else if (path === '/auth/recovery-codes/regenerate' && method === 'POST') {
      writes.push({ path, body });
      status.recoveryCodesRemaining = 10;
      status.otherSessionsCount = 0;
      data = { ...status, recoveryCodes: nextCodes };
    } else if (path === '/auth/totp/disable' && method === 'POST') {
      writes.push({ path, body });
      status.totpEnabled = false;
      status.recoveryCodesRemaining = 0;
      status.otherSessionsCount = 0;
      data = status;
    } else if (
      (path === '/auth/password' || path === '/auth/sessions/revoke-others') &&
      method === 'POST'
    ) {
      writes.push({ path, body });
      if (path === '/auth/password' && passwordFailures.length) {
        const failure = passwordFailures.shift()!;
        await route.fulfill({
          status: failure.status,
          json: { error: { message: failure.message } },
        });
        return;
      }
      status.otherSessionsCount = 0;
      data = status;
    } else {
      unexpected.push(`${method} ${path}`);
      await route.fulfill({
        status: 404,
        json: { error: { message: '未配置的账户安全界面请求' } },
      });
      return;
    }
    await route.fulfill({ json: { data } });
  });
  return {
    writes,
    unexpected,
    status,
    get saved() {
      return saved;
    },
  };
}
async function openSecurity(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '内容', exact: true })).toBeVisible();
  if (await page.getByRole('button', { name: '打开导航', exact: true }).isVisible())
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('button', { name: '账户安全', exact: true }).click();
  await expect(page.getByRole('heading', { name: '账户安全', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '修改密码', exact: true })).toBeEnabled();
}
async function prove(dialog: Locator, code?: string) {
  await dialog.getByLabel('当前密码', { exact: true }).fill(currentPassword);
  if (code) await dialog.getByLabel('验证器验证码', { exact: true }).fill(code);
}
async function acknowledgeCodes(page: Page) {
  const dialog = page.getByRole('dialog', { name: '保存恢复码', exact: true });
  await dialog
    .getByRole('checkbox', { name: '我已将这组恢复码保存到安全的地方', exact: true })
    .check();
  await dialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test('修改密码关联确认错误，启用2FA时带验证证明并保持当前工作台', async ({ page }) => {
  const data = await fixture(page, { totpEnabled: true });
  await openSecurity(page);
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改密码', exact: true });
  await prove(dialog, '123456');
  await dialog.getByLabel('新密码', { exact: true }).fill('fixture-new-password');
  const confirm = dialog.getByLabel('确认新密码', { exact: true });
  await confirm.fill('fixture-wrong-confirm');
  await dialog.getByRole('button', { name: '修改密码', exact: true }).click();
  await expect(confirm).toHaveAttribute('aria-invalid', 'true');
  await expect(confirm).toBeFocused();
  expect(data.writes.filter((entry) => entry.path === '/auth/password')).toHaveLength(0);
  await confirm.fill('fixture-new-password');
  await dialog.getByRole('button', { name: '修改密码', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name: '账户安全', exact: true })).toBeVisible();
  expect(data.writes.find((entry) => entry.path === '/auth/password')?.body).toEqual({
    currentPassword,
    newPassword: 'fixture-new-password',
    code: '123456',
  });
  await expect(
    page.getByText('密码已更新，其他会话已退出，当前浏览器保持登录。', { exact: true }),
  ).toBeVisible();
  expect(data.unexpected).toEqual([]);
});

test('服务端密码和验证码错误关联输入，限流提示不标记输入无效', async ({ page }) => {
  const data = await fixture(page, {
    totpEnabled: true,
    passwordFailures: [
      { status: 400, message: '当前密码错误' },
      { status: 400, message: '验证码无效、已使用或已过期，或恢复码不可用' },
      { status: 429, message: '验证码尝试过于频繁，请稍后重试' },
    ],
  });
  await openSecurity(page);
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改密码', exact: true });
  const password = dialog.getByLabel('当前密码', { exact: true });
  const code = dialog.getByLabel('验证器验证码', { exact: true });
  await prove(dialog, '123456');
  await dialog.getByLabel('新密码', { exact: true }).fill('fixture-new-password');
  await dialog.getByLabel('确认新密码', { exact: true }).fill('fixture-new-password');
  await dialog.getByRole('button', { name: '修改密码', exact: true }).click();
  await expect(password).toHaveAttribute('aria-invalid', 'true');
  await expect(password).toBeFocused();
  await password.fill('fixture-correct-password');
  await code.fill('654321');
  await dialog.getByRole('button', { name: '修改密码', exact: true }).click();
  await expect(code).toHaveAttribute('aria-invalid', 'true');
  await expect(code).toBeFocused();
  await code.fill('123457');
  await dialog.getByRole('button', { name: '修改密码', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('验证码尝试过于频繁');
  await expect(password).not.toHaveAttribute('aria-invalid', 'true');
  await expect(code).not.toHaveAttribute('aria-invalid', 'true');
  expect(data.unexpected).toEqual([]);
});

test('其他会话改变2FA后重新登录刷新状态，敏感操作要求新的验证码', async ({ page }) => {
  const data = await fixture(page);
  await openSecurity(page);
  await expect(page.getByText('未启用', { exact: true })).toBeVisible();
  data.status.totpEnabled = true;
  data.status.recoveryCodesRemaining = 10;
  await page.evaluate(() => window.dispatchEvent(new Event('tattoo:unauthorized')));
  const login = page.getByRole('dialog', { name: '会话已过期，请重新登录', exact: true });
  await login.getByLabel('密码', { exact: true }).fill(currentPassword);
  await login.getByRole('button', { name: '登录', exact: true }).click();
  await login.getByLabel('验证器验证码', { exact: true }).fill('123456');
  await login.getByRole('button', { name: '验证并登录', exact: true }).click();
  await expect(login).not.toBeVisible();
  await expect(page.getByText('已启用', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: '修改密码', exact: true })
      .getByLabel('验证器验证码', { exact: true }),
  ).toBeVisible();
  expect(data.unexpected).toEqual([]);
});

test('扫码启用、手动密钥、恢复码单次展示与保存保护均可用且不写浏览器存储', async ({
  page,
}, testInfo) => {
  const data = await fixture(page);
  await openSecurity(page);
  const lightPreview = testInfo.outputPath('account-security-light.png');
  await page.screenshot({ path: lightPreview, fullPage: true });
  await testInfo.attach('account-security-light', { path: lightPreview, contentType: 'image/png' });
  await page.getByRole('button', { name: '设置双重验证', exact: true }).click();
  const setup = page.getByRole('dialog', { name: '设置双重验证', exact: true });
  await prove(setup);
  await setup.getByRole('button', { name: '继续设置', exact: true }).click();
  await expect(setup.getByLabel('验证器设置密钥', { exact: true })).toHaveText(secret);
  await expect(
    setup.getByRole('img', { name: '用于绑定 Tattoo 的验证器二维码', exact: true }),
  ).toHaveAttribute('src', /^data:image\/png;base64,/);
  await setup.getByLabel('验证器验证码', { exact: true }).fill('123456');
  await setup.getByRole('button', { name: '验证并启用', exact: true }).click();
  const recovery = page.getByRole('dialog', { name: '保存恢复码', exact: true });
  await expect(recovery.getByLabel('一次性恢复码', { exact: true })).toHaveValue(
    firstCodes.join('\n'),
  );
  await expect(recovery.getByRole('button', { name: '完成', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(recovery).toBeVisible();
  const protectedUnload = await page.evaluate(() => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(protectedUnload).toBe(true);
  const storage = await page.evaluate(() =>
    JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }),
  );
  expect(storage).not.toContain(secret);
  expect(storage).not.toContain(firstCodes[0]);
  expect(storage).not.toContain(currentPassword);
  const download = page.waitForEvent('download');
  await recovery.getByRole('button', { name: '下载恢复码', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('tattoo-recovery-codes.txt');
  await acknowledgeCodes(page);
  await expect(page.getByLabel('一次性恢复码', { exact: true })).toHaveCount(0);
  await expect(page.getByText('已启用', { exact: true })).toBeVisible();
  expect(data.writes.find((entry) => entry.path === '/auth/totp/enable')?.body).toEqual({
    setupId,
    code: '123456',
  });
  expect(data.unexpected).toEqual([]);
});

test('取消设置携带setupId且不会启用，取消关闭清空敏感输入', async ({ page }) => {
  const data = await fixture(page);
  await openSecurity(page);
  await page.getByRole('button', { name: '设置双重验证', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置双重验证', exact: true });
  await prove(dialog);
  await dialog.getByRole('button', { name: '继续设置', exact: true }).click();
  await expect(dialog.getByLabel('验证器设置密钥', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(data.writes.find((entry) => entry.path === '/auth/totp/cancel')?.body).toEqual({
    setupId,
  });
  expect(data.writes.filter((entry) => entry.path === '/auth/totp/enable')).toHaveLength(0);
  await page.getByRole('button', { name: '设置双重验证', exact: true }).click();
  await expect(dialog.getByLabel('当前密码', { exact: true })).toHaveValue('');
  expect(data.unexpected).toEqual([]);
});

test('会话失效立即移除恢复码Portal，重新验证后可生成新码', async ({ page }) => {
  const data = await fixture(page);
  await openSecurity(page);
  await page.getByRole('button', { name: '设置双重验证', exact: true }).click();
  const setup = page.getByRole('dialog', { name: '设置双重验证', exact: true });
  await prove(setup);
  await setup.getByRole('button', { name: '继续设置', exact: true }).click();
  await setup.getByLabel('验证器验证码', { exact: true }).fill('123456');
  await setup.getByRole('button', { name: '验证并启用', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '保存恢复码', exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('tattoo:unauthorized')));
  await expect(page.locator('#security-recovery-codes')).toHaveCount(0);
  expect(await page.content()).not.toContain(firstCodes[0]);
  const login = page.getByRole('dialog', { name: '会话已过期，请重新登录', exact: true });
  await login.getByLabel('密码', { exact: true }).fill(currentPassword);
  await login.getByRole('button', { name: '登录', exact: true }).click();
  await login.getByLabel('验证器验证码', { exact: true }).fill('654321');
  await login.getByRole('button', { name: '验证并登录', exact: true }).click();
  await expect(login).not.toBeVisible();
  await expect(
    page.getByText('会话已过期，敏感设置已清除。若恢复码尚未保存，重新登录后可重新生成一组。', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '重新生成恢复码', exact: true })).toBeEnabled();
  expect(data.unexpected).toEqual([]);
});

test('启用响应丢失不重复提交，核对状态后可主动重新生成恢复码', async ({ page }) => {
  const data = await fixture(page, { loseEnableResponse: true });
  await openSecurity(page);
  await page.getByRole('button', { name: '设置双重验证', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '设置双重验证', exact: true });
  await prove(dialog);
  await dialog.getByRole('button', { name: '继续设置', exact: true }).click();
  await dialog.getByLabel('验证器验证码', { exact: true }).fill('123456');
  await dialog.getByRole('button', { name: '验证并启用', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('未收到完整结果');
  expect(data.writes.filter((entry) => entry.path === '/auth/totp/enable')).toHaveLength(1);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByText('已启用', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '刷新安全状态', exact: true }).click();
  await page.getByRole('button', { name: '重新生成恢复码', exact: true }).click();
  const regenerate = page.getByRole('dialog', { name: '重新生成恢复码', exact: true });
  await prove(regenerate, '654321');
  await regenerate.getByRole('button', { name: '重新生成恢复码', exact: true }).click();
  await expect(
    page
      .getByRole('dialog', { name: '保存恢复码', exact: true })
      .getByLabel('一次性恢复码', { exact: true }),
  ).toHaveValue(nextCodes.join('\n'));
  await acknowledgeCodes(page);
  expect(data.writes.filter((entry) => entry.path === '/auth/totp/enable')).toHaveLength(1);
  expect(data.unexpected).toEqual([]);
});

test('恢复码可作为敏感操作证明，退出其他会话后当前页面仍可用', async ({ page }) => {
  const data = await fixture(page, { totpEnabled: true });
  await openSecurity(page);
  await page.getByRole('button', { name: '退出其他会话', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '退出其他会话', exact: true });
  await prove(dialog);
  await dialog.getByRole('button', { name: '使用恢复码', exact: true }).click();
  await dialog.getByLabel('一次性恢复码', { exact: true }).fill(firstCodes[0]!);
  await dialog.getByRole('button', { name: '退出其他会话', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('当前浏览器以外有 0 个有效会话。', { exact: true })).toBeVisible();
  expect(data.writes.find((entry) => entry.path === '/auth/sessions/revoke-others')?.body).toEqual({
    currentPassword,
    code: firstCodes[0]!.replace(/-/g, ''),
  });
  await page.getByRole('button', { name: '关闭双重验证', exact: true }).click();
  const disable = page.getByRole('dialog', { name: '关闭双重验证', exact: true });
  await prove(disable, '654321');
  await disable.getByRole('button', { name: '关闭双重验证', exact: true }).click();
  await expect(page.getByText('未启用', { exact: true })).toBeVisible();
  expect(data.unexpected).toEqual([]);
});

test('登录错验证码保留第二步，挑战失效返回密码，恢复码登录可用', async ({ page }) => {
  const data = await fixture(page, { loggedIn: false, totpEnabled: true });
  await page.goto('/');
  await page.getByLabel('管理员邮箱', { exact: true }).fill('demo@example.com');
  await page.getByLabel('密码', { exact: true }).fill(currentPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('验证器验证码', { exact: true }).fill('000000');
  await page.getByRole('button', { name: '验证并登录', exact: true }).click();
  await expect(page.getByLabel('验证器验证码', { exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('验证码错误');
  await page.getByLabel('验证器验证码', { exact: true }).fill('111111');
  await page.getByRole('button', { name: '验证并登录', exact: true }).click();
  await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
  await page.getByLabel('密码', { exact: true }).fill(currentPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '使用恢复码', exact: true }).click();
  await page.getByLabel('一次性恢复码', { exact: true }).fill(firstCodes[0]!);
  await page.getByRole('button', { name: '验证并登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '内容', exact: true })).toBeVisible();
  expect(data.writes.filter((entry) => entry.path === '/auth/login')).toHaveLength(2);
  expect(data.writes.filter((entry) => entry.path === '/auth/login/verify').at(-1)?.body).toEqual({
    code: firstCodes[0]!.replace(/-/g, ''),
  });
  expect(data.unexpected).toEqual([]);
});

for (const delivery of ['cookie-set', 'cookie-lost'] as const) {
  test(`验证码响应丢失时只读取会话，不重复验证（${delivery}）`, async ({ page }) => {
    const data = await fixture(page, {
      loggedIn: false,
      totpEnabled: true,
      loseVerifyResponse: delivery,
    });
    await page.goto('/');
    await page.getByLabel('管理员邮箱', { exact: true }).fill('demo@example.com');
    await page.getByLabel('密码', { exact: true }).fill(currentPassword);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByLabel('验证器验证码', { exact: true }).fill('123456');
    await page.getByRole('button', { name: '验证并登录', exact: true }).click();
    await page.getByRole('button', { name: '重新读取登录状态', exact: true }).click();
    if (delivery === 'cookie-set') {
      await expect(page.getByRole('heading', { name: '内容', exact: true })).toBeVisible();
    } else {
      await expect(page.getByLabel('密码', { exact: true })).toBeVisible();
      await expect(page.getByLabel('验证器验证码', { exact: true })).toHaveCount(0);
    }
    expect(data.writes.filter((entry) => entry.path === '/auth/login/verify')).toHaveLength(1);
    expect(data.unexpected).toEqual([]);
  });
}

test('会话过期后嵌入式2FA重登保留未保存文章', async ({ page }) => {
  const data = await fixture(page, { totpEnabled: true, expireFirstSave: true });
  await page.goto('/');
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('重新验证后仍在的草稿');
  await page.getByLabel('摘要', { exact: true }).fill('未保存的摘要也要保留。');
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  const login = page.getByRole('dialog', { name: '会话已过期，请重新登录', exact: true });
  await login.getByLabel('密码', { exact: true }).fill(currentPassword);
  await login.getByRole('button', { name: '登录', exact: true }).click();
  await login.getByLabel('验证器验证码', { exact: true }).fill('123456');
  await login.getByRole('button', { name: '验证并登录', exact: true }).click();
  await expect(login).not.toBeVisible();
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue('重新验证后仍在的草稿');
  await expect(page.getByLabel('摘要', { exact: true })).toHaveValue('未保存的摘要也要保留。');
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存 · 修订 v1');
  expect(data.saved).toMatchObject({
    title: '重新验证后仍在的草稿',
    digest: '未保存的摘要也要保留。',
  });
  expect(data.unexpected).toEqual([]);
});

test('390px深色下账户安全导航、验证码和确认操作可达', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => localStorage.setItem('tattoo:theme', 'dark'));
  const data = await fixture(page, { totpEnabled: true });
  await openSecurity(page);
  const mobilePreview = testInfo.outputPath('account-security-dark-mobile.png');
  await page.screenshot({ path: mobilePreview, fullPage: true });
  await testInfo.attach('account-security-dark-mobile', {
    path: mobilePreview,
    contentType: 'image/png',
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: '修改密码', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '修改密码', exact: true });
  await prove(dialog, '123456');
  await dialog.getByLabel('新密码', { exact: true }).fill('fixture-new-password');
  await dialog.getByLabel('确认新密码', { exact: true }).fill('fixture-new-password');
  const noOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
  expect(noOverflow).toBe(true);
  await expect(dialog.getByRole('button', { name: '修改密码', exact: true })).toBeInViewport();
  await dialog.getByRole('button', { name: '修改密码', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(data.unexpected).toEqual([]);
});
