import { expect, test, type Locator, type Page } from '@playwright/test';
import type {
  Account,
  AiModelConfig,
  AiModelInput,
  AiModels,
  SourceFeed,
  SourceSearchConfig,
} from '@tattoo/contracts';

test.skip(process.env.TATTOO_E2E_TEST_MODE !== '1', '需要隔离的前端验证环境');

// Every API request is intercepted: these tests never call a model or publish a draft.
async function workspace(page: Page, options: { failReads?: string[] } = {}) {
  const failedReads = new Set(options.failReads ?? []);
  const unexpected: string[] = [];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const accounts: Account[] = [];
  const feeds: SourceFeed[] = [];
  const initialText: AiModelConfig = {
    capability: 'text',
    protocol: 'chat-completions',
    baseUrl: 'https://model.example.com/v1',
    model: 'workspace-demo-text',
    hasApiKey: true,
    version: 1,
    imageSize: '',
    imageResponseFormat: 'auto',
    anthropicMaxTokens: 4096,
    updatedAt: '2026-11-28T00:00:00.000Z',
    lastValidation: null,
  };
  const models: AiModels = { text: initialText, image: null };
  let searchConfig: SourceSearchConfig = {
    baseUrl: 'https://search.example.com',
    hasApiKey: true,
    version: 1,
    updatedAt: '2026-11-28T00:00:00.000Z',
  };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    const method = request.method();
    let data: unknown;
    if (method === 'GET') {
      if (failedReads.has(path)) {
        await route.fulfill({
          status: 503,
          json: { error: { code: 'OFFLINE_FIXTURE', message: '临时无法读取，请重试' } },
        });
        return;
      }
      if (path === '/auth/me')
        data = { id: 'workspace-admin', email: 'demo@example.com', remoteWritesEnabled: false };
      else if (path === '/ai/models') data = models;
      else if (path === '/sources/search-config') data = searchConfig;
      else if (path === '/accounts')
        data = { items: accounts, total: accounts.length, page: 1, pageSize: 20 };
      else if (path === '/sources/feeds')
        data = { items: feeds, total: feeds.length, page: 1, pageSize: 5 };
      else if (['/articles', '/ai/jobs', '/sources', '/sources/jobs', '/deliveries'].includes(path))
        data = { items: [], total: 0, page: 1, pageSize: 20 };
    } else if (method === 'PUT' && /^\/ai\/models\/(text|image)$/.test(path)) {
      const body = request.postDataJSON() as AiModelInput;
      writes.push({ path, body });
      const capability = path.endsWith('/text') ? 'text' : 'image';
      const current = models[capability];
      const { apiKey, clearApiKey, ...input } = body;
      const next: AiModelConfig = {
        ...initialText,
        ...input,
        capability,
        protocol: body.protocol ?? 'chat-completions',
        hasApiKey: clearApiKey ? false : Boolean(apiKey || current?.hasApiKey),
        version: (current?.version ?? 0) + 1,
      };
      // The real API returns only hasApiKey, never API key plaintext.
      models[capability] = next;
      data = next;
    } else if (method === 'POST' && path === '/accounts') {
      const body = request.postDataJSON() as Record<string, string>;
      writes.push({ path, body });
      const account: Account = {
        id: 'workspace-account',
        name: body.name!,
        appId: body.appId!,
        platform: 'wechat',
        credentialVersion: 1,
        capabilities: { readDraft: { status: 'unverified' }, saveDraft: { status: 'unverified' } },
      };
      accounts.push(account);
      data = account;
    } else if (method === 'POST' && path === '/sources/feeds') {
      const body = request.postDataJSON() as Record<string, string>;
      writes.push({ path, body });
      const feed: SourceFeed = {
        id: 'workspace-feed',
        title: body.title ?? '',
        url: body.url!,
        lastFetchedAt: null,
        lastError: null,
        createdAt: '2026-11-28T00:00:00.000Z',
      };
      feeds.push(feed);
      data = feed;
    } else if (method === 'PUT' && path === '/sources/search-config') {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path, body });
      searchConfig = {
        ...searchConfig,
        baseUrl: String(body.baseUrl),
        hasApiKey: body.clearApiKey ? false : Boolean(body.apiKey || searchConfig.hasApiKey),
        version: searchConfig.version + 1,
      };
      data = searchConfig;
    }
    if (data === undefined) {
      unexpected.push(`${method} ${path}`);
      await route.fulfill({ status: 404, json: { error: { message: '未配置的界面验证请求' } } });
      return;
    }
    await route.fulfill({ json: { data } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '内容', exact: true })).toBeVisible();
  return { unexpected, writes, restoreRead: (path: string) => failedReads.delete(path) };
}

