import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Article } from '@tattoo/contracts';

test.skip(
  process.env.TATTOO_E2E_TEST_MODE !== '1' || !process.env.TATTOO_E2E_WECHAT_CONTROL_URL,
  '需要隔离的真实 API、Worker、前端与模拟微信',
);

const confirmation = '我确认将此修订上传到所选公众号，创建微信素材与一篇新草稿';
type Audit = {
  calls: { cover: number; body: number; draft: number };
  draftPayloads: {
    articles: {
      title: string;
      author: string;
      digest: string;
      content_source_url: string;
      content: string;
      thumb_media_id: string;
    }[];
  }[];
};

async function audit(): Promise<Audit> {
  const response = await fetch(`${process.env.TATTOO_E2E_WECHAT_CONTROL_URL}/__tattoo_audit`);
  expect(response.ok).toBe(true);
  return response.json() as Promise<Audit>;
}

function headers(page: Page) {
  return { Origin: new URL(page.url()).origin, 'X-Tattoo-Request': '1' };
}

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('管理员邮箱', { exact: true }).fill(process.env.TATTOO_E2E_EMAIL!);
  await page.getByLabel('密码', { exact: true }).fill(process.env.TATTOO_E2E_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '内容', exact: true })).toBeVisible();
}

async function account(page: Page, suffix: string) {
  const unique = randomUUID().replaceAll('-', '').slice(0, 16);
  const name = `P4公众号-${suffix}-${unique.slice(0, 5)}`;
  const response = await page.request.post('/api/v1/accounts', {
    headers: headers(page),
    data: { name, appId: `wx${unique}`, appSecret: `p4-fake-secret-${unique}` },
  });
  expect(response.ok()).toBe(true);
  return (await response.json()).data as { id: string; name: string };
}

async function save(page: Page): Promise<Article> {
  const response = page.waitForResponse(
    (value) =>
      /\/api\/v1\/articles(?:\/[0-9a-f-]+)?$/.test(value.url()) &&
      ['POST', 'PATCH'].includes(value.request().method()),
  );
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  const result = await response;
  expect(result.ok(), await result.text()).toBe(true);
  const article = (await result.json()).data as Article;
  await expect(page.getByRole('status')).toHaveText(`已保存 · 修订 v${article.version}`);
  await expect(page.getByRole('alert')).toContainText(`已保存为修订 v${article.version}。`);
  await expect(page.getByRole('button', { name: '保存文章', exact: true })).toBeEnabled();
  return article;
}

async function readyArticle(page: Page) {
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  const title = `P4图文-${randomUUID().slice(0, 8)}`;
  await page.getByLabel('标题', { exact: true }).fill(title);
  await page.getByLabel('作者', { exact: true }).fill('Tattoo 编辑');
  await page.getByLabel('摘要', { exact: true }).fill('普通文章的真实前后端投递验证');
  await page.getByLabel('原文链接', { exact: true }).fill('https://example.com/p4-source');
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  await body.fill('这段正文属于明确保存的修订。');
  const image = await sharp({
    create: { width: 240, height: 160, channels: 3, background: '#746d3c' },
  })
    .png()
    .toBuffer();
  const input = { name: 'p4-article.png', mimeType: 'image/png', buffer: image };
  await page.getByTestId('body-image-input').setInputFiles(input);
  await expect(body.getByRole('img', { name: 'p4-article.png', exact: true })).toBeVisible();
  await page.getByTestId('cover-image-input').setInputFiles(input);
  await expect(page.getByAltText('文章封面', { exact: true })).toBeVisible();
  return save(page);
}

