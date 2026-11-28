import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { AiGenerationJob, AiModelConfig, Article } from '@tattoo/contracts';

test.skip(
  process.env.TATTOO_E2E_TEST_MODE !== '1' ||
    !process.env.TATTOO_E2E_EMAIL ||
    !process.env.TATTOO_E2E_PASSWORD ||
    !process.env.TATTOO_E2E_AI_BASE_URL ||
    !process.env.TATTOO_E2E_AI_CONTROL_URL,
  '需要隔离的真实 API、Worker、前端与本地模型接口',
);

type Audit = {
  calls: { text: number; image: number };
  requests: {
    capability: string;
    protocol: string;
    task: string;
    model: string;
    prompt: string;
    maxTokens: number | null;
  }[];
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

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('管理员邮箱', { exact: true }).fill(process.env.TATTOO_E2E_EMAIL!);
  await page.getByLabel('密码', { exact: true }).fill(process.env.TATTOO_E2E_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '内容', exact: true })).toBeVisible();
}

async function configure(page: Page, verify = false) {
  const openNavigation = page.getByRole('button', { name: '打开导航', exact: true });
  if (await openNavigation.isVisible()) await openNavigation.click();
  await page.getByRole('button', { name: '模型配置', exact: true }).click();
  await expect(page.getByRole('heading', { name: '模型配置', exact: true })).toBeVisible();
  for (const capability of ['text', 'image'] as const) {
    const label = capability === 'text' ? '文本模型' : '图片模型';
    const region = page.getByRole('region', { name: label, exact: true });
    if (capability === 'text') {
      await region.getByLabel('接口协议', { exact: true }).focus();
      await region.getByLabel('接口协议', { exact: true }).press('ArrowDown');
      await page.getByRole('option', { name: 'Chat Completions', exact: true }).click();
    }
    await region.getByLabel('服务地址', { exact: true }).fill(process.env.TATTOO_E2E_AI_BASE_URL!);
    await region.getByLabel('模型名称', { exact: true }).fill(`browser-${capability}-model`);
    const secret = `ai-${capability}-test-key-e2e`;
    await region.getByLabel('API Key', { exact: true }).fill(secret);
    if (capability === 'image')
      await region.getByLabel('图片尺寸（可选）', { exact: true }).fill('1536x1024');
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/ai/models/' + capability) &&
        response.request().method() === 'PUT',
    );
    await region.getByRole('button', { name: `保存${label}配置`, exact: true }).click();
    const response = await saved;
    expect(response.ok(), await response.text()).toBe(true);
    expect(await response.text()).not.toContain(secret);
    await expect(region.getByLabel('API Key', { exact: true })).toHaveValue('');
    await expect(region.getByRole('button', { name: `验证${label}`, exact: true })).toBeEnabled();
    if (verify) {
      await region.getByRole('button', { name: `验证${label}`, exact: true }).click();
      await expect(region.getByText('生成验证通过', { exact: true })).toBeVisible({
        timeout: 30000,
      });
    }
  }
}

async function newArticle(page: Page) {
  const openNavigation = page.getByRole('button', { name: '打开导航', exact: true });
  if (await openNavigation.isVisible()) await openNavigation.click();
  await page.getByRole('button', { name: '内容', exact: true }).click();
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  await expect(page.getByRole('heading', { name: '新建文章', exact: true })).toBeVisible();
}

async function startJob(page: Page, dialog: Locator, action: '开始生成' | '重新生成' = '开始生成') {
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/ai/jobs') && response.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: action, exact: true }).click(),
  ]);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data as AiGenerationJob;
}

async function expectCandidate(dialog: Locator) {
  await expect(dialog.getByLabel('本次生成候选', { exact: true })).toBeVisible({ timeout: 30000 });
  await expect(dialog.getByRole('button', { name: '采用生成结果', exact: true })).toBeEnabled();
}

async function save(page: Page): Promise<Article> {
  const saved = page.waitForResponse(
    (response) =>
      /\/api\/v1\/articles(?:\/[^/]+)?$/.test(response.url()) &&
      ['POST', 'PATCH'].includes(response.request().method()),
  );
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  const response = await saved;
  expect(response.ok(), await response.text()).toBe(true);
  const article = (await response.json()).data as Article;
  await expect(page.getByRole('status')).toHaveText('已保存 · 修订 v' + article.version);
  await expect(page.getByRole('button', { name: '保存文章', exact: true })).toBeEnabled();
  return article;
}