async function select(page: Page, control: Locator, option: string) {
  await control.click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

test('模型协议和密钥表单保留未保存修改，保存后不回填密钥', async ({ page }) => {
  const fixture = await workspace(page);
  await page.getByRole('button', { name: '模型配置', exact: true }).click();
  const text = page.getByRole('region', { name: '文本模型', exact: true });
  await select(page, text.getByLabel('接口协议', { exact: true }), 'Anthropic Messages');
  await text.getByLabel('最大输出 tokens', { exact: true }).fill('6144');
  await expect(text.locator('.endpoint-preview')).toContainText('/v1/messages');
  const key = text.getByLabel('API Key', { exact: true });
  await key.fill('workspace-fake-key');
  const clear = text.getByRole('checkbox', { name: '清除已保存密钥（无密钥服务）', exact: true });
  await clear.check();
  await expect(key).toHaveValue('');
  await expect(key).toBeDisabled();
  await clear.uncheck();
  await key.fill('workspace-fake-replacement-key');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '投递记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '模型配置', exact: true })).toBeVisible();
  await expect(key).toHaveValue('workspace-fake-replacement-key');
  await expect(text.getByLabel('最大输出 tokens', { exact: true })).toHaveValue('6144');
  await text.getByRole('button', { name: '保存文本模型配置', exact: true }).click();
  await expect(key).toHaveValue('');
  await expect(text.getByRole('button', { name: '验证文本模型', exact: true })).toBeEnabled();
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]).toMatchObject({
    path: '/ai/models/text',
    body: {
      protocol: 'anthropic-messages',
      anthropicMaxTokens: 6144,
      apiKey: 'workspace-fake-replacement-key',
      clearApiKey: false,
    },
  });
  expect(fixture.unexpected).toEqual([]);
});

test('模型保留必填和 token 整数边界，图片配置保持独立', async ({ page }) => {
  const fixture = await workspace(page);
  await page.getByRole('button', { name: '模型配置', exact: true }).click();
  const text = page.getByRole('region', { name: '文本模型', exact: true });
  const image = page.getByRole('region', { name: '图片模型', exact: true });
  await expect(image.getByLabel('接口协议', { exact: true })).toHaveCount(0);
  await select(page, text.getByLabel('接口协议', { exact: true }), 'Anthropic Messages');
  const tokens = text.getByLabel('最大输出 tokens', { exact: true });
  const save = text.getByRole('button', { name: '保存文本模型配置', exact: true });
  for (const invalid of ['', '0', '128001', '1.5']) {
    await tokens.fill(invalid);
    await save.click();
    expect(await tokens.evaluate((element: HTMLInputElement) => element.validity.valid)).toBe(
      false,
    );
    expect(fixture.writes).toEqual([]);
  }
  await tokens.fill('128000');
  const model = text.getByLabel('模型名称', { exact: true });
  await expect(model).not.toHaveAttribute('aria-invalid', 'true');
  await model.fill('   ');
  await save.click();
  await expect(text.getByRole('alert')).toContainText('请输入模型名称');
  await expect(model).toHaveAttribute('aria-invalid', 'true');
  await expect(model).toHaveAttribute('aria-describedby', 'model-text-name-error');
  await expect(model).toBeFocused();
  expect(fixture.writes).toEqual([]);
  await model.fill('workspace-max-token-model');
  await expect(model).not.toHaveAttribute('aria-invalid', 'true');
  await save.click();
  await expect(text.getByRole('button', { name: '验证文本模型', exact: true })).toBeEnabled();
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]?.body.anthropicMaxTokens).toBe(128000);
  await select(page, text.getByLabel('接口协议', { exact: true }), 'Responses');
  await expect(tokens).toHaveCount(0);
  await expect(text.locator('.endpoint-preview')).toContainText('/v1/responses');
  expect(fixture.unexpected).toEqual([]);
});

