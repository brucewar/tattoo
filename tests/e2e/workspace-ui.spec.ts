import { expect, test, type Page } from '@playwright/test';
import type { Article, ArticleInput, ArticlePreview } from '@tattoo/contracts';

test.skip(process.env.TATTOO_E2E_TEST_MODE !== '1', '需要隔离的前端验证环境');

type WorkspaceFixture = {
  writes: ArticleInput[];
  unexpected: string[];
  saved: Article | null;
};

async function workspaceFixture(
  page: Page,
  options: { loggedIn?: boolean; expireFirstSave?: boolean } = {},
): Promise<WorkspaceFixture> {
  let loggedIn = options.loggedIn ?? true;
  let expireFirstSave = options.expireFirstSave ?? false;
  const fixture: WorkspaceFixture = { writes: [], unexpected: [], saved: null };
  const emptyPage = { items: [], total: 0, page: 1, pageSize: 20 };
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    let data: unknown;
    if (path === '/api/v1/auth/me') {
      if (!loggedIn) {
        await route.fulfill({
          status: 401,
          json: { error: { message: '请先登录', code: 'UNAUTHORIZED' } },
        });
        return;
      }
      data = { id: 'ui-demo-admin', email: 'demo@example.com', remoteWritesEnabled: false };
    } else if (path === '/api/v1/auth/login' && method === 'POST') {
      loggedIn = true;
      data = { id: 'ui-demo-admin', email: 'demo@example.com' };
    } else if (path === '/api/v1/articles' && method === 'GET') {
      data = {
        ...emptyPage,
        items: fixture.saved ? [fixture.saved] : [],
        total: fixture.saved ? 1 : 0,
      };
    } else if (
      (path === '/api/v1/articles' && method === 'POST') ||
      (path === '/api/v1/articles/ui-demo-article' && method === 'PATCH')
    ) {
      if (expireFirstSave) {
        expireFirstSave = false;
        loggedIn = false;
        await route.fulfill({
          status: 401,
          json: { error: { message: '会话已过期', code: 'UNAUTHORIZED' } },
        });
        return;
      }
      const input = request.postDataJSON() as ArticleInput;
      fixture.writes.push(input);
      const version = (fixture.saved?.version ?? 0) + 1;
      fixture.saved = {
        ...input,
        id: 'ui-demo-article',
        version,
        revisionId: `ui-demo-revision-${version}`,
        updatedAt: '2026-11-28T03:20:00.000Z',
      };
      data = fixture.saved;
    } else if (path === '/api/v1/articles/ui-demo-article' && method === 'GET') {
      data = fixture.saved;
    } else if (path === '/api/v1/articles/ui-demo-article/revisions' && method === 'GET') {
      data = {
        ...emptyPage,
        total: fixture.saved ? 1 : 0,
        items: fixture.saved
          ? [
              {
                id: fixture.saved.revisionId,
                articleId: fixture.saved.id,
                version: fixture.saved.version,
                title: fixture.saved.title,
                createdAt: fixture.saved.updatedAt,
              },
            ]
          : [],
      };
    } else if (
      path === '/api/v1/articles/ui-demo-article/revisions/ui-demo-revision-1' &&
      method === 'GET'
    ) {
      data = {
        ...fixture.saved,
        id: 'ui-demo-revision-1',
        articleId: 'ui-demo-article',
        createdAt: fixture.saved?.updatedAt,
      };
    } else if (path === '/api/v1/articles/ui-demo-article/preview' && method === 'POST') {
      data = {
        revisionId: fixture.saved?.revisionId ?? 'ui-demo-revision-1',
        version: fixture.saved?.version ?? 1,
        renderVersion: 'ui-fixture',
        html: '<p>把写作留给正文，把准备留在自己的工作台。</p>',
        warnings: [],
        platformLimitsVerified: true,
      } satisfies ArticlePreview;
    } else if (
      method === 'GET' &&
      ['/api/v1/accounts', '/api/v1/deliveries', '/api/v1/ai/jobs'].includes(path)
    ) {
      data = emptyPage;
    } else if (path === '/api/v1/ai/models' && method === 'GET') {
      data = { text: null, image: null };
    } else {
      fixture.unexpected.push(`${method} ${path}`);
      await route.fulfill({
        status: 404,
        json: { error: { message: '未配置的界面验证请求', code: 'UI_FIXTURE_NOT_FOUND' } },
      });
      return;
    }
    await route.fulfill({ json: { data } });
  });
  return fixture;
}