async function selectAccount(page: Page, name: string) {
  const dialog = page.getByRole('dialog', { name: '存入微信草稿', exact: true });
  await dialog.getByRole('combobox', { name: '目标公众号', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
  await expect(dialog.getByText('已保存修订通过本地投递检查', { exact: true })).toBeVisible();
  return dialog;
}

async function confirmAndSucceed(dialog: Locator, page: Page) {
  const submit = dialog.getByRole('button', { name: '确认存入微信草稿', exact: true });
  await expect(submit).toBeDisabled();
  await dialog.getByRole('checkbox', { name: confirmation, exact: true }).check();
  await expect(submit).toBeEnabled();
  const queued = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/deliveries') && response.request().method() === 'POST',
  );
  await submit.click();
  const response = await queued;
  expect(response.ok()).toBe(true);
  const record = (await response.json()).data as { id: string };
  const detail = page.getByRole('dialog', { name: '文章投递详情', exact: true });
  await expect(detail.getByText('微信接口已返回草稿创建成功', { exact: true })).toBeVisible({
    timeout: 45000,
  });
  return { id: record.id, detail };
}

test('明确账号与修订后投递，已有任务不重建，同一素材跨用途和账号分别上传', async ({
  page,
}, testInfo) => {
  await login(page);
  const first = await account(page, '一');
  const second = await account(page, '二');
  const article = await readyArticle(page);
  const before = await audit();
  await page.getByLabel('标题', { exact: true }).fill('尚未保存的标题');
  await page.getByRole('button', { name: '存入微信草稿', exact: true }).click();
  await expect(
    page.getByText('当前有未保存修改，请先保存后再存入微信草稿。', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('标题', { exact: true }).fill(article.title);
  await page.getByRole('button', { name: '存入微信草稿', exact: true }).click();
  let dialog = await selectAccount(page, first.name);
  await expect(dialog.getByText(article.title, { exact: true })).toBeVisible();
  await expect(dialog.getByText(`v${article.version}`, { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('p4-confirm-desktop.png'), fullPage: true });
  const created = await confirmAndSucceed(dialog, page);
  await created.detail.getByRole('button', { name: '选择其他公众号或新修订', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '存入微信草稿', exact: true });
  await dialog.getByRole('combobox', { name: '目标公众号', exact: true }).click();
  await page.getByRole('option', { name: first.name, exact: true }).click();
  await expect(dialog.getByRole('button', { name: '查看已有投递', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '确认存入微信草稿', exact: true })).toHaveCount(
    0,
  );
  await dialog.getByRole('button', { name: '查看已有投递', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '文章投递详情', exact: true });
  await expect(detail.getByText('微信接口已返回草稿创建成功', { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '选择其他公众号或新修订', exact: true }).click();
  dialog = await selectAccount(page, second.name);
  await confirmAndSucceed(dialog, page);
  const duplicate = await page.request.post('/api/v1/deliveries', {
    headers: headers(page),
    data: { revisionId: article.revisionId, accountId: first.id, confirmed: true },
  });
  expect(duplicate.ok()).toBe(true);
  expect((await duplicate.json()).data.id).toBe(created.id);
  const after = await audit();
  expect(after.calls.draft - before.calls.draft).toBe(2);
  expect(after.calls.cover - before.calls.cover).toBe(2);
  expect(after.calls.body - before.calls.body).toBe(2);
  const payloads = after.draftPayloads.filter(
    (payload) => payload.articles[0]?.title === article.title,
  );
  expect(payloads).toHaveLength(2);
  for (const payload of payloads) {
    expect(payload.articles[0]).toMatchObject({
      author: 'Tattoo 编辑',
      digest: '普通文章的真实前后端投递验证',
      content_source_url: 'https://example.com/p4-source',
    });
    expect(payload.articles[0]!.content).toContain('https://mmbiz.qpic.cn/');
    expect(payload.articles[0]!.content).not.toContain('/api/v1/assets/');
  }
  expect(payloads[0]!.articles[0]!.thumb_media_id).not.toBe(
    payloads[1]!.articles[0]!.thumb_media_id,
  );
  expect(payloads[0]!.articles[0]!.content).not.toBe(payloads[1]!.articles[0]!.content);
  await page.screenshot({ path: testInfo.outputPath('p4-success-desktop.png'), fullPage: true });
});

test('新增草稿连接中断显示待核对，查看原任务不会自动重发', async ({ page }) => {
  await login(page);
  const target = await account(page, '待核对');
  const article = await readyArticle(page);
  await page.getByRole('button', { name: '存入微信草稿', exact: true }).click();
  const dialog = await selectAccount(page, target.name);
  const control = await fetch(`${process.env.TATTOO_E2E_WECHAT_CONTROL_URL}/__tattoo_control`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nextDraft: 'disconnect' }),
  });
  expect(control.ok).toBe(true);
  await dialog.getByRole('checkbox', { name: confirmation, exact: true }).check();
  await dialog.getByRole('button', { name: '确认存入微信草稿', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '文章投递详情', exact: true });
  await expect(detail.getByText('结果待核对', { exact: true }).first()).toBeVisible({
    timeout: 45000,
  });
  await detail.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '查看本次投递', exact: true }).click();
  await expect(detail.getByText('结果待核对', { exact: true }).first()).toBeVisible();
  await page.waitForTimeout(2500);
  const result = await audit();
  expect(
    result.draftPayloads.filter((payload) => payload.articles[0]?.title === article.title),
  ).toHaveLength(1);
});

