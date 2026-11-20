import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { expect, test, type Page, type Response } from '@playwright/test';
import type { Article } from '@tattoo/contracts';

test.skip(
  process.env.TATTOO_E2E_TEST_MODE !== '1' ||
    !process.env.TATTOO_E2E_EMAIL ||
    !process.env.TATTOO_E2E_PASSWORD,
  '需要隔离的真实前后端与显式 E2E 测试配置',
);

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('管理员邮箱', { exact: true }).fill(process.env.TATTOO_E2E_EMAIL!);
  await page.getByLabel('密码', { exact: true }).fill(process.env.TATTOO_E2E_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '内容', exact: true })).toBeVisible();
}

async function save(page: Page): Promise<Article> {
  const response = page.waitForResponse(
    (value: Response) =>
      /\/api\/v1\/articles(?:\/[0-9a-f-]+)?$/.test(value.url()) &&
      ['POST', 'PATCH'].includes(value.request().method()),
  );
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  const result = await response;
  expect(result.ok(), await result.text()).toBe(true);
  const article = (await result.json()).data as Article;
  await expect(page.getByRole('status')).toHaveText(`已保存 · 修订 v${article.version}`);
  const expectedVersion = result.request().postDataJSON().expectedVersion;
  await expect(page.getByRole('alert')).toContainText(
    expectedVersion === article.version
      ? `内容未变化，仍为修订 v${article.version}。`
      : `已保存为修订 v${article.version}。`,
  );
  await expect(page.getByRole('button', { name: '保存文章', exact: true })).toBeEnabled();
  return article;
}

function writeHeaders(page: Page) {
  return { Origin: new URL(page.url()).origin, 'X-Tattoo-Request': '1' };
}

test('不完整稿件可保存，图文刷新一致，历史不可变且预览对应明确修订', async ({ page }, testInfo) => {
  await login(page);
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  const initial = await save(page);
  expect(initial.title).toBe('未命名文章');
  expect(initial.version).toBe(1);
  await page.getByRole('button', { name: '微信预览', exact: true }).click();
  let preview = page.getByRole('dialog').filter({ hasText: '微信预览 · 修订 v1' });
  await expect(preview.getByText(/尚未设置封面/)).toBeVisible();
  await expect(preview.getByText(/正文为空/)).toBeVisible();
  await preview.getByRole('button', { name: 'Close', exact: true }).click();

  const title = `P3图文-${randomUUID().slice(0, 8)}`;
  await page.getByLabel('标题', { exact: true }).fill(title);
  await page.getByLabel('作者', { exact: true }).fill('Tattoo 编辑');
  await page.getByLabel('摘要', { exact: true }).fill('图文修订与历史保留验证');
  await page.getByLabel('原文链接', { exact: true }).fill('https://example.com/original');
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  await body.fill('一段值得保存的文字。<script>alert(1)</script>');
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  await body.press('End');
  await body.pressSequentially(' Strong');
  await page.getByRole('button', { name: '加粗', exact: true }).click();
  await body.press('Enter');
  await page.getByRole('button', { name: '二级标题', exact: true }).click();
  await body.pressSequentially('Chapter');
  await body.press('Enter');
  await page.getByRole('button', { name: '正文段落', exact: true }).click();
  await page.getByRole('button', { name: '有序列表', exact: true }).click();
  await body.pressSequentially('First item');
  await body.press('Enter');
  await body.press('Enter');
  await body.evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData(
      'text/html',
      '<p><strong>支持的格式<br>继续加粗</strong> <a href="https://example.com/body">正文链接</a></p>',
    );
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
    );
  });
  const picture = await sharp({
    create: { width: 120, height: 80, channels: 3, background: '#a87549' },
  })
    .png()
    .toBuffer();
  const image = { name: 'article-image.png', mimeType: 'image/png', buffer: picture };
  await page.getByTestId('body-image-input').setInputFiles(image);
  await expect(body.getByRole('img', { name: 'article-image.png', exact: true })).toBeVisible();
  await page.getByTestId('cover-image-input').setInputFiles(image);
  await expect(page.getByAltText('文章封面', { exact: true })).toBeVisible();
  const changed = await save(page);
  expect(changed.version).toBe(2);
  expect(changed.coverId).toBeTruthy();
  expect(JSON.stringify(changed.document)).not.toContain('"src"');
  const unchanged = await save(page);
  expect(unchanged.revisionId).toBe(changed.revisionId);

  await page.reload();
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue(title);
  await expect(page.getByLabel('作者', { exact: true })).toHaveValue('Tattoo 编辑');
  await expect(page.getByLabel('摘要', { exact: true })).toHaveValue('图文修订与历史保留验证');
  await expect(body).toContainText('一段值得保存的文字。');
  await expect(body.locator('h2')).toHaveText('Chapter');
  await expect(body.locator('ol')).toContainText('First item');
  await expect(body.locator('a')).toHaveAttribute('href', 'https://example.com/body');
  await expect(body.getByRole('img')).toHaveCount(1);
  await page.getByRole('button', { name: '微信预览', exact: true }).click();
  preview = page.getByRole('dialog').filter({ hasText: '微信预览 · 修订 v2' });
  await expect(preview.getByRole('heading', { name: title, exact: true })).toBeVisible();
  const frame = page.frameLocator('iframe[title="微信正文预览"]');
  await expect(frame.locator('body')).toContainText('<script>alert(1)</script>');
  await expect(frame.locator('script')).toHaveCount(0);
  await expect(frame.locator('body')).toContainText('[https://example.com/body]');
  await expect(frame.locator('a')).toHaveCount(0);
  await expect(frame.locator('img')).toBeVisible();
  await expect
    .poll(() => frame.locator('img').evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBe(120);
  await page.screenshot({ path: testInfo.outputPath('p3-preview-desktop.png'), fullPage: true });
  await preview.getByRole('button', { name: 'Close', exact: true }).click();

  await page.getByRole('button', { name: '修订历史', exact: true }).click();
  await page.getByRole('button', { name: '查看 v1', exact: true }).click();
  const historical = page.getByRole('dialog').filter({ hasText: '历史修订 v1 · 只读' });
  await expect(historical.getByRole('heading', { name: '未命名文章', exact: true })).toBeVisible();
  await expect(historical.getByText(/正文为空/)).toBeVisible();
  await historical.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(historical).not.toBeVisible();
  const history = page
    .getByRole('dialog')
    .filter({ hasText: '查看已保存快照。后续编辑不会覆盖这些内容。' });
  await expect(history).toBeVisible();
  await history.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue(title);
});

