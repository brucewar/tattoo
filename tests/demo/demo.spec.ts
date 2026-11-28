import { expect, test } from '@playwright/test';

test('demo works below the Pages base without a backend', async ({ page }) => {
  const apiRequests: string[] = [];
  const errors: string[] = [];
  const failedResponses: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failedResponses.push(response.url());
  });
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.includes('/api/')) apiRequests.push(request.url());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('./');
  await expect(page.getByText('在线演示 ·', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: /把一个主题，变成一篇有封面的文章/ }).click();
  await expect(page.getByRole('img', { name: '文章封面', exact: true })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('demo-editor.png'), fullPage: true });
  await expect(page.getByRole('textbox', { name: '标题', exact: true })).toHaveValue(
    '把一个主题，变成一篇有封面的文章',
  );
  await page.getByRole('textbox', { name: '标题', exact: true }).fill('我的演示文章');
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  await expect(page.getByText('已保存为修订 v2。')).toBeVisible();
  await page.getByRole('button', { name: '微信预览', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('我的演示文章');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.getByRole('button', { name: /我的演示文章/ }).click();
  await page.getByRole('button', { name: '修订历史', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('把一个主题，变成一篇有封面的文章');
  await page.keyboard.press('Escape');
  for (const label of ['资料', '投递记录', '公众号账号', '模型配置', '账户安全']) {
    await page
      .getByRole('navigation', { name: '工作台导航' })
      .getByRole('button', { name: label, exact: true })
      .click();
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '打开导航' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('demo-mobile.png'), fullPage: true });
  expect(apiRequests).toEqual([]);
  expect(errors).toEqual([]);
  expect(failedResponses).toEqual([]);
});

test('topic creation, local image persistence and reset work offline', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('data:')) requests.push(request.url());
  });
  await page.goto('./');
  await page.getByRole('button', { name: '主题创作', exact: true }).click();
  await page.getByPlaceholder('例如：普通人如何把 AI 变成自己的学习助手').fill('周末的写作计划');
  await page.getByRole('button', { name: '生成文章和封面', exact: true }).click();
  await page.getByRole('button', { name: '打开成稿编辑', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '标题', exact: true })).toHaveValue(
    '周末的写作计划（演示示例）',
  );
  await page
    .locator('input[type=file]')
    .nth(1)
    .setInputFiles({
      name: 'demo.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1kAAAAASUVORK5CYII=',
        'base64',
      ),
    });
  await expect(page.getByText('封面已上传，请保存文章。')).toBeVisible();
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  await expect(page.getByText('已保存为修订 v2。')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /周末的写作计划（演示示例）/ }).click();
  await expect(page.getByRole('img', { name: '文章封面', exact: true })).toHaveAttribute(
    'src',
    /^data:image\/png;base64,/,
  );
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '重置演示', exact: true }).click();
  await expect(
    page.getByRole('button', { name: /把一个主题，变成一篇有封面的文章/ }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /周末的写作计划（演示示例）/ })).toHaveCount(0);
  expect(requests.every((url) => url.startsWith('http://127.0.0.1:4173/'))).toBe(true);
  expect(requests.some((url) => url.includes('/api/'))).toBe(false);
});
