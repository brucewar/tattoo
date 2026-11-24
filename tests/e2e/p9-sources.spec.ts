import { randomUUID } from 'node:crypto';
import { expect, test, type Locator, type Page } from '@playwright/test';
import type {
  AiGenerationJob,
  Article,
  Source,
  SourceFeed,
  SourceJob,
  SourceSearchConfig,
  SourceSummary,
} from '@tattoo/contracts';

test.skip(
  process.env.TATTOO_E2E_TEST_MODE !== '1' ||
    !process.env.TATTOO_E2E_EMAIL ||
    !process.env.TATTOO_E2E_PASSWORD ||
    !process.env.TATTOO_E2E_SOURCES_BASE_URL ||
    !process.env.TATTOO_E2E_SOURCES_CONTROL_URL ||
    !process.env.TATTOO_E2E_AI_BASE_URL,
  '需要隔离的真实 API、Worker、数据库及本地资料/模型接口',
);

const base = () => process.env.TATTOO_E2E_SOURCES_BASE_URL!;
type PageData<T> = { items: T[]; total: number };
type SourcesAudit = {
  calls: { article: number; feed: number; search: number };
  requests: { kind: string; path: string; query?: string }[];
};

async function audit(): Promise<SourcesAudit> {
  const response = await fetch(
    process.env.TATTOO_E2E_SOURCES_CONTROL_URL + '/__tattoo_sources_audit',
    { signal: AbortSignal.timeout(5000) },
  );
  expect(response.ok).toBe(true);
  return response.json() as Promise<SourcesAudit>;
}

async function control(input: { release?: boolean; articleVersion?: number }) {
  const response = await fetch(
    process.env.TATTOO_E2E_SOURCES_CONTROL_URL + '/__tattoo_sources_control',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(5000),
    },
  );
  expect(response.ok).toBe(true);
}

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('管理员邮箱', { exact: true }).fill(process.env.TATTOO_E2E_EMAIL!);
  await page.getByLabel('密码', { exact: true }).fill(process.env.TATTOO_E2E_PASSWORD!);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '内容', exact: true })).toBeVisible();
}