test('提交响应迟到时锁定原公众号，预检发现已有任务也不能切换目标', async ({ page }) => {
  await login(page);
  const first = await account(page, '慢响应');
  const second = await account(page, '下一目标');
  const article = await readyArticle(page);
  let releasePost!: () => void;
  let notifyPersisted!: () => void;
  const postHeld = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  const persisted = new Promise<void>((resolve) => {
    notifyPersisted = resolve;
  });
  let submitting = false;
  // Delay only transport: every response still comes from the real API and database.
  await page.route('**/api/v1/deliveries', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    expect(response.ok()).toBe(true);
    notifyPersisted();
    await postHeld;
    await route.fulfill({ response });
  });
  await page.route('**/api/v1/deliveries/check', async (route) => {
    if (submitting) await persisted;
    const response = await route.fetch();
    await route.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: '存入微信草稿', exact: true }).click();
    const dialog = await selectAccount(page, first.name);
    await dialog.getByRole('checkbox', { name: confirmation, exact: true }).check();
    submitting = true;
    await dialog.getByRole('button', { name: '确认存入微信草稿', exact: true }).click();
    const detail = page.getByRole('dialog', { name: '文章投递详情', exact: true });
    await expect(detail).toBeVisible();
    await expect(detail.getByLabel('本次投递目标')).toContainText(first.name);
    await expect(
      detail.getByRole('button', { name: '选择其他公众号或新修订', exact: true }),
    ).toBeDisabled();
    await expect(detail.getByRole('button', { name: '关闭', exact: true })).toBeDisabled();
    releasePost();
    await expect(
      detail.getByRole('button', { name: '选择其他公众号或新修订', exact: true }),
    ).toBeEnabled();
    await expect(detail.getByText('微信接口已返回草稿创建成功', { exact: true })).toBeVisible({
      timeout: 45000,
    });
    await detail.getByRole('button', { name: '选择其他公众号或新修订', exact: true }).click();
    submitting = false;
    const next = await selectAccount(page, second.name);
    await expect(next.getByLabel('本次投递目标')).toContainText(second.name);
    await expect(next.getByLabel('本次投递目标')).toContainText(article.title);
    await expect(next.getByRole('checkbox', { name: confirmation, exact: true })).not.toBeChecked();
  } finally {
    releasePost();
  }
});

test.describe('窄屏投递检查', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('不完整文章可以保存，缺封面和正文时不能投递，页面无横向溢出', async ({ page }, testInfo) => {
    await login(page);
    const target = await account(page, '窄屏');
    await page.getByRole('button', { name: '新建文章', exact: true }).click();
    await save(page);
    const before = await audit();
    await page.getByRole('button', { name: '存入微信草稿', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '存入微信草稿', exact: true });
    await dialog.getByRole('combobox', { name: '目标公众号', exact: true }).click();
    await page.getByRole('option', { name: target.name, exact: true }).click();
    await expect(dialog.getByText('请上传文章封面', { exact: true })).toBeVisible();
    await expect(dialog.getByText('正文不能为空', { exact: true })).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: '确认存入微信草稿', exact: true }),
    ).toBeDisabled();
    const submit = dialog.getByRole('button', { name: '确认存入微信草稿', exact: true });
    await submit.scrollIntoViewIfNeeded();
    await expect(submit).toBeVisible();
    const size = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(size.scroll).toBeLessThanOrEqual(size.width);
    const after = await audit();
    expect(after.calls).toEqual(before.calls);
    await page.screenshot({ path: testInfo.outputPath('p4-preflight-mobile.png'), fullPage: true });
  });
});