test('其他窗口保存后本地保存冲突，保留未保存内容直到明确重新加载', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill(`P3冲突-${randomUUID().slice(0, 8)}`);
  const article = await save(page);
  await page.getByLabel('标题', { exact: true }).fill('本地仍需保留的修改');
  const { id, version, revisionId: _revision, updatedAt: _updated, ...fields } = article;
  const remote = await page.request.patch(`/api/v1/articles/${id}`, {
    headers: writeHeaders(page),
    data: { ...fields, title: '另一窗口已保存的标题', expectedVersion: version },
  });
  expect(remote.ok()).toBe(true);
  const rejected = page.waitForResponse(
    (value) =>
      value.url().endsWith(`/api/v1/articles/${id}`) && value.request().method() === 'PATCH',
  );
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  expect((await rejected).status()).toBe(409);
  await expect(page.getByRole('alert')).toContainText('你的本地编辑仍保留');
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue('本地仍需保留的修改');
  await page.getByRole('button', { name: '微信预览', exact: true }).click();
  await expect(page.getByText('当前有未保存修改，请先保存后再预览当前文章。')).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '加载最新修订', exact: true }).click();
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue('另一窗口已保存的标题');
});

test('外链图片粘贴明确拒绝，未保存的导航和浏览器刷新可取消', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('尚未保存的想法');
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  await body.fill('保留这段文字');
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('https://remote-image.invalid'))
      externalRequests.push(request.url());
  });
  await body.evaluate((element) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData(
      'text/html',
      '<p>外部段落<img src="https://remote-image.invalid/photo.png"></p>',
    );
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.getByRole('alert')).toContainText('外链图片');
  await expect(body).toHaveText('保留这段文字');
  expect(externalRequests).toEqual([]);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '公众号账号', exact: true }).click();
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue('尚未保存的想法');
  const reloadDialog = page.waitForEvent('dialog');
  const reload = page.reload({ waitUntil: 'commit', timeout: 5000 }).catch(() => null);
  const dialog = await reloadDialog;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
  await reload;
  await expect(body).toHaveText('保留这段文字');
  page.once('dialog', (confirmation) => confirmation.accept());
  await page.getByRole('button', { name: '公众号账号', exact: true }).click();
  await expect(page.getByRole('heading', { name: '公众号账号', exact: true })).toBeVisible();
});

test('写作期间会话过期后重新登录，内存中的未保存稿件仍可保存', async ({ page, context }) => {
  await login(page);
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  const title = `P3会话恢复-${randomUUID().slice(0, 8)}`;
  await page.getByLabel('标题', { exact: true }).fill(title);
  await page
    .getByRole('textbox', { name: '文章正文', exact: true })
    .fill('登录恢复之后仍然保留的正文。');
  await context.clearCookies({ name: 'tattoo_session' });
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: '会话已过期，请重新登录', exact: true }),
  ).toBeVisible();
  await page.getByLabel('管理员邮箱', { exact: true }).fill(process.env.TATTOO_E2E_EMAIL!);
  await page.getByLabel('密码', { exact: true }).fill(process.env.TATTOO_E2E_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue(title);
  await expect(page.getByRole('textbox', { name: '文章正文', exact: true })).toHaveText(
    '登录恢复之后仍然保留的正文。',
  );
  const saved = await save(page);
  expect(saved.title).toBe(title);
  expect(saved.version).toBe(1);
});

test.describe('窄屏文章编辑', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('表单和排版按钮可达，保存与预览没有页面横向溢出', async ({ page }, testInfo) => {
    await login(page);
    await page.getByRole('button', { name: '新建文章', exact: true }).click();
    await page.getByLabel('标题', { exact: true }).fill('手机宽度的创作');
    await page.getByRole('textbox', { name: '文章正文', exact: true }).fill('可以从窄屏继续写作。');
    await page.getByRole('button', { name: '下划线', exact: true }).focus();
    await expect(page.getByRole('button', { name: '下划线', exact: true })).toBeFocused();
    await save(page);
    const size = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(size.scroll).toBeLessThanOrEqual(size.width);
    await page.screenshot({ path: testInfo.outputPath('p3-editor-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: '微信预览', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const previewSize = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(previewSize.scroll).toBeLessThanOrEqual(previewSize.width);
    await page.screenshot({ path: testInfo.outputPath('p3-preview-mobile.png'), fullPage: true });
  });
});
