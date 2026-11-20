import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { expect, test, type Page } from '@playwright/test';

// These tests must target the real Tattoo API wired to an isolated mock WeChat server.
// They never intercept browser requests or use a real WeChat credential.
test.skip(
  process.env.TATTOO_E2E_TEST_MODE !== '1' ||
    !process.env.TATTOO_E2E_EMAIL ||
    !process.env.TATTOO_E2E_PASSWORD,
  '需要隔离的真实前后端、模拟微信服务和显式 E2E 测试配置',
);

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('管理员邮箱', { exact: true }).fill(process.env.TATTOO_E2E_EMAIL!);
  await page.getByLabel('密码', { exact: true }).fill(process.env.TATTOO_E2E_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '公众号账号', exact: true })).toBeVisible();
}

test('错误登录被拒绝，正确登录后的会话 Cookie 受保护，退出立即失效', async ({ page, context }) => {
  await page.goto('/');
  await page.getByLabel('管理员邮箱', { exact: true }).fill(process.env.TATTOO_E2E_EMAIL!);
  await page.getByLabel('密码', { exact: true }).fill('wrong-e2e-password');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
  await page.getByLabel('密码', { exact: true }).fill(process.env.TATTOO_E2E_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '公众号账号', exact: true })).toBeVisible();
  const cookie = (await context.cookies()).find((value) => value.name === 'tattoo_session');
  expect(cookie?.httpOnly).toBe(true);
  expect(['Strict', 'Lax']).toContain(cookie?.sameSite);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '登录工作台', exact: true })).toBeVisible();
  expect((await page.request.get('/api/v1/auth/me')).status()).toBe(401);
});

test('新增公众号、只读验证、明确确认后上传封面并完成模拟草稿投递', async ({ page }, testInfo) => {
  await login(page);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const name = `浏览器测试-${suffix.slice(0, 6)}`;
  const secret = `e2e-only-secret-${suffix}`;
  await page.getByRole('button', { name: '新增公众号', exact: true }).first().click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('账号名称', { exact: true }).fill(name);
  await editor.getByLabel('AppID', { exact: true }).fill(`wx${suffix}`);
  await editor.getByLabel('AppSecret', { exact: true }).fill(secret);
  await editor.getByRole('button', { name: '保存公众号', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  const accounts = await page.request.get('/api/v1/accounts');
  expect(await accounts.text()).not.toContain(secret);
  await page.getByRole('button', { name: '执行只读验证', exact: true }).click();
  await expect(page.getByText(/只读验证通过/)).toBeVisible();
  await expect(page.getByText('已验证可用', { exact: true })).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('p2-accounts-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '创建测试草稿', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const create = dialog.getByRole('button', { name: '创建测试草稿', exact: true });
  await expect(create).toBeDisabled();
  const image = await sharp({
    create: { width: 320, height: 180, channels: 3, background: '#35634e' },
  })
    .png()
    .toBuffer();
  await dialog
    .getByLabel('测试封面', { exact: true })
    .setInputFiles({ name: 'e2e-cover.png', mimeType: 'image/png', buffer: image });
  await expect(dialog.getByAltText('所选测试封面')).toBeVisible();
  await expect(create).toBeDisabled();
  await dialog
    .getByRole('checkbox', { name: '我了解会上传封面并创建一篇测试草稿，同意继续', exact: true })
    .check();
  await create.click();
  await expect(dialog.getByText('微信接口已返回草稿创建成功', { exact: true })).toBeVisible({
    timeout: 45000,
  });
  await expect(dialog.getByText('远程草稿 ID', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '投递记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '投递记录', exact: true })).toBeVisible();
  await expect(page.getByRole('button').filter({ hasText: name }).first()).toBeVisible();
});

test.describe('窄屏', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('登录与账号配置在手机宽度可操作且没有横向溢出', async ({ page }, testInfo) => {
    await login(page);
    await page.getByRole('button', { name: '新增公众号', exact: true }).first().click();
    await expect(page.getByRole('dialog').getByLabel('账号名称', { exact: true })).toBeVisible();
    const size = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(size.scroll).toBeLessThanOrEqual(size.width);
    await page.screenshot({
      path: testInfo.outputPath('p2-account-form-mobile.png'),
      fullPage: true,
    });
    await page.getByRole('dialog').getByRole('button', { name: '取消', exact: true }).click();
    await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
  });
});