async function chooseTheme(page: Page, label: '浅色' | '深色' | '跟随系统') {
  await page.getByRole('combobox', { name: '外观主题', exact: true }).click();
  await page.getByRole('option', { name: label, exact: true }).click();
}

async function expectTheme(page: Page, theme: 'light' | 'dark') {
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
}

async function createDraft(page: Page, title = '把灵感留在自己的工作台') {
  await page.goto('/');
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill(title);
  await page
    .getByRole('textbox', { name: '文章正文', exact: true })
    .fill('今天先写下一段完整的话。');
}

async function expectNoPageOverflow(page: Page) {
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  ).toBe(true);
}

test('默认跟随系统，系统变化即时生效，手动选择后保持用户偏好', async ({ page }) => {
  const fixture = await workspaceFixture(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expectTheme(page, 'dark');
  await expect(page.getByRole('combobox', { name: '外观主题' })).toContainText('跟随系统');
  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme(page, 'light');
  await chooseTheme(page, '深色');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme(page, 'dark');
  expect(fixture.unexpected).toEqual([]);
});

test('浅色和深色选择刷新后保留，跟随系统可恢复自动切换', async ({ page }) => {
  const fixture = await workspaceFixture(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/');
  await chooseTheme(page, '深色');
  await page.reload();
  await expectTheme(page, 'dark');
  await expect(page.getByRole('combobox', { name: '外观主题' })).toContainText('深色');
  await chooseTheme(page, '浅色');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await expectTheme(page, 'light');
  await chooseTheme(page, '跟随系统');
  await expectTheme(page, 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expectTheme(page, 'light');
  expect(fixture.unexpected).toEqual([]);
});

for (const mode of ['invalid', 'blocked'] as const) {
  test(`外观存储${mode === 'invalid' ? '无效' : '被拒绝'}时继续使用并允许切换`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const fixture = await workspaceFixture(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.addInitScript((storageMode) => {
      if (storageMode === 'invalid') localStorage.setItem('tattoo:theme', 'unknown-theme');
      else {
        Object.defineProperty(Storage.prototype, 'getItem', {
          configurable: true,
          value() {
            throw new DOMException('Storage disabled for UI test', 'SecurityError');
          },
        });
        Object.defineProperty(Storage.prototype, 'setItem', {
          configurable: true,
          value() {
            throw new DOMException('Storage disabled for UI test', 'SecurityError');
          },
        });
      }
    }, mode);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '内容', exact: true })).toBeVisible();
    await expectTheme(page, 'dark');
    await chooseTheme(page, '浅色');
    await expectTheme(page, 'light');
    await page.getByRole('button', { name: '新建文章', exact: true }).click();
    await page.getByLabel('标题', { exact: true }).fill('存储不可用时也可以写作');
    await page.getByRole('button', { name: '保存文章', exact: true }).click();
    await expect(page.getByRole('status')).toHaveText('已保存 · 修订 v1');
    expect(errors).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  });
}

test('主题初始化不依赖 React 应用挂载，登录页也可选择外观', async ({ page }) => {
  await workspaceFixture(page, { loggedIn: false });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(() => localStorage.setItem('tattoo:theme', 'dark'));
  const mainEntry = (url: URL) => url.pathname === '/src/main.tsx';
  await page.route(mainEntry, (route) => route.abort());
  await page.goto('/');
  await expectTheme(page, 'dark');
  await expect(page.locator('#root')).toBeEmpty();
  await page.unroute(mainEntry);
  await page.reload();
  await expect(page.getByRole('heading', { name: '登录工作台', exact: true })).toBeVisible();
  await chooseTheme(page, '浅色');
  await expectTheme(page, 'light');
});

