import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { Account, Article } from '@tattoo/contracts';

test.skip(
  process.env.TATTOO_E2E_TEST_MODE !== '1' ||
    !process.env.TATTOO_E2E_EMAIL ||
    !process.env.TATTOO_E2E_PASSWORD ||
    !process.env.TATTOO_E2E_WECHAT_CONTROL_URL,
  '需要隔离的真实 API、Worker、前端与模拟微信',
);

const confirmation = '我确认将此修订上传到所选公众号，创建微信素材与一篇新草稿';
const permissionAdvice = '请在微信后台核对该账号的新增草稿权限；只读验证成功不代表可写入草稿。';
const bodyText = '从账号配置开始，完整验证保存、预览与后台微信草稿投递。';

type Delivery = {
  id: string;
  state: string;
  remoteId: string | null;
  resultSource: string | null;
  account: { id: string; name: string };
  revision: { id: string; title: string; version: number };
  events: { message: string }[];
};
type Audit = {
  calls: { token: number; count: number; cover: number; body: number; draft: number };
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
  const response = await fetch(process.env.TATTOO_E2E_WECHAT_CONTROL_URL + '/__tattoo_audit', {
    signal: AbortSignal.timeout(5000),
  });
  expect(response.ok).toBe(true);
  return response.json() as Promise<Audit>;
}

async function refuseNextDraft() {
  const response = await fetch(process.env.TATTOO_E2E_WECHAT_CONTROL_URL + '/__tattoo_control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nextDraft: 'refused' }),
    signal: AbortSignal.timeout(5000),
  });
  expect(response.ok).toBe(true);
  expect(await response.json()).toMatchObject({ ok: true });
}

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('管理员邮箱', { exact: true }).fill(process.env.TATTOO_E2E_EMAIL!);
  await page.getByLabel('密码', { exact: true }).fill(process.env.TATTOO_E2E_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '内容', exact: true })).toBeVisible();
}

