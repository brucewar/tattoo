import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import type { Article, TopicCreationTask } from '@tattoo/contracts';

test.skip(
  process.env.TATTOO_E2E_TEST_MODE !== '1' ||
    !process.env.TATTOO_E2E_EMAIL ||
    !process.env.TATTOO_E2E_PASSWORD ||
    !process.env.TATTOO_E2E_AI_BASE_URL ||
    !process.env.TATTOO_E2E_AI_CONTROL_URL ||
    !process.env.TATTOO_E2E_WECHAT_CONTROL_URL,
  '需要隔离的真实 API、Worker、前端与本地模型/微信接口',
);

type Audit = {
  calls: { text: number; image: number };
  requests: { capability: string; prompt: string }[];
};

async function audit(): Promise<Audit> {
  const response = await fetch(process.env.TATTOO_E2E_AI_CONTROL_URL + '/__tattoo_ai_audit', {
    signal: AbortSignal.timeout(5000),
  });
  expect(response.ok).toBe(true);
  return response.json() as Promise<Audit>;
}

async function control(input: { nextText?: string; nextImage?: string; release?: boolean }) {
  const response = await fetch(process.env.TATTOO_E2E_AI_CONTROL_URL + '/__tattoo_ai_control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(5000),
  });
  expect(response.ok).toBe(true);
}

async function wechatAudit(): Promise<{ calls: { draft: number } }> {
  const response = await fetch(process.env.TATTOO_E2E_WECHAT_CONTROL_URL + '/__tattoo_audit', {
    signal: AbortSignal.timeout(5000),
  });
  expect(response.ok).toBe(true);
  return response.json() as Promise<{ calls: { draft: number } }>;
}

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('管理员邮箱', { exact: true }).fill(process.env.TATTOO_E2E_EMAIL!);
  await page.getByLabel('密码', { exact: true }).fill(process.env.TATTOO_E2E_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '内容', exact: true })).toBeVisible();
}

async function configure(page: Page) {
  for (const capability of ['text', 'image'] as const) {
    const response = await page.request.put('/api/v1/ai/models/' + capability, {
      headers: { Origin: new URL(page.url()).origin, 'X-Tattoo-Request': '1' },
      data: {
        protocol: capability === 'text' ? 'chat-completions' : 'images-generations',
        baseUrl: process.env.TATTOO_E2E_AI_BASE_URL!,
        model: `topic-browser-${capability}`,
        apiKey: `topic-browser-${capability}-test-key`,
        ...(capability === 'image' ? { imageSize: '1536x1024' } : {}),
      },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }
}

async function openCreation(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: '主题创作', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '主题创作', exact: true });
  await expect(dialog.getByLabel('创作主题', { exact: true })).toBeVisible();
  return dialog;
}

async function startCreation(page: Page, dialog: Locator, topic: string) {
  await dialog.getByLabel('创作主题', { exact: true }).fill(topic);
  const [response] = await Promise.all([
    page.waitForResponse(
      (value) => value.url().endsWith('/api/v1/ai/topics') && value.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: '生成文章和封面', exact: true }).click(),
  ]);
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.request().postDataJSON()).toEqual({ topic, requestKey: expect.any(String) });
  return (await response.json()).data as TopicCreationTask;
}

async function readTask(page: Page, id: string): Promise<TopicCreationTask> {
  const response = await page.request.get('/api/v1/ai/topics/' + id);
  expect(response.ok()).toBe(true);
  return (await response.json()).data as TopicCreationTask;
}

async function complete(page: Page, dialog: Locator, id: string) {
  await expect(dialog.getByRole('button', { name: '打开成稿编辑', exact: true })).toBeVisible({
    timeout: 30000,
  });
  const value = await readTask(page, id);
  expect(value.state).toBe('SUCCEEDED');
  expect(value.stage).toBe('DONE');
  expect(value.articleId).toBeTruthy();
  return value;
}

test.afterEach(async () => {
  await control({ release: true });
});