test('切换主题和专注写作保留正文与未保存字段，离开仍先提醒', async ({ page }) => {
  const fixture = await workspaceFixture(page);
  await createDraft(page);
  const author = page.getByLabel('作者', { exact: true });
  await author.fill('独立创作者');
  await page.getByLabel('摘要', { exact: true }).fill('把准备留在工作台，把注意力留给写作。');
  await chooseTheme(page, '深色');
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue('把灵感留在自己的工作台');
  await expect(author).toHaveValue('独立创作者');
  await expect(page.getByRole('textbox', { name: '文章正文', exact: true })).toContainText(
    '今天先写下一段完整的话。',
  );
  await expect(page.getByRole('status')).toContainText('未保存');
  await page.getByRole('button', { name: '专注写作', exact: true }).click();
  await expect(author).not.toBeVisible();
  await expect(page.getByRole('textbox', { name: '文章正文', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '退出专注写作', exact: true }).click();
  await expect(author).toHaveValue('独立创作者');
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '投递记录', exact: true }).click();
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue('把灵感留在自己的工作台');
  expect(fixture.writes).toHaveLength(0);
  expect(fixture.unexpected).toEqual([]);
});

test('快捷保存与按钮一致，弹窗限制保存且键盘焦点不泄露到背景', async ({ page }) => {
  const fixture = await workspaceFixture(page);
  await createDraft(page, '写作是一件可以慢慢完成的事');
  await page.getByLabel('标题', { exact: true }).press('ControlOrMeta+s');
  await expect(page.getByRole('status')).toHaveText('已保存 · 修订 v1');
  expect(fixture.writes).toHaveLength(1);
  await page.getByLabel('标题', { exact: true }).fill('写作是一件可以慢慢完成的事，先留下草稿');
  const trigger = page.getByRole('button', { name: '修订历史', exact: true });
  await trigger.click();
  const history = page.getByRole('dialog', { name: '修订历史', exact: true });
  await expect(history).toBeVisible();
  await expect
    .poll(() => history.evaluate((dialog) => dialog.contains(document.activeElement)))
    .toBe(true);
  for (let step = 0; step < 8; step++) {
    await page.keyboard.press('Tab');
    expect(await history.evaluate((dialog) => dialog.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('ControlOrMeta+s');
  await expect(history).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(history).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.getByLabel('标题', { exact: true }).press('ControlOrMeta+s');
  await expect(page.getByRole('status')).toHaveText('已保存 · 修订 v2');
  expect(fixture.writes).toHaveLength(2);
  expect(fixture.saved?.title).toBe('写作是一件可以慢慢完成的事，先留下草稿');
  expect(fixture.unexpected).toEqual([]);
});

test('会话过期后重新登录仍保留当前编辑，未偷偷写入', async ({ page }) => {
  const fixture = await workspaceFixture(page, { expireFirstSave: true });
  await createDraft(page, '重新登录后继续写作');
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  const reauth = page.getByRole('dialog', { name: '会话已过期，请重新登录', exact: true });
  await expect(reauth).toBeVisible();
  await expect(reauth.getByLabel('管理员邮箱', { exact: true })).toHaveValue('demo@example.com');
  await reauth.getByLabel('密码', { exact: true }).fill('local-ui-fixture-password');
  await reauth.getByRole('button', { name: '登录', exact: true }).click();
  await expect(reauth).not.toBeVisible();
  await expect(page.getByLabel('标题', { exact: true })).toHaveValue('重新登录后继续写作');
  await expect(page.getByRole('textbox', { name: '文章正文', exact: true })).toContainText(
    '今天先写下一段完整的话。',
  );
  expect(fixture.writes).toHaveLength(0);
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存 · 修订 v1');
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
});

test('会话失效以不透明遮罩覆盖已有Portal，重登后预览仍保留', async ({ page }) => {
  const fixture = await workspaceFixture(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await createDraft(page, '只有重新验证后才能继续查看的预览');
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存 · 修订 v1');
  await page.getByRole('button', { name: '微信预览', exact: true }).click();
  const preview = page.getByRole('dialog', { name: '微信预览 · 修订 v1', exact: true });
  await expect(preview).toBeVisible();
  const previewBounds = await preview.boundingBox();
  expect(previewBounds).not.toBeNull();
  const point = { x: previewBounds!.x + 24, y: previewBounds!.y + 80 };
  expect(
    await page.evaluate(
      ({ x, y }) =>
        document
          .elementFromPoint(x, y)
          ?.closest('[data-slot="dialog-content"]')
          ?.classList.contains('article-preview-modal'),
      point,
    ),
  ).toBe(true);

  await page.evaluate(() => window.dispatchEvent(new Event('tattoo:unauthorized')));
  const reauth = page.getByRole('dialog', { name: '会话已过期，请重新登录', exact: true });
  await expect(reauth).toBeVisible();
  const reauthBounds = await reauth.boundingBox();
  expect(reauthBounds).not.toBeNull();
  expect(point.x).toBeLessThan(reauthBounds!.x);
  const scrim = page.locator('[data-ui="session-expired-scrim"]');
  await expect(scrim).toHaveCSS('opacity', '1');
  const alpha = await scrim.evaluate((element) => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.fillStyle = getComputedStyle(element).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3];
  });
  expect(alpha).toBe(255);
  await expect
    .poll(() =>
      page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.getAttribute('data-ui'), point),
    )
    .toBe('session-expired-scrim');
  await expect(page.locator('.article-preview-modal')).toHaveCount(1);

  await reauth.getByLabel('密码', { exact: true }).fill('local-ui-fixture-password');
  await reauth.getByRole('button', { name: '登录', exact: true }).click();
  await expect(reauth).not.toBeVisible();
  await expect(scrim).toHaveCount(0);
  await expect(preview).toBeVisible();
  await expect(
    preview.getByRole('heading', { name: '只有重新验证后才能继续查看的预览', exact: true }),
  ).toBeVisible();
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
});

test('深色工作台的微信预览保留浅色阅读画布，外观切换不改变文章', async ({ page }) => {
  const fixture = await workspaceFixture(page);
  await createDraft(page, '一份可以带走的写作草稿');
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存 · 修订 v1');
  await chooseTheme(page, '深色');
  const previewTrigger = page.getByRole('button', { name: '微信预览', exact: true });
  await previewTrigger.click();
  const preview = page.getByRole('dialog', { name: '微信预览 · 修订 v1', exact: true });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole('button', { name: '关闭弹窗', exact: true })).toBeFocused();
  await expect(preview.getByRole('heading', { name: '一份可以带走的写作草稿' })).toBeVisible();
  await expect(preview.getByText('固定公众号排版的近似效果，最终以微信后台为准。')).toBeVisible();
  await expect(preview.locator('.preview-paper')).toHaveCSS(
    'background-color',
    'rgb(255, 255, 255)',
  );
  const body = page.frameLocator('iframe[title="微信正文预览"]').locator('body');
  await expect(body).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(body).toHaveCSS('color', 'rgb(34, 34, 34)');
  await expect(body).toContainText('把写作留给正文，把准备留在自己的工作台。');
  await preview.locator('iframe[title="微信正文预览"]').focus();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
  await page.keyboard.press('Escape');
  await expect(preview).not.toBeVisible();
  await expect(previewTrigger).toBeFocused();
  const historyTrigger = page.getByRole('button', { name: '修订历史', exact: true });
  await historyTrigger.click();
  const history = page.getByRole('dialog', { name: '修订历史', exact: true });
  await history.getByRole('button', { name: '查看 v1', exact: true }).click();
  const historical = page.getByRole('dialog', { name: '历史修订 v1 · 只读', exact: true });
  await expect(historical).toBeVisible();
  await historical.locator('iframe[title="微信正文预览"]').focus();
  await page.keyboard.press('Escape');
  await expect(historical).not.toBeVisible();
  await expect(history).toBeVisible();
  await expect
    .poll(() => history.evaluate((dialog) => dialog.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect(history).not.toBeVisible();
  await expect(historyTrigger).toBeFocused();
  await chooseTheme(page, '浅色');
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.saved?.title).toBe('一份可以带走的写作草稿');
  expect(fixture.unexpected).toEqual([]);
});

test('390px 下导航、主要操作和编辑可达，无整页横向溢出', async ({ page }) => {
  const fixture = await workspaceFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '内容', exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '投递记录', exact: true }).click();
  await expect(page.getByRole('heading', { name: '投递记录', exact: true })).toBeVisible();
  await expect(page.getByText('还没有投递记录', { exact: true })).toBeVisible();
  await expectNoPageOverflow(page);
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByRole('button', { name: '内容', exact: true }).click();
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('在手机上也能随时留下灵感');
  await page
    .getByRole('textbox', { name: '文章正文', exact: true })
    .fill('先写下来，稍后继续整理。');
  await expectNoPageOverflow(page);
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存 · 修订 v1');
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.unexpected).toEqual([]);
});