async function openSources(page: Page) {
  await page.getByRole('button', { name: '资料', exact: true }).click();
  await expect(page.getByRole('heading', { name: '资料', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tavily 搜索配置', exact: true })).toBeVisible();
}

async function apiData<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get('/api/v1' + path);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data as T;
}

async function put(page: Page, path: string, body: unknown) {
  return page.request.put('/api/v1' + path, {
    headers: { Origin: new URL(page.url()).origin, 'X-Tattoo-Request': '1' },
    data: body,
  });
}

async function configureSearch(page: Page) {
  const response = await put(page, '/sources/search-config', {
    baseUrl: base(),
    apiKey: 'p9-tavily-fake-key',
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function startSourceJob(page: Page, button: Locator): Promise<SourceJob> {
  const [response] = await Promise.all([
    page.waitForResponse(
      (result) =>
        result.url().endsWith('/api/v1/sources/jobs') && result.request().method() === 'POST',
    ),
    button.click(),
  ]);
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()).data as SourceJob;
}

async function finishSourceJob(page: Page, id: string): Promise<SourceJob> {
  await expect
    .poll(async () => (await apiData<SourceJob>(page, '/sources/jobs/' + id)).state, {
      timeout: 30000,
    })
    .toMatch(/^(SUCCEEDED|FAILED|UNCERTAIN)$/);
  const job = await apiData<SourceJob>(page, '/sources/jobs/' + id);
  expect(job.state, job.error ?? '资料任务应成功').toBe('SUCCEEDED');
  await expect(
    page
      .getByRole('region', { name: '本次资料任务', exact: true })
      .getByText('已完成', { exact: true }),
  ).toBeVisible();
  return job;
}

test.afterEach(async () => {
  await control({ release: true });
});

test('链接与 RSS 资料可读取、去重，取消订阅保留全文和来源', async ({ page }) => {
  await login(page);
  await openSources(page);
  const initial = await apiData<PageData<SourceSummary>>(page, '/sources?pageSize=100');
  const before = await audit();
  const urlRegion = page.getByRole('region', { name: '链接采集', exact: true });
  await urlRegion.getByLabel('原文链接', { exact: true }).fill(base() + '/sources/article#read');
  const urlJob = await finishSourceJob(
    page,
    (await startSourceJob(page, urlRegion.getByRole('button', { name: '采集链接', exact: true })))
      .id,
  );
  const articleId = urlJob.result!.sourceIds[0]!;
  const original = await apiData<Source>(page, '/sources/' + articleId);
  expect(original.url).toBe(base() + '/sources/article');
  expect(original.text).toContain('这是第 1 版已采集的正文参考');
  expect(original.contentKind).toBe('article');
  const task = page.getByRole('region', { name: '本次资料任务', exact: true });
  await task.getByRole('button', { name: '查看资料 1', exact: true }).click();
  const detail = page.getByRole('dialog', { name: '资料详情', exact: true });
  await expect(detail.getByLabel('已保存资料内容', { exact: true })).toContainText(
    '资料选用后才提交给模型',
  );
  await expect(detail.getByRole('link', { name: original.url, exact: true })).toHaveAttribute(
    'href',
    original.url,
  );
  await detail.getByRole('button', { name: '关闭', exact: true }).click();

  const rss = page.getByRole('region', { name: 'RSS 订阅', exact: true });
  const name = '浏览器 RSS-' + randomUUID().slice(0, 6);
  await rss.getByLabel('RSS 地址', { exact: true }).fill(base() + '/sources/feed');
  await rss.getByLabel('订阅名称（可选）', { exact: true }).fill(name);
  const [added] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/sources/feeds') && response.request().method() === 'POST',
    ),
    rss.getByRole('button', { name: '添加订阅', exact: true }).click(),
  ]);
  expect(added.ok(), await added.text()).toBe(true);
  const feed = (await added.json()).data as SourceFeed;
  const pull = rss.getByRole('button', { name: '拉取订阅：' + feed.title, exact: true });
  await expect(pull).toBeEnabled();
  const feedJob = await finishSourceJob(page, (await startSourceJob(page, pull)).id);
  expect(feedJob.result!.sourceIds).toHaveLength(2);
  expect(feedJob.result!.created).toBe(1);
  expect((await audit()).calls.article).toBe(before.calls.article + 1);
  expect((await apiData<PageData<SourceSummary>>(page, '/sources?pageSize=100')).total).toBe(
    initial.total + 2,
  );
  expect((await apiData<Source>(page, '/sources/' + articleId)).contentHash).toBe(
    original.contentHash,
  );
  const repeated = await finishSourceJob(page, (await startSourceJob(page, pull)).id);
  expect(repeated.result).toMatchObject({ created: 0, updated: 0 });
  const summaries = await apiData<PageData<SourceSummary>>(page, '/sources?pageSize=100');
  const excerpt = summaries.items.find((item) => item.url === base() + '/sources/article-two')!;
  expect(excerpt.contentKind).toBe('feed');
  await page
    .getByRole('region', { name: '已保存资料', exact: true })
    .getByRole('button', { name: /RSS第二条资料/ })
    .click();
  await expect(
    detail.getByText('这是 RSS 提供的文字，可能仅为摘要。需要全文时，请明确抓取原文页面。', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(detail.getByLabel('已保存资料内容', { exact: true })).toContainText('第二条RSS摘要');
  await detail.getByRole('button', { name: '关闭', exact: true }).click();

  page.once('dialog', (confirmation) => confirmation.accept());
  const [removed] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/sources/feeds/' + feed.id) &&
        response.request().method() === 'DELETE',
    ),
    rss.getByRole('button', { name: '取消订阅：' + feed.title, exact: true }).click(),
  ]);
  expect(removed.ok()).toBe(true);
  await expect(pull).toHaveCount(0);
  expect((await apiData<PageData<SourceSummary>>(page, '/sources?pageSize=100')).total).toBe(
    initial.total + 2,
  );
  expect(await apiData<Source>(page, '/sources/' + excerpt.id)).toMatchObject({
    feedId: null,
    feedUrl: feed.url,
  });
});

