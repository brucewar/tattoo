import { expect, test } from '@playwright/test';
import type { Article, ArticleInput } from '@tattoo/contracts';

test.skip(process.env.TATTOO_E2E_TEST_MODE !== '1', '需要隔离的前端验证环境');

test('摘要提前提示微信长度限制，超限本地稿仍能完整保存', async ({ page }) => {
  let saved: Article | null = null;
  const unexpected: string[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let data: unknown;
    if (path === '/api/v1/auth/me') {
      data = { id: 'digest-demo-admin', email: 'demo@example.com', remoteWritesEnabled: false };
    } else if (path === '/api/v1/articles' && request.method() === 'GET') {
      data = { items: [], total: 0, page: 1, pageSize: 20 };
    } else if (
      (path === '/api/v1/articles' && request.method() === 'POST') ||
      (path === '/api/v1/articles/digest-demo-article' && request.method() === 'PATCH')
    ) {
      const input = request.postDataJSON() as ArticleInput;
      const version = (saved?.version ?? 0) + 1;
      saved = {
        ...input,
        id: 'digest-demo-article',
        version,
        revisionId: `digest-demo-revision-${version}`,
        updatedAt: new Date().toISOString(),
      };
      data = saved;
    } else {
      unexpected.push(`${request.method()} ${path}`);
      await route.fulfill({ status: 404, json: { error: { message: '未配置的界面验证请求' } } });
      return;
    }
    await route.fulfill({ json: { data } });
  });

  await page.goto('/');
  await page.getByRole('button', { name: '新建文章', exact: true }).click();
  await page.getByLabel('标题', { exact: true }).fill('摘要边界演示');
  const digest = page.getByLabel('摘要', { exact: true });
  const hint = page.locator('#article-digest-help');
  await expect(hint).toContainText('0 / 120');

  const longDigest = '摘'.repeat(121);
  await digest.fill(longDigest);
  await expect(hint).toContainText('121 / 120');
  await expect(hint).toContainText('超出 1 字符');
  await expect(digest).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: '保存文章', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '保存文章', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('已保存 · 修订 v1');
  expect(saved).toMatchObject({ digest: longDigest });
  await expect(digest).toHaveValue(longDigest);

  await digest.fill('摘'.repeat(118) + '😀');
  await expect(hint).toContainText('120 / 120');
  await expect(digest).not.toHaveAttribute('aria-invalid', 'true');
  await digest.fill('摘'.repeat(119) + '😀');
  await expect(hint).toContainText('121 / 120');
  await expect(digest).toHaveAttribute('aria-invalid', 'true');
  await digest.fill('');
  await expect(hint).toContainText('0 / 120');
  await expect(digest).not.toHaveAttribute('aria-invalid', 'true');
  expect(unexpected).toEqual([]);
});