test('单个主题自动生成图文，跨刷新继续，成稿可编辑预览并显式投递微信草稿', async ({
  page,
}, testInfo) => {
  test.setTimeout(90000);
  await login(page);
  await configure(page);
  const before = await audit();
  const wechatBefore = await wechatAudit();
  const articlesBefore = (await (await page.request.get('/api/v1/articles')).json()).data.total;
  await control({ nextImage: 'hold' });
  let dialog = await openCreation(page);
  const topic = '普通创作者如何使用 AI 建立学习习惯-' + randomUUID().slice(0, 6);
  const created = await startCreation(page, dialog, topic);
  await expect
    .poll(async () => (await audit()).calls.image, { timeout: 30000 })
    .toBe(before.calls.image + 1);
  await expect(dialog.getByLabel('本次主题创作', { exact: true })).toContainText('生成封面');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: '资料', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('heading', { name: '内容', exact: true })).toBeVisible();
  dialog = await openCreation(page);
  await expect(dialog.getByLabel('本次主题创作', { exact: true })).toContainText(topic);
  await control({ release: true });
  const completed = await complete(page, dialog, created.id);
  const after = await audit();
  expect(after.calls.text).toBe(before.calls.text + 1);
  expect(after.calls.image).toBe(before.calls.image + 1);
  expect(after.requests.at(-2)?.prompt).toContain(topic);
  expect(after.requests.at(-1)?.prompt).toContain('AI 生成测试文章');
  expect(after.requests.at(-1)?.prompt).toContain('人工审阅后保存');
  expect((await wechatAudit()).calls.draft).toBe(wechatBefore.calls.draft);
  expect((await (await page.request.get('/api/v1/articles')).json()).data.total).toBe(
    articlesBefore + 1,
  );
  await page.screenshot({
    path: testInfo.outputPath('topic-creation-desktop.png'),
    fullPage: true,
  });
  await dialog.getByRole('button', { name: '打开成稿编辑', exact: true }).click();
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue('AI 生成测试文章');
  await expect(page.getByAltText('文章封面', { exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('已保存 · 修订 v1');
  await page.screenshot({
    path: testInfo.outputPath('topic-created-article-desktop.png'),
    fullPage: true,
  });
  const original = (
    await (await page.request.get('/api/v1/articles/' + completed.articleId)).json()
  ).data as Article;
  expect(original.coverId).toBeTruthy();
  expect(original.version).toBe(1);
  const title = '主题创作成稿-' + randomUUID().slice(0, 8);
  await page.getByLabel('标题', { exact: true }).fill(title);
  const [saved] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/articles/' + completed.articleId) &&
        response.request().method() === 'PATCH',
    ),
    page.getByRole('button', { name: '保存文章', exact: true }).click(),
  ]);
  expect(saved.ok(), await saved.text()).toBe(true);
  const revision = (await saved.json()).data as Article;
  expect(revision.version).toBe(2);
  expect(revision.coverId).toBe(original.coverId);
  await expect(page.getByRole('status')).toHaveText('已保存 · 修订 v2');
  await page.getByRole('button', { name: '微信预览', exact: true }).click();
  const preview = page.getByRole('dialog').filter({ hasText: '微信预览 · 修订 v2' });
  await expect(preview.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(preview.getByAltText('预览封面', { exact: true })).toBeVisible();
  await preview.getByRole('button', { name: 'Close', exact: true }).click();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const accountName = '主题草稿验收-' + suffix.slice(0, 6);
  const account = await page.request.post('/api/v1/accounts', {
    headers: { Origin: new URL(page.url()).origin, 'X-Tattoo-Request': '1' },
    data: { name: accountName, appId: 'wx' + suffix, appSecret: 'topic-test-secret-' + suffix },
  });
  expect(account.ok(), await account.text()).toBe(true);
  await page.getByRole('button', { name: '存入微信草稿', exact: true }).click();
  const delivery = page.getByRole('dialog', { name: '存入微信草稿', exact: true });
  await delivery.getByRole('combobox', { name: '目标公众号', exact: true }).click();
  await page.getByRole('option', { name: accountName, exact: true }).click();
  await delivery
    .getByRole('checkbox', {
      name: '我确认将此修订上传到所选公众号，创建微信素材与一篇新草稿',
      exact: true,
    })
    .check();
  const [submitted] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/deliveries') && response.request().method() === 'POST',
    ),
    delivery.getByRole('button', { name: '确认存入微信草稿', exact: true }).click(),
  ]);
  expect(submitted.ok(), await submitted.text()).toBe(true);
  const deliveryId = (await submitted.json()).data.id as string;
  await expect(
    page
      .getByRole('dialog', { name: '文章投递详情', exact: true })
      .getByText('微信接口已返回草稿创建成功', { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  const delivered = (await (await page.request.get('/api/v1/deliveries/' + deliveryId)).json())
    .data;
  expect(delivered.revisionId).toBe(revision.revisionId);
  expect(delivered.state).toBe('SUCCEEDED');
  expect((await wechatAudit()).calls.draft).toBe(wechatBefore.calls.draft + 1);
});

test('封面失败保留文章，仅重试封面且断线刷新后取回同一请求', async ({ page }) => {
  test.setTimeout(90000);
  await login(page);
  await configure(page);
  const before = await audit();
  await control({ nextImage: 'refused' });
  let dialog = await openCreation(page);
  const created = await startCreation(
    page,
    dialog,
    '封面失败后保留文章-' + randomUUID().slice(0, 6),
  );
  await expect(dialog.getByRole('button', { name: '仅重新生成封面', exact: true })).toBeVisible({
    timeout: 30000,
  });
  const failed = await readTask(page, created.id);
  expect(failed.articleResult?.title).toBe('AI 生成测试文章');
  expect(failed.canRetryCover).toBe(true);
  expect(failed.articleId).toBeNull();
  await dialog.getByText('查看已生成的文章', { exact: true }).click();
  await expect(dialog.getByLabel('生成的文章候选', { exact: true })).toContainText(
    '人工审阅后保存',
  );
  let originalKey = '';
  let committed: TopicCreationTask | undefined;
  let resolveIntercept!: () => void;
  const intercepted = new Promise<void>((resolve) => {
    resolveIntercept = resolve;
  });
  const disconnect = async (route: Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    try {
      originalKey = route.request().postDataJSON().requestKey;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      committed = (await response.json()).data as TopicCreationTask;
      await route.abort('connectionreset');
    } finally {
      resolveIntercept();
    }
  };
  const retryRoute = `**/api/v1/ai/topics/${created.id}/retry-cover`;
  await page.route(retryRoute, disconnect);
  try {
    await dialog.getByRole('button', { name: '仅重新生成封面', exact: true }).click();
    await intercepted;
    await expect(
      dialog.getByRole('button', { name: '取回上次创作请求', exact: true }),
    ).toBeEnabled();
  } finally {
    await page.unroute(retryRoute, disconnect);
  }
  expect(committed?.id).toBe(created.id);
  await page.reload();
  dialog = await openCreation(page);
  const [recovered] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/v1/ai/topics/${created.id}/retry-cover`) &&
        response.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: '取回上次创作请求', exact: true }).click(),
  ]);
  expect(recovered.ok(), await recovered.text()).toBe(true);
  expect(recovered.request().postDataJSON().requestKey).toBe(originalKey);
  const completed = await complete(page, dialog, created.id);
  expect(completed.articleJobId).toBe(failed.articleJobId);
  expect(completed.coverJobId).not.toBe(failed.coverJobId);
  const after = await audit();
  expect(after.calls.text).toBe(before.calls.text + 1);
  expect(after.calls.image).toBe(before.calls.image + 2);
});

test.describe('窄屏主题创作与请求恢复', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('主题提交响应丢失后复用请求，存储不可用不提交新生成', async ({ page }, testInfo) => {
    test.setTimeout(90000);
    await login(page);
    await configure(page);
    await control({ nextText: 'hold' });
    const before = await audit();
    let dialog = await openCreation(page);
    const topic = '窄屏主题请求恢复-' + randomUUID().slice(0, 6);
    await dialog.getByLabel('创作主题', { exact: true }).fill(topic);
    let originalKey = '';
    let committed: TopicCreationTask | undefined;
    let resolveIntercept!: () => void;
    const intercepted = new Promise<void>((resolve) => {
      resolveIntercept = resolve;
    });
    const disconnect = async (route: Route) => {
      if (route.request().method() !== 'POST') return route.continue();
      try {
        originalKey = route.request().postDataJSON().requestKey;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        committed = (await response.json()).data as TopicCreationTask;
        await route.abort('connectionreset');
      } finally {
        resolveIntercept();
      }
    };
    await page.route('**/api/v1/ai/topics', disconnect);
    try {
      await dialog.getByRole('button', { name: '生成文章和封面', exact: true }).click();
      await intercepted;
      await expect(
        dialog.getByRole('button', { name: '取回上次创作请求', exact: true }),
      ).toBeEnabled();
    } finally {
      await page.unroute('**/api/v1/ai/topics', disconnect);
    }
    expect(committed).toBeTruthy();
    await page.reload();
    dialog = await openCreation(page);
    await expect(dialog.getByLabel('创作主题', { exact: true })).toHaveValue(topic);
    const [recovered] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/v1/ai/topics') && response.request().method() === 'POST',
      ),
      dialog.getByRole('button', { name: '取回上次创作请求', exact: true }).click(),
    ]);
    expect(recovered.ok(), await recovered.text()).toBe(true);
    expect(recovered.request().postDataJSON().requestKey).toBe(originalKey);
    expect((await recovered.json()).data.id).toBe(committed!.id);
    await control({ release: true });
    await complete(page, dialog, committed!.id);
    expect((await audit()).calls).toEqual({
      text: before.calls.text + 1,
      image: before.calls.image + 1,
    });
    const size = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(size.scroll).toBeLessThanOrEqual(size.width);
    await dialog.getByLabel('创作主题', { exact: true }).fill('浏览器不能保存请求时不得调用模型');
    await page.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException('blocked', 'SecurityError');
      };
    });
    let submissions = 0;
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/v1/ai/topics')) submissions++;
    });
    await dialog.getByRole('button', { name: '生成文章和封面', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('尚未发起生成');
    expect(submissions).toBe(0);
    expect((await audit()).calls).toEqual({
      text: before.calls.text + 1,
      image: before.calls.image + 1,
    });
    await page.screenshot({
      path: testInfo.outputPath('topic-creation-mobile.png'),
      fullPage: true,
    });
  });
});