test('Tavily 搜索须明确采集，保存的全文和来源进入 AI 候选再采用保存', async ({ page }) => {
  await login(page);
  await openSources(page);
  const config = page.getByRole('region', { name: 'Tavily 搜索配置', exact: true });
  const before = await audit();
  const secret = 'p9-browser-tavily-key';
  await config.getByLabel('Tavily 服务地址', { exact: true }).fill(base());
  await config.getByLabel('Tavily API Key', { exact: true }).fill(secret);
  const [saved] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/sources/search-config') &&
        response.request().method() === 'PUT',
    ),
    config.getByRole('button', { name: '保存 Tavily 搜索配置', exact: true }).click(),
  ]);
  expect(saved.ok(), await saved.text()).toBe(true);
  expect(await saved.text()).not.toContain(secret);
  expect((await saved.json()).data as SourceSearchConfig).toMatchObject({ hasApiKey: true });
  await expect(config.getByLabel('Tavily API Key', { exact: true })).toHaveValue('');
  expect((await audit()).calls.search).toBe(before.calls.search);
  const sourceCount = (await apiData<PageData<SourceSummary>>(page, '/sources')).total;
  const search = page.getByRole('region', { name: '搜索资料', exact: true });
  await search.getByLabel('搜索词', { exact: true }).fill('明确选择后用于写作的资料');
  const searched = await finishSourceJob(
    page,
    (await startSourceJob(page, search.getByRole('button', { name: '搜索 Tavily', exact: true })))
      .id,
  );
  expect(searched.result!.items).toHaveLength(2);
  expect(searched.result!.sourceIds).toEqual([]);
  expect((await apiData<PageData<SourceSummary>>(page, '/sources')).total).toBe(sourceCount);
  const collected = await finishSourceJob(
    page,
    (
      await startSourceJob(
        page,
        page
          .getByRole('region', { name: '本次资料任务', exact: true })
          .getByRole('button', { name: '采集搜索结果：第二篇公开资料', exact: true }),
      )
    ).id,
  );
  const source = await apiData<Source>(page, '/sources/' + collected.result!.sourceIds[0]!);
  expect(source.contentKind).toBe('article');
  expect(source.text).toContain('这是第 1 版已采集的正文参考');

  const configured = await put(page, '/ai/models/text', {
    protocol: 'chat-completions',
    baseUrl: process.env.TATTOO_E2E_AI_BASE_URL!,
    model: 'p9-browser-text-model',
    apiKey: 'p9-browser-ai-key',
  });
  expect(configured.ok(), await configured.text()).toBe(true);
  const wechatBefore = await fetch(base() + '/__tattoo_audit').then((response) => response.json());
  await page.getByRole('button', { name: '内容', exact: true }).click();
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  await page.getByRole('button', { name: 'AI 写文章', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 写文章', exact: true });
  await dialog
    .getByRole('region', { name: '选择已保存资料', exact: true })
    .getByRole('checkbox', { name: '选择资料：' + source.title, exact: true })
    .check();
  await dialog
    .getByLabel('主题与写作要求', { exact: true })
    .fill('根据选中的公开资料生成一篇可审阅文章');
  const [generated] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/v1/ai/jobs') && response.request().method() === 'POST',
    ),
    dialog.getByRole('button', { name: '开始生成', exact: true }).click(),
  ]);
  expect(generated.ok(), await generated.text()).toBe(true);
  expect(generated.request().postDataJSON().sourceIds).toEqual([source.id]);
  const job = (await generated.json()).data as AiGenerationJob;
  expect(job.sourceReferences).toEqual([
    expect.objectContaining({ id: source.id, url: source.url, contentHash: source.contentHash }),
  ]);
  await expect(dialog.getByLabel('本次生成候选', { exact: true })).toBeVisible({ timeout: 30000 });
  const aiAudit = await fetch(process.env.TATTOO_E2E_AI_CONTROL_URL + '/__tattoo_ai_audit').then(
    (response) => response.json(),
  );
  const lastRequest = aiAudit.requests.at(-1);
  expect(lastRequest.task).toBe('ARTICLE');
  expect(lastRequest.prompt).toContain(source.url);
  expect(lastRequest.prompt).toContain('这是第 1 版已采集的正文参考');
  await dialog.getByRole('button', { name: '采用生成结果', exact: true }).click();
  const [articleResponse] = await Promise.all([
    page.waitForResponse(
      (response) =>
        /\/api\/v1\/articles(?:\/[^/]+)?$/.test(response.url()) &&
        ['POST', 'PATCH'].includes(response.request().method()),
    ),
    page.getByRole('button', { name: '保存文章', exact: true }).click(),
  ]);
  expect(articleResponse.ok(), await articleResponse.text()).toBe(true);
  const article = (await articleResponse.json()).data as Article;
  expect(article.title).toBe('AI 生成测试文章');
  await expect(page.getByRole('status')).toHaveText('已保存 · 修订 v' + article.version);
  const wechatAfter = await fetch(base() + '/__tattoo_audit').then((response) => response.json());
  expect(wechatAfter.calls.draft).toBe(wechatBefore.calls.draft);
});