async function readJob(page: Page, id: string) {
  const response = await page.request.get('/api/v1/ai/jobs/' + id);
  expect(response.ok()).toBe(true);
  return (await response.json()).data as AiGenerationJob;
}

test.afterEach(async () => {
  await control({ release: true });
});

test('Responses 与 Anthropic 协议可选择、刷新保留并实际生成文章，图片配置保持独立', async ({
  page,
}) => {
  test.setTimeout(90000);
  await login(page);
  await configure(page);
  const image = page.getByRole('region', { name: '图片模型', exact: true });
  await expect(image.getByLabel('接口协议', { exact: true })).toHaveCount(0);
  const before = (await audit()).calls;
  for (const [protocol, label] of [
    ['responses', 'Responses'],
    ['anthropic-messages', 'Anthropic Messages'],
  ] as const) {
    await page.getByRole('button', { name: '模型配置', exact: true }).click();
    const text = page.getByRole('region', { name: '文本模型', exact: true });
    await text.getByLabel('接口协议', { exact: true }).focus();
    await text.getByLabel('接口协议', { exact: true }).press('ArrowDown');
    await page.getByRole('option', { name: label, exact: true }).click();
    if (protocol === 'anthropic-messages') {
      await expect(text.getByLabel('最大输出 tokens', { exact: true })).toHaveValue('4096');
      await text.getByLabel('最大输出 tokens', { exact: true }).fill('6144');
    } else {
      await expect(text.getByLabel('最大输出 tokens', { exact: true })).toHaveCount(0);
    }
    const [saved] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/v1/ai/models/text') &&
          response.request().method() === 'PUT',
      ),
      text.getByRole('button', { name: '保存文本模型配置', exact: true }).click(),
    ]);
    expect(saved.ok(), await saved.text()).toBe(true);
    const configured = (await saved.json()).data as AiModelConfig;
    expect(configured.protocol).toBe(protocol);
    expect(configured.hasApiKey).toBe(true);
    expect(configured.lastValidation).toBeNull();
    await page.reload();
    await page.getByRole('button', { name: '模型配置', exact: true }).click();
    await expect(page.getByRole('heading', { name: '模型配置', exact: true })).toBeVisible();
    await expect(text.getByRole('combobox', { name: '接口协议', exact: true })).toHaveText(label);
    await expect(text.getByLabel('API Key', { exact: true })).toHaveValue('');
    if (protocol === 'anthropic-messages')
      await expect(text.getByLabel('最大输出 tokens', { exact: true })).toHaveValue('6144');
    const models = (await (await page.request.get('/api/v1/ai/models')).json()).data;
    expect(models.text.protocol).toBe(protocol);
    expect(models.image.protocol).toBe('images-generations');
    await text.getByRole('button', { name: '验证文本模型', exact: true }).click();
    await expect(text.getByText('生成验证通过', { exact: true })).toBeVisible({ timeout: 30000 });
    await newArticle(page);
    await page.getByRole('button', { name: 'AI 写文章', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'AI 写文章', exact: true });
    await dialog.getByLabel('主题与写作要求', { exact: true }).fill(`通过 ${label} 生成可编辑文章`);
    const job = await startJob(page, dialog);
    expect(job.protocol).toBe(protocol);
    await expectCandidate(dialog);
    await dialog.getByRole('button', { name: '采用生成结果', exact: true }).click();
    const article = await save(page);
    expect(article.title).toBe('AI 生成测试文章');
    const completed = await readJob(page, job.id);
    expect(completed.protocol).toBe(protocol);
    expect(completed.state).toBe('SUCCEEDED');
    expect(JSON.stringify(completed.result)).not.toContain('private reasoning');
    const last = (await audit()).requests.at(-1)!;
    expect(last.protocol).toBe(protocol);
    expect(last.task).toBe('ARTICLE');
    expect(last.maxTokens).toBe(protocol === 'anthropic-messages' ? 6144 : null);
  }
  const after = (await audit()).calls;
  expect(after.text).toBe(before.text + 4);
  expect(after.image).toBe(before.image);
});