async function createAccountInUi(page: Page, label: string): Promise<Account> {
  await page.getByRole('button', { name: '公众号账号', exact: true }).click();
  await expect(page.getByRole('heading', { name: '公众号账号', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新增公众号', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '新增公众号', exact: true });
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const name = 'P5公众号-' + label + '-' + suffix.slice(0, 5);
  const secret = 'p5-e2e-only-secret-' + suffix;
  await dialog.getByLabel('账号名称', { exact: true }).fill(name);
  await dialog.getByLabel('AppID', { exact: true }).fill('wx' + suffix);
  await dialog.getByLabel('AppSecret', { exact: true }).fill(secret);
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/accounts') && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: '保存公众号', exact: true }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  expect(await response.text()).not.toContain(secret);
  const account = (await response.json()).data as Account;
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  return account;
}

async function createArticleInUi(page: Page, label: string): Promise<Article> {
  await page.getByRole('button', { name: '内容', exact: true }).click();
  await expect(page.getByRole('heading', { name: '内容', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  const title = 'P5' + label + '-' + randomUUID().slice(0, 8);
  await page.getByLabel('标题', { exact: true }).fill(title);
  await page.getByLabel('作者', { exact: true }).fill('P5 编辑');
  await page.getByLabel('摘要', { exact: true }).fill('一篇从配置到投递的完整验收文章');
  await page.getByLabel('原文链接', { exact: true }).fill('https://example.com/p5-source');
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  await body.fill(bodyText);
  const picture = await sharp({
    create: { width: 240, height: 160, channels: 3, background: '#476b5a' },
  })
    .png()
    .toBuffer();
  const image = { name: 'p5-content.png', mimeType: 'image/png', buffer: picture };
  await page.getByTestId('body-image-input').setInputFiles(image);
  await expect(body.getByRole('img', { name: image.name, exact: true })).toBeVisible();
  await page.getByTestId('cover-image-input').setInputFiles(image);
  await expect(page.getByAltText('文章封面', { exact: true })).toBeVisible();
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/articles') && response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  const article = (await response.json()).data as Article;
  await expect(page.getByRole('status')).toHaveText('已保存 · 修订 v' + article.version);
  await expect(page.getByRole('alert')).toContainText('已保存为修订 v' + article.version + '。');
  await expect(page.getByRole('button', { name: '保存文章', exact: true })).toBeEnabled();
  expect(article.coverId).toBeTruthy();
  return article;
}

async function submitInUi(page: Page, article: Article, account: Account) {
  await page.getByRole('button', { name: '存入微信草稿', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '存入微信草稿', exact: true });
  await dialog.getByRole('combobox', { name: '目标公众号', exact: true }).click();
  await page.getByRole('option', { name: account.name, exact: true }).click();
  await expect(dialog.getByText('已保存修订通过本地投递检查', { exact: true })).toBeVisible();
  const target = dialog.getByLabel('本次投递目标');
  await expect(target).toContainText(account.name);
  await expect(target).toContainText(article.title);
  await expect(target).toContainText('v' + article.version);
  const submit = dialog.getByRole('button', { name: '确认存入微信草稿', exact: true });
  await expect(submit).toBeDisabled();
  await dialog.getByRole('checkbox', { name: confirmation, exact: true }).check();
  await expect(submit).toBeEnabled();
  const submitted = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/deliveries') && response.request().method() === 'POST',
  );
  await submit.click();
  const response = await submitted;
  expect(response.ok(), await response.text()).toBe(true);
  const delivery = (await response.json()).data as Delivery;
  expect(delivery.account.id).toBe(account.id);
  expect(delivery.revision.id).toBe(article.revisionId);
  const detail = page.getByRole('dialog', { name: '文章投递详情', exact: true });
  await expect(detail).toBeVisible();
  return { delivery, detail };
}

async function expectSucceeded(detail: Locator) {
  await expect(detail.getByText('微信接口已返回草稿创建成功', { exact: true })).toBeVisible({
    timeout: 45000,
  });
  await expect(detail.getByText('远程草稿 ID', { exact: true })).toBeVisible();
}

async function readDelivery(page: Page, id: string): Promise<Delivery> {
  const response = await page.request.get('/api/v1/deliveries/' + id);
  expect(response.ok()).toBe(true);
  return (await response.json()).data as Delivery;
}

test('同一浏览器完成账号配置、只读验证、图文编辑预览和普通微信草稿投递', async ({
  page,
}, testInfo) => {
  await login(page);
  const account = await createAccountInUi(page, '完整流程');
  const before = await audit();
  await page.getByRole('button', { name: '执行只读验证', exact: true }).click();
  await expect(page.getByText(/只读验证通过/)).toBeVisible();
  const readOnly = await audit();
  expect(readOnly.calls.count - before.calls.count).toBe(1);
  expect(readOnly.calls.cover).toBe(before.calls.cover);
  expect(readOnly.calls.body).toBe(before.calls.body);
  expect(readOnly.calls.draft).toBe(before.calls.draft);

  const article = await createArticleInUi(page, '闭环');
  const previewed = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/articles/' + article.id + '/preview') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: '微信预览', exact: true }).click();
  const response = await previewed;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON()).toEqual({ revisionId: article.revisionId });
  expect((await response.json()).data.version).toBe(article.version);
  const preview = page.getByRole('dialog', {
    name: '微信预览 · 修订 v' + article.version,
    exact: true,
  });
  await expect(preview.getByRole('heading', { name: article.title, exact: true })).toBeVisible();
  await expect(preview.getByAltText('预览封面', { exact: true })).toBeVisible();
  const frame = page.frameLocator('iframe[title="微信正文预览"]');
  await expect(frame.locator('body')).toContainText(bodyText);
  await expect(frame.locator('img')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('p5-complete-preview.png'), fullPage: true });
  await preview.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(preview).not.toBeVisible();
  const localOnly = await audit();
  expect(localOnly.calls).toEqual(readOnly.calls);

  const { delivery, detail } = await submitInUi(page, article, account);
  await expectSucceeded(detail);
  const completed = await readDelivery(page, delivery.id);
  expect(completed).toMatchObject({
    state: 'SUCCEEDED',
    resultSource: 'api',
    revision: { id: article.revisionId, version: article.version },
    account: { id: account.id },
  });
  expect(completed.remoteId).toBeTruthy();
  const after = await audit();
  expect(after.calls.draft - before.calls.draft).toBe(1);
  expect(after.calls.cover - before.calls.cover).toBe(1);
  expect(after.calls.body - before.calls.body).toBe(1);
  const payloads = after.draftPayloads.filter(
    (payload) => payload.articles[0]?.title === article.title,
  );
  expect(payloads).toHaveLength(1);
  expect(payloads[0]!.articles[0]).toMatchObject({
    author: article.author,
    digest: article.digest,
    content_source_url: article.sourceUrl,
  });
  expect(payloads[0]!.articles[0]!.content).toContain(bodyText);
  expect(payloads[0]!.articles[0]!.content).toContain('https://mmbiz.qpic.cn/');
  expect(payloads[0]!.articles[0]!.content).not.toContain('/api/v1/assets/');
  expect(payloads[0]!.articles[0]!.thumb_media_id).toBeTruthy();
  await detail.getByRole('button', { name: '查看全部投递记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '投递记录', exact: true })).toBeVisible();
  await page.getByRole('button').filter({ hasText: article.title }).click();
  const record = page.getByRole('dialog', { name: '投递详情', exact: true });
  await expectSucceeded(record);
  await expect(record.getByText('投递 ID：' + delivery.id, { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('p5-complete-result.png'), fullPage: true });
});

test('微信明确拒绝权限时显示修复建议，不自动重发，明确确认后重试原任务', async ({
  page,
}, testInfo) => {
  await login(page);
  const account = await createAccountInUi(page, '权限拒绝');
  const article = await createArticleInUi(page, '权限');
  const before = await audit();
  await refuseNextDraft();
  const { delivery, detail } = await submitInUi(page, article, account);
  await expect(detail.getByText('失败', { exact: true })).toBeVisible({ timeout: 45000 });
  await expect(
    detail.getByRole('alert').getByText('该账号尚未获准调用此接口（48001）', { exact: true }),
  ).toBeVisible();
  await expect(detail.getByText(permissionAdvice, { exact: true })).toBeVisible();
  await expect(detail.getByRole('heading', { name: '核对这次投递', exact: true })).toHaveCount(0);
  const retry = detail.getByRole('button', { name: '重试该投递', exact: true });
  await expect(retry).toBeDisabled();
  expect(await readDelivery(page, delivery.id)).toMatchObject({
    id: delivery.id,
    state: 'FAILED',
    remoteId: null,
  });
  await page.screenshot({ path: testInfo.outputPath('p5-permission-refused.png'), fullPage: true });
  await page.waitForTimeout(2500);
  const failed = await audit();
  expect(failed.calls.draft - before.calls.draft).toBe(1);
  expect(
    failed.draftPayloads.filter((payload) => payload.articles[0]?.title === article.title),
  ).toHaveLength(1);
  await expect(retry).toBeDisabled();

  await detail.getByRole('checkbox', { name: '我确认要重试这条投递记录', exact: true }).check();
  await expect(retry).toBeEnabled();
  const retried = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/deliveries/' + delivery.id + '/retry') &&
      response.request().method() === 'POST',
  );
  await retry.click();
  const retryResponse = await retried;
  expect(retryResponse.ok()).toBe(true);
  expect((await retryResponse.json()).data.id).toBe(delivery.id);
  await expectSucceeded(detail);
  const completed = await readDelivery(page, delivery.id);
  expect(completed).toMatchObject({
    id: delivery.id,
    state: 'SUCCEEDED',
    resultSource: 'api',
    revision: { id: article.revisionId },
    account: { id: account.id },
  });
  expect(
    completed.events.filter((event) => event.message === '用户显式重试已确定失败的任务'),
  ).toHaveLength(1);
  const after = await audit();
  expect(after.calls.draft - before.calls.draft).toBe(2);
  expect(after.calls.cover - before.calls.cover).toBe(1);
  expect(after.calls.body - before.calls.body).toBe(1);
  const payloads = after.draftPayloads.filter(
    (payload) => payload.articles[0]?.title === article.title,
  );
  expect(payloads).toHaveLength(2);
  expect(payloads[1]).toEqual(payloads[0]);
});
