import { describe, expect, it } from 'vitest';
import { createDemoApi } from '../../apps/web/src/demo/api';
import { renderDemoDocument } from '../../apps/web/src/demo/preview';
import type { Article, Revision, TopicCreationTask } from '@tattoo/contracts';

function setup() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
  return { api: createDemoApi(storage), storage, values };
}
const request = (method: string, body: unknown) => ({ method, body: JSON.stringify(body) });

describe('browser-only GitHub Pages demo', () => {
  it('persists independent revisions across reloads and rejects stale saves', async () => {
    const { api, storage } = setup();
    const list = (await api('/articles')) as { items: Article[] };
    const original = list.items[0]!;
    const saved = (await api(
      `/articles/${original.id}`,
      request('PATCH', { ...original, title: '本地修改', expectedVersion: 1 }),
    )) as Article;
    expect(saved.version).toBe(2);
    expect(await createDemoApi(storage)(`/articles/${original.id}`)).toEqual(saved);
    const history = (await api(`/articles/${original.id}/revisions`)) as { items: Revision[] };
    expect(history.items.map((item) => item.title)).toEqual(['本地修改', original.title]);
    await expect(
      api(`/articles/${original.id}`, request('PATCH', { ...original, expectedVersion: 1 })),
    ).rejects.toMatchObject({ status: 409 });
    const unchanged = (await api(
      `/articles/${saved.id}`,
      request('PATCH', { ...saved, expectedVersion: 2 }),
    )) as Article;
    expect(unchanged.revisionId).toBe(saved.revisionId);
  });

  it('never stores credentials or submits remote actions', async () => {
    const { api, values } = setup();
    for (const path of [
      '/ai/models/text',
      '/accounts',
      '/sources/search-config',
      '/auth/password',
      '/deliveries',
      '/accounts/demo/verify',
      '/sources/jobs',
    ]) {
      await expect(
        api(path, request('POST', { apiKey: 'real-secret', password: 'real-password' })),
      ).rejects.toMatchObject({ code: 'DEMO_DISABLED' });
    }
    expect([...values.values()].join('')).not.toContain('real-secret');
    expect(values.size).toBe(0);
    await expect(api('/unknown')).rejects.toMatchObject({ status: 404 });
  });

  it('creates one topic article for repeated request keys', async () => {
    const { api } = setup();
    const input = request('POST', { topic: '周末写作', requestKey: crypto.randomUUID() });
    const task = (await api('/ai/topics', input)) as TopicCreationTask;
    expect(await api('/ai/topics', input)).toEqual(task);
    expect(task.state).toBe('SUCCEEDED');
    expect(await api('/articles')).toMatchObject({ total: 4 });
    expect(await api(`/articles/${task.articleId}`)).toMatchObject({
      title: '周末写作（演示示例）',
    });
  });

  it('reports storage failures without accepting a lost save', async () => {
    const { api, storage } = setup();
    const { items } = (await api('/articles')) as { items: Article[] };
    storage.setItem = () => {
      throw new Error('quota exceeded');
    };
    await expect(
      api('/articles', request('POST', { ...items[0], title: '无法保存' })),
    ).rejects.toMatchObject({ status: 507 });
    expect(await api('/articles')).toMatchObject({ total: 3 });
  });

  it('escapes article text and rejects executable document attributes', () => {
    const html = renderDemoDocument({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script>' }] },
      ],
    });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(() =>
      renderDemoDocument({
        type: 'doc',
        content: [{ type: 'image', attrs: { assetId: 'javascript:alert(1)' } }],
      }),
    ).toThrow();
  });
});