test('模型配置、AI 图文候选与明确采用保存，完成模拟微信草稿闭环', async ({ page }, testInfo) => {
  test.setTimeout(90000);
  await login(page);
  const wechatBefore = await fetch(
    process.env.TATTOO_E2E_WECHAT_CONTROL_URL + '/__tattoo_audit',
  ).then((response) => response.json());
  await configure(page, true);
  await page.screenshot({
    path: testInfo.outputPath('ai-model-settings-desktop.png'),
    fullPage: true,
  });
  const models = await page.request.get('/api/v1/ai/models');
  expect(await models.text()).not.toContain('ai-text-test-key-e2e');
  expect(await models.text()).not.toContain('ai-image-test-key-e2e');
  await newArticle(page);
  const articlesBefore = (await (await page.request.get('/api/v1/articles')).json()).data
    .total as number;
  await page.getByRole('button', { name: 'AI 写文章', exact: true }).click();
  const writing = page.getByRole('dialog', { name: 'AI 写文章', exact: true });
  await writing.getByLabel('主题与写作要求', { exact: true }).fill('写一篇面向创作者的入门文章');
  await writing
    .getByLabel('参考资料（可选）', { exact: true })
    .fill('强调内容应由作者审阅后明确采用。');
  const generated = await startJob(page, writing);
  await expectCandidate(writing);
  expect((await (await page.request.get('/api/v1/articles')).json()).data.total).toBe(
    articlesBefore,
  );
  await writing.getByRole('button', { name: '采用生成结果', exact: true }).click();
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue('AI 生成测试文章');
  await expect(page.getByRole('textbox', { name: '文章正文', exact: true })).toContainText(
    '人工审阅后保存',
  );
  const first = await save(page);
  expect(first.coverId).toBeNull();
  expect((await readJob(page, generated.id)).state).toBe('SUCCEEDED');
  await page.getByRole('button', { name: '生成封面', exact: true }).click();
  const cover = page.getByRole('dialog', { name: '生成封面', exact: true });
  await cover.getByLabel('图片要求', { exact: true }).fill('简洁的绿色横版创作封面');
  await startJob(page, cover);
  await expectCandidate(cover);
  expect((await audit()).requests.at(-1)?.prompt).toContain('内容需要人工审阅后保存');
  await expect(cover.getByAltText('AI 生成的候选图片', { exact: true })).toBeVisible();
  expect(
    (await (await page.request.get('/api/v1/articles/' + first.id)).json()).data.coverId,
  ).toBeNull();
  await cover.getByRole('button', { name: '采用生成结果', exact: true }).click();
  await expect(page.getByAltText('文章封面', { exact: true })).toBeVisible();
  const second = await save(page);
  expect(second.version).toBe(first.version + 1);
  expect(second.coverId).toBeTruthy();
  await page.getByRole('button', { name: '生成插图', exact: true }).click();
  const illustration = page.getByRole('dialog', { name: '生成插图', exact: true });
  await illustration.getByLabel('图片要求', { exact: true }).fill('与文章一致的创作过程插图');
  await startJob(page, illustration);
  await expectCandidate(illustration);
  await illustration.getByRole('button', { name: '采用生成结果', exact: true }).click();
  await expect(
    page
      .getByRole('textbox', { name: '文章正文', exact: true })
      .getByAltText('AI 生成插图', { exact: true }),
  ).toBeVisible();
  const third = await save(page);
  expect(third.version).toBe(second.version + 1);
  const revisions = await page.request.get('/api/v1/articles/' + first.id + '/revisions');
  expect(revisions.ok()).toBe(true);
  const history = (await revisions.json()).data.items as { id: string; coverId: string | null }[];
  expect(history.some((revision) => revision.id === first.revisionId)).toBe(true);
  const firstRevision = await page.request.get(
    '/api/v1/articles/' + first.id + '/revisions/' + first.revisionId,
  );
  expect(firstRevision.ok()).toBe(true);
  expect((await firstRevision.json()).data.coverId).toBeNull();
  await page.getByRole('button', { name: '微信预览', exact: true }).click();
  const preview = page.getByRole('dialog').filter({ hasText: '微信预览 · 修订 v' + third.version });
  await expect(preview.getByRole('heading', { name: third.title, exact: true })).toBeVisible();
  await expect(preview.getByAltText('预览封面', { exact: true })).toBeVisible();
  const previewBody = page.frameLocator('iframe[title="微信正文预览"]');
  await expect(previewBody.locator('img')).toHaveCount(1);
  await expect
    .poll(() =>
      previewBody.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBe(360);
  await page.screenshot({
    path: testInfo.outputPath('ai-created-preview-desktop.png'),
    fullPage: true,
  });
  const wechat = await fetch(process.env.TATTOO_E2E_WECHAT_CONTROL_URL + '/__tattoo_audit').then(
    (response) => response.json(),
  );
  expect(wechat.calls).toEqual(wechatBefore.calls);

  // Generation and adoption are inert until this separate, explicit delivery.
  await preview.getByRole('button', { name: '关闭弹窗', exact: true }).click();
  const accountSuffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const accountName = `AI 创作验收-${accountSuffix.slice(0, 6)}`;
  const accountResponse = await page.request.post('/api/v1/accounts', {
    headers: { Origin: new URL(page.url()).origin, 'X-Tattoo-Request': '1' },
    data: {
      name: accountName,
      appId: `wx${accountSuffix}`,
      appSecret: `ai-wechat-test-only-${accountSuffix}`,
    },
  });
  expect(accountResponse.ok()).toBe(true);
  const targetAccount = (await accountResponse.json()).data as { id: string };
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
  const submitted = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/deliveries') && response.request().method() === 'POST',
  );
  await delivery.getByRole('button', { name: '确认存入微信草稿', exact: true }).click();
  const savedDelivery = (await (await submitted).json()).data as { id: string };
  const detail = page.getByRole('dialog', { name: '文章投递详情', exact: true });
  await expect(detail.getByText('微信接口已返回草稿创建成功', { exact: true })).toBeVisible({
    timeout: 30000,
  });
  const delivered = await page.request.get('/api/v1/deliveries/' + savedDelivery.id);
  const deliveredData = (await delivered.json()).data as {
    revisionId: string;
    accountId: string;
    state: string;
  };
  expect(deliveredData.revisionId).toBe(third.revisionId);
  expect(deliveredData.accountId).toBe(targetAccount.id);
  expect(deliveredData.state).toBe('SUCCEEDED');
  const wechatAfterDelivery = await fetch(
    process.env.TATTOO_E2E_WECHAT_CONTROL_URL + '/__tattoo_audit',
  ).then((response) => response.json());
  expect(wechatAfterDelivery.calls.draft).toBe(wechatBefore.calls.draft + 1);
  expect(wechatAfterDelivery.draftPayloads.at(-1).articles[0].title).toBe(third.title);
  expect(wechatAfterDelivery.draftPayloads.at(-1).articles[0].content).toContain(
    '内容需要人工审阅后保存',
  );
});