test('公众号配置保留账号名称、AppID 和密钥约束，编辑时不返回密钥', async ({ page }) => {
  const fixture = await workspace(page);
  await page.getByRole('button', { name: '公众号账号', exact: true }).click();
  await page.getByRole('button', { name: '新增公众号', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '新增公众号', exact: true });
  const name = dialog.getByLabel('账号名称', { exact: true });
  const appId = dialog.getByLabel('AppID', { exact: true });
  const secret = dialog.getByLabel('AppSecret', { exact: true });
  const save = dialog.getByRole('button', { name: '保存公众号', exact: true });
  await expect(name).not.toHaveAttribute('aria-invalid', 'true');
  await name.fill('   ');
  await appId.fill('wx12345678');
  await secret.fill('workspace-fake-app-secret');
  await save.click();
  await expect(dialog.getByRole('alert')).toContainText('请输入账号名称');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toHaveAttribute('aria-describedby', 'account-name-error');
  await expect(name).toBeFocused();
  await name.fill('写作测试号');
  await appId.fill('invalid-app-id');
  await save.click();
  expect(
    await appId.evaluate((element: HTMLInputElement) => element.validity.patternMismatch),
  ).toBe(true);
  expect(fixture.writes).toEqual([]);
  await appId.fill('wx12345678');
  await secret.fill('too-short');
  await save.click();
  await expect(dialog.getByRole('alert')).toContainText('AppSecret 长度应为 16–128 个字符');
  await expect(secret).toHaveAttribute('aria-invalid', 'true');
  await expect(secret).toHaveAttribute(
    'aria-describedby',
    'account-app-secret-help account-app-secret-error',
  );
  await expect(secret).toBeFocused();
  expect(fixture.writes).toEqual([]);
  await secret.fill('workspace-fake-app-secret');
  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]).toMatchObject({
    path: '/accounts',
    body: { name: '写作测试号', appId: 'wx12345678', appSecret: 'workspace-fake-app-secret' },
  });
  await page.getByRole('button', { name: '编辑配置', exact: true }).click();
  const edit = page.getByRole('dialog', { name: '编辑公众号配置', exact: true });
  await expect(edit.getByLabel('AppID', { exact: true })).toBeDisabled();
  await expect(edit.getByLabel('轮换 AppSecret（可选）', { exact: true })).toHaveValue('');
  expect(fixture.unexpected).toEqual([]);
});

test('管理页读取失败不误报为空，重新加载后恢复正确内容', async ({ page }) => {
  const fixture = await workspace(page, {
    failReads: ['/accounts', '/ai/models', '/deliveries', '/sources'],
  });
  for (const entry of [
    {
      section: '公众号账号',
      path: '/accounts',
      retry: '重新加载公众号账号',
      emptyText: '接入第一个公众号',
    },
    {
      section: '模型配置',
      path: '/ai/models',
      retry: '重新加载',
      emptyText: '还没有生成任务',
    },
    {
      section: '投递记录',
      path: '/deliveries',
      retry: '重新加载',
      emptyText: '还没有投递记录',
    },
    {
      section: '资料',
      path: '/sources',
      retry: '重新加载资料',
      emptyText: '还没有匹配的资料',
    },
  ]) {
    await page.getByRole('button', { name: entry.section, exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('临时无法读取，请重试');
    await expect(page.getByText(entry.emptyText, { exact: true })).toHaveCount(0);
    fixture.restoreRead(entry.path);
    await page.getByRole('button', { name: entry.retry, exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText(entry.emptyText, { exact: true })).toBeVisible();
  }
  expect(fixture.writes).toEqual([]);
  expect(fixture.unexpected).toEqual([]);
});

test('资料表单校验 URL，RSS 新增不会自动拉取，清除搜索密钥后不回填', async ({ page }) => {
  const fixture = await workspace(page);
  await page.getByRole('button', { name: '资料', exact: true }).click();
  const collect = page.getByRole('region', { name: '链接采集', exact: true });
  const url = collect.getByLabel('原文链接', { exact: true });
  await url.fill('not-a-url');
  await collect.getByRole('button', { name: '采集链接', exact: true }).click();
  expect(await url.evaluate((element: HTMLInputElement) => element.validity.typeMismatch)).toBe(
    true,
  );
  const rss = page.getByRole('region', { name: 'RSS 订阅', exact: true });
  await rss.getByLabel('RSS 地址', { exact: true }).fill('https://feed.example.com/rss.xml');
  await rss.getByLabel('订阅名称（可选）', { exact: true }).fill('写作资料');
  await rss.getByRole('button', { name: '添加订阅', exact: true }).click();
  await expect(rss.getByText('写作资料', { exact: true })).toBeVisible();
  const search = page.getByRole('region', { name: 'Tavily 搜索配置', exact: true });
  const key = search.getByLabel('Tavily API Key', { exact: true });
  await key.fill('workspace-fake-search-key');
  await search.getByRole('checkbox', { name: '清除 Tavily 密钥', exact: true }).check();
  await expect(key).toHaveValue('');
  await expect(key).toBeDisabled();
  await search.getByRole('button', { name: '保存 Tavily 搜索配置', exact: true }).click();
  await expect(search.getByText('未配置密钥', { exact: true })).toBeVisible();
  await expect(key).toHaveValue('');
  expect(fixture.writes.map((write) => write.path)).toEqual([
    '/sources/feeds',
    '/sources/search-config',
  ]);
  expect(fixture.writes[1]?.body).toEqual({
    baseUrl: 'https://search.example.com',
    clearApiKey: true,
  });
  expect(fixture.unexpected).toEqual([]);
});