test('搜索提交响应断线后复用原请求，存储不可用时不提交收费搜索', async ({ page }) => {
  await login(page);
  await configureSearch(page);
  await openSources(page);
  const before = await audit();
  const search = page.getByRole('region', { name: '搜索资料', exact: true });
  await search.getByLabel('搜索词', { exact: true }).fill('响应丢失-' + randomUUID());
  let committed: SourceJob | undefined;
  let originalKey = '';
  let completed!: () => void;
  const intercepted = new Promise<void>((resolve) => {
    completed = resolve;
  });
  const disconnect = async (route: import('@playwright/test').Route) => {
    if (route.request().method() !== 'POST') return route.continue();
    try {
      originalKey = route.request().postDataJSON().requestKey;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      committed = (await response.json()).data as SourceJob;
      await route.abort('connectionreset');
    } finally {
      completed();
    }
  };
  await page.route('**/api/v1/sources/jobs', disconnect);
  try {
    await search.getByRole('button', { name: '搜索 Tavily', exact: true }).click();
    await intercepted;
    await expect(page.getByRole('button', { name: '获取本次资料任务', exact: true })).toBeEnabled();
  } finally {
    await page.unroute('**/api/v1/sources/jobs', disconnect);
  }
  expect(committed).toBeTruthy();
  await expect
    .poll(async () => (await apiData<SourceJob>(page, '/sources/jobs/' + committed!.id)).state, {
      timeout: 30000,
    })
    .toBe('SUCCEEDED');
  await page.reload();
  await openSources(page);
  const recovered = await startSourceJob(
    page,
    page.getByRole('button', { name: '获取本次资料任务', exact: true }),
  );
  expect(recovered.requestKey).toBe(originalKey);
  expect(recovered.id).toBe(committed!.id);
  await finishSourceJob(page, recovered.id);
  expect((await audit()).calls.search).toBe(before.calls.search + 1);
  await search.getByLabel('搜索词', { exact: true }).fill('不允许存储时不能搜索');
  await expect(search.getByRole('button', { name: '搜索 Tavily', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
  });
  let submissions = 0;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/v1/sources/jobs'))
      submissions++;
  });
  await search.getByRole('button', { name: '搜索 Tavily', exact: true }).click();
  await expect(
    page.getByText('浏览器无法保存待确认请求，请允许会话存储后重试。本次未发起采集或搜索。', {
      exact: true,
    }),
  ).toBeVisible();
  expect(submissions).toBe(0);
  expect((await audit()).calls.search).toBe(before.calls.search + 1);
});

test.describe('窄屏资料管理', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('采集按钮和来源详情可达，页面没有横向溢出', async ({ page }, testInfo) => {
    await login(page);
    await openSources(page);
    const region = page.getByRole('region', { name: '链接采集', exact: true });
    await region.getByLabel('原文链接', { exact: true }).fill(base() + '/sources/article?mobile=1');
    const button = region.getByRole('button', { name: '采集链接', exact: true });
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeVisible();
    const job = await finishSourceJob(page, (await startSourceJob(page, button)).id);
    expect(job.result!.sourceIds).toHaveLength(1);
    let size = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(size.scroll).toBeLessThanOrEqual(size.width);
    await page
      .getByRole('region', { name: '本次资料任务', exact: true })
      .getByRole('button', { name: '查看资料 1', exact: true })
      .click();
    const detail = page.getByRole('dialog', { name: '资料详情', exact: true });
    await expect(detail.getByLabel('已保存资料内容', { exact: true })).toContainText('正文参考');
    const close = detail.getByRole('button', { name: '关闭', exact: true });
    await close.scrollIntoViewIfNeeded();
    await expect(close).toBeVisible();
    size = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(size.scroll).toBeLessThanOrEqual(size.width);
    await page.screenshot({ path: testInfo.outputPath('sources-mobile.png'), fullPage: true });
    await close.click();
  });
});
