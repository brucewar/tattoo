import { describe, expect, it } from 'vitest';
import {
  articleInput,
  documentSchema,
  type DocumentNode,
} from '../../packages/contracts/src/index';
import { renderDocument } from '../../apps/server/src/content/render';

describe('结构化稿件', () => {
  it('允许不完整稿件保存并提供默认标题', () => {
    const result = articleInput.parse({ title: '', document: { type: 'doc', content: [] } });
    expect(result.title).toBe('未命名文章');
    expect(result.coverId).toBeNull();
  });
  it('在递归解析前拒绝过深文档', () => {
    let document: DocumentNode = { type: 'text', text: 'test' };
    for (let i = 0; i < 10000; i++) document = { type: 'paragraph', content: [document] };
    expect(documentSchema.safeParse({ type: 'doc', content: [document] }).success).toBe(false);
  });
  it('文本进行 HTML 转义且未知节点不静默丢失', () => {
    const rendered = renderDocument({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: '<script>alert(1)</script>' }] },
      ],
    });
    expect(rendered).not.toContain('<script>');
    expect(rendered).toContain('&lt;script&gt;');
    expect(() => renderDocument({ type: 'doc', content: [{ type: 'unknown-widget' }] })).toThrow(
      '不支持',
    );
  });
  it('本地预览素材使用统一版本化接口', () => {
    const id = '078e32a9-9e61-462f-8dd5-c59ab916296b';
    expect(
      renderDocument({ type: 'doc', content: [{ type: 'image', attrs: { assetId: id } }] }),
    ).toContain(`/api/v1/assets/${id}`);
  });
});