test('已有编辑不被候选覆盖，拒绝采用后保留原稿，失败仅在明确重新生成后再次调用', async ({
  page,
}) => {
  await login(page);
  await configure(page);
  await newArticle(page);
  const originalTitle = '等待人工确认-' + randomUUID().slice(0, 6);
  await page.getByLabel('标题', { exact: true }).fill(originalTitle);
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  await body.fill('这段未保存的正文必须保留。');
  const before = await audit();
  await control({ nextText: 'refused' });
  await page.getByRole('button', { name: 'AI 写文章', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 写文章', exact: true });
  await dialog
    .getByLabel('主题与写作要求', { exact: true })
    .fill('生成另一个候选，保留原稿直到确认');
  const failed = await startJob(page, dialog);
  await expect(
    dialog.getByLabel('生成任务状态').getByText('生成失败', { exact: true }),
  ).toBeVisible({ timeout: 30000 });
  expect((await audit()).calls.text).toBe(before.calls.text + 1);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue(originalTitle);
  await expect(body).toHaveText('这段未保存的正文必须保留。');
  await page.getByRole('button', { name: 'AI 写文章', exact: true }).click();
  await expect(
    dialog.getByLabel('生成任务状态').getByText('生成失败', { exact: true }),
  ).toBeVisible();
  expect((await audit()).calls.text).toBe(before.calls.text + 1);
  await dialog.getByLabel('主题与写作要求', { exact: true }).fill('修复配置后，显式再生成一篇');
  const retried = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/ai/jobs') && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: '重新生成', exact: true }).click();
  const retry = (await (await retried).json()).data as AiGenerationJob;
  expect(retry.id).not.toBe(failed.id);
  await expectCandidate(dialog);
  page.once('dialog', (confirmation) => confirmation.dismiss());
  await dialog.getByRole('button', { name: '采用生成结果', exact: true }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue(originalTitle);
  await expect(body).toHaveText('这段未保存的正文必须保留。');
  expect((await readJob(page, failed.id)).state).toBe('FAILED');
  expect((await audit()).calls.text).toBe(before.calls.text + 2);
});

test('选中文字可以改写，生成期间原文改变时拒绝把迟到结果覆盖到新位置', async ({ page }) => {
  await login(page);
  await configure(page);
  await newArticle(page);
  await page.getByLabel('标题', { exact: true }).fill('选中内容保护-' + randomUUID().slice(0, 6));
  const body = page.getByRole('textbox', { name: '文章正文', exact: true });
  await body.fill('原来的段落可以被明确改写。');
  await save(page);
  await body.focus();
  await body.press('Control+A');
  await page.getByRole('button', { name: 'AI 改写', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 改写', exact: true });
  await expect(dialog.getByRole('radio', { name: '选中文字', exact: true })).toBeChecked();
  await expect(dialog.getByLabel('选中的原文', { exact: true })).toHaveValue(
    '原来的段落可以被明确改写。',
  );
  await dialog.getByLabel('改写要求', { exact: true }).fill('改得简洁一些');
  await startJob(page, dialog);
  await expectCandidate(dialog);
  await dialog.getByRole('button', { name: '采用生成结果', exact: true }).click();
  await expect(body).toHaveText('这是模型改写后的段落。');
  await save(page);
  await body.focus();
  await body.press('Control+A');
  await control({ nextText: 'hold' });
  const before = await audit();
  await page.getByRole('button', { name: 'AI 改写', exact: true }).click();
  await dialog.getByLabel('改写要求', { exact: true }).fill('再次改写，但生成期间原文会变化');
  const held = await startJob(page, dialog, '重新生成');
  await expect.poll(async () => (await audit()).calls.text).toBe(before.calls.text + 1);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await body.fill('用户在等待期间写下的新内容，必须保留。');
  await page.getByRole('button', { name: 'AI 改写', exact: true }).click();
  await control({ release: true });
  await expectCandidate(dialog);
  await dialog.getByRole('button', { name: '采用生成结果', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('原选中文字已变化');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(body).toHaveText('用户在等待期间写下的新内容，必须保留。');
  expect((await readJob(page, held.id)).state).toBe('SUCCEEDED');
  expect((await audit()).calls.text).toBe(before.calls.text + 1);
});

test('生成请求已入库但响应断线时，刷新重入仍取回同一意图，不重复调用模型', async ({ page }) => {
  await login(page);
  await configure(page);
  await newArticle(page);
  const title = '迟到生成请求-' + randomUUID().slice(0, 6);
  await page.getByLabel('标题', { exact: true }).fill(title);
  await page
    .getByRole('textbox', { name: '文章正文', exact: true })
    .fill('已保存的正文用于验证刷新恢复。');
  await save(page);
  const before = await audit();
  let committed: AiGenerationJob | undefined;
  let originalKey = '';
  let completed!: () => void;
  const intercepted = new Promise<void>((resolve) => {
    completed = resolve;
  });
  const loseResponse = async (route: import('@playwright/test').Route) => {
    try {
      originalKey = (route.request().postDataJSON() as { requestKey: string }).requestKey;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      committed = (await response.json()).data as AiGenerationJob;
      await route.abort('connectionreset');
    } finally {
      completed();
    }
  };
  await page.route('**/api/v1/ai/jobs', loseResponse);
  const dialog = page.getByRole('dialog', { name: 'AI 写文章', exact: true });
  try {
    await page.getByRole('button', { name: 'AI 写文章', exact: true }).click();
    await dialog
      .getByLabel('主题与写作要求', { exact: true })
      .fill('刷新后也只能执行一次的文章生成');
    await dialog.getByRole('button', { name: '开始生成', exact: true }).click();
    await intercepted;
    await expect(
      dialog.getByRole('button', { name: '获取本次生成任务', exact: true }),
    ).toBeEnabled();
    await expect(dialog.getByRole('alert')).toContainText('连接中断');
  } finally {
    await page.unroute('**/api/v1/ai/jobs', loseResponse);
  }
  expect(committed).toBeTruthy();
  await expect
    .poll(async () => (await readJob(page, committed!.id)).state, { timeout: 30000 })
    .toBe('SUCCEEDED');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: new RegExp(title) }).click();
  await page.getByRole('button', { name: 'AI 写文章', exact: true }).click();
  const recovered = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/v1/ai/jobs') && response.request().method() === 'POST',
  );
  await dialog.getByRole('button', { name: '获取本次生成任务', exact: true }).click();
  const response = await recovered;
  expect(response.ok()).toBe(true);
  expect((response.request().postDataJSON() as { requestKey: string }).requestKey).toBe(
    originalKey,
  );
  expect(((await response.json()).data as AiGenerationJob).id).toBe(committed!.id);
  await expectCandidate(dialog);
  expect((await audit()).calls.text).toBe(before.calls.text + 1);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue(title);
  await expect(page.getByRole('textbox', { name: '文章正文', exact: true })).toHaveText(
    '已保存的正文用于验证刷新恢复。',
  );
});

test.describe('窄屏 AI 创作', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('模型配置与封面候选按钮可达，选用图片后页面无横向溢出', async ({ page }, testInfo) => {
    await login(page);
    await configure(page);
    let size = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(size.scroll).toBeLessThanOrEqual(size.width);
    await newArticle(page);
    await page.getByRole('button', { name: '生成封面', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '生成封面', exact: true });
    await dialog.getByLabel('图片要求', { exact: true }).fill('手机端也能确认的绿色横版封面');
    await startJob(page, dialog);
    await expectCandidate(dialog);
    const adopt = dialog.getByRole('button', { name: '采用生成结果', exact: true });
    await adopt.scrollIntoViewIfNeeded();
    await expect(adopt).toBeVisible();
    size = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(size.scroll).toBeLessThanOrEqual(size.width);
    await page.screenshot({ path: testInfo.outputPath('ai-cover-mobile.png'), fullPage: true });
    await adopt.click();
    await expect(page.getByAltText('文章封面', { exact: true })).toBeVisible();
    const originalCover = await page.getByAltText('文章封面', { exact: true }).getAttribute('src');
    const bodyImage = await page.request.get(originalCover!);
    expect(bodyImage.ok()).toBe(true);
    await page.getByTestId('body-image-input').setInputFiles({
      name: 'only-image.png',
      mimeType: 'image/png',
      buffer: await bodyImage.body(),
    });
    const body = page.getByRole('textbox', { name: '文章正文', exact: true });
    await expect(body.locator('img')).toBeVisible();
    await expect(page.getByLabel('标题', { exact: true })).toHaveValue('');
    await page.getByRole('button', { name: 'AI 写文章', exact: true }).click();
    const article = page.getByRole('dialog', { name: 'AI 写文章', exact: true });
    await article
      .getByLabel('主题与写作要求', { exact: true })
      .fill('仅有图片的新稿也需要确认再采用文章');
    await startJob(page, article);
    await expectCandidate(article);
    page.once('dialog', (confirmation) => confirmation.dismiss());
    const [confirmation] = await Promise.all([
      page.waitForEvent('dialog', { timeout: 3000 }),
      article.getByRole('button', { name: '采用生成结果', exact: true }).click(),
    ]);
    expect(confirmation.message()).toContain('替换');
    await expect(article).toBeVisible();
    await article.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(page.getByLabel('标题', { exact: true })).toHaveValue('');
    await expect(page.getByRole('textbox', { name: '文章正文', exact: true })).toHaveText('');
    await expect(body.locator('img')).toHaveAttribute('src', originalCover!);
    await expect(page.getByAltText('文章封面', { exact: true })).toHaveAttribute(
      'src',
      originalCover!,
    );
    const saved = await save(page);
    expect(saved.coverId).toBeTruthy();
  });
});
