import { describe, expect, it } from 'vitest';
import {
  articleInput,
  documentSchema,
  type DocumentNode,
} from '../../packages/contracts/src/index';
import { inspectDocument, renderDocument } from '../../apps/server/src/content/render';

const text = (value: string, marks?: DocumentNode['marks']): DocumentNode => ({
  type: 'text',
  text: value,
  ...(marks ? { marks } : {}),
});
const paragraph = (...content: DocumentNode[]): DocumentNode => ({ type: 'paragraph', content });
const doc = (...content: DocumentNode[]): DocumentNode => ({ type: 'doc', content });

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

  it('保留支持的格式、列表起点与图片替代文本', () => {
    const id = '078e32a9-9e61-462f-8dd5-c59ab916296b';
    const document = doc(
      { type: 'heading', attrs: { level: 2 }, content: [text('标题')] },
      paragraph(
        text(
          '样式',
          ['bold', 'italic', 'strike', 'underline'].map((type) => ({ type })),
        ),
        { type: 'hardBreak' },
        text('代码', [{ type: 'code' }]),
      ),
      {
        type: 'orderedList',
        attrs: { start: 7 },
        content: [{ type: 'listItem', content: [paragraph(text('条目'))] }],
      },
      { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph(text('列表'))] }] },
      { type: 'blockquote', content: [paragraph(text('引用'))] },
      { type: 'codeBlock', attrs: { language: null }, content: [text('<script>\ncode</script>')] },
      { type: 'horizontalRule' },
      { type: 'image', attrs: { assetId: id, alt: '" onerror="alert(1)' } },
    );
    expect(documentSchema.safeParse(document).success).toBe(true);
    expect(inspectDocument(document).assetIds).toEqual([id]);
    const html = renderDocument(document);
    expect(html).toContain('<ol start="7"');
    expect(html).toContain('<h2 ');
    expect(html).toContain('<blockquote ');
    expect(html).toContain('&lt;script&gt;\ncode&lt;/script&gt;');
    expect(html).toContain('alt="&quot; onerror=&quot;alert(1)"');
    expect(html).not.toContain('<script>');
  });

  it('正文链接显示文字和地址，不生成可执行外链', () => {
    const document = doc(
      paragraph(
        text('参考资料', [
          {
            type: 'link',
            attrs: {
              href: 'https://example.com/a?x=1&y=2',
              target: '_blank',
              rel: 'noopener noreferrer nofollow',
              class: null,
            },
          },
        ]),
      ),
    );
    const html = renderDocument(document);
    expect(html).toContain('参考资料');
    expect(html).toContain('[https://example.com/a?x=1&amp;y=2]');
    expect(html).not.toContain('<a');
  });

  it('保留 Tiptap 行内换行携带的合法文字样式', () => {
    const document = doc(
      paragraph(
        text('第一行', [{ type: 'bold' }]),
        { type: 'hardBreak', marks: [{ type: 'bold' }] },
        text('第二行', [{ type: 'bold' }]),
      ),
    );
    expect(documentSchema.safeParse(document).success).toBe(true);
    expect(renderDocument(document)).toContain(
      '<strong>第一行</strong><br><strong>第二行</strong>',
    );
    expect(
      documentSchema.safeParse(doc(paragraph({ type: 'hardBreak', marks: [{ type: 'unknown' }] })))
        .success,
    ).toBe(false);
  });

  it.each([
    ['未知节点', doc({ type: 'video' })],
    ['继承节点 constructor', doc({ type: 'constructor' })],
    ['继承节点 toString', doc({ type: 'toString' })],
    ['继承节点 __proto__', doc({ type: '__proto__' })],
    ['未知顶层属性', { ...doc(), dangerous: true }],
    ['未知节点属性', doc({ type: 'paragraph', attrs: { onclick: 'alert(1)' } })],
    ['空节点属性', { type: 'doc', content: [{ type: 'paragraph', attrs: null }] }],
    [
      '空文字样式属性',
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: '文字', marks: [{ type: 'bold', attrs: null }] }],
          },
        ],
      },
    ],
    ['未知样式', doc(paragraph(text('文字', [{ type: 'color' }])))],
    ['继承样式 constructor', doc(paragraph(text('文字', [{ type: 'constructor' }])))],
    ['继承样式 toString', doc(paragraph(text('文字', [{ type: 'toString' }])))],
    ['继承样式 __proto__', doc(paragraph(text('文字', [{ type: '__proto__' }])))],
    ['未知样式属性', doc(paragraph(text('文字', [{ type: 'bold', attrs: { color: 'red' } }])))],
    ['重复样式', doc(paragraph(text('文字', [{ type: 'bold' }, { type: 'bold' }])))],
    ['不支持的标题', doc({ type: 'heading', attrs: { level: 1 }, content: [text('标题')] })],
    ['错误层次', doc({ type: 'paragraph', content: [{ type: 'paragraph' }] })],
    ['根节点中的文字', doc(text('文字'))],
    ['列表缺少列表项', doc({ type: 'bulletList', content: [paragraph(text('文字'))] })],
    [
      '列表项缺少段落',
      doc({
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'image', attrs: { assetId: '078e32a9-9e61-462f-8dd5-c59ab916296b' } },
            ],
          },
        ],
      }),
    ],
    ['代码块中的样式', doc({ type: 'codeBlock', content: [text('代码', [{ type: 'bold' }])] })],
    ['文本中的子节点', doc(paragraph({ type: 'text', text: '文字', content: [] }))],
    ['块上的样式', doc({ type: 'paragraph', marks: [] })],
    ['图片远程地址', doc({ type: 'image', attrs: { src: 'https://example.com/image.png' } })],
    [
      '图片未知属性',
      doc({
        type: 'image',
        attrs: {
          assetId: '078e32a9-9e61-462f-8dd5-c59ab916296b',
          src: 'https://example.com/image.png',
        },
      }),
    ],
  ])('拒绝%s，避免静默丢失内容', (_name, document) => {
    expect(documentSchema.safeParse(document).success).toBe(false);
    expect(() => renderDocument(document as DocumentNode)).toThrow();
  });

  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>',
    '//example.com',
    'https://example.com/\nattack',
    'https://user:password@example.com',
  ])('拒绝危险链接 %s', (href) => {
    const document = doc(paragraph(text('链接', [{ type: 'link', attrs: { href } }])));
    expect(documentSchema.safeParse(document).success).toBe(false);
    expect(() => renderDocument(document)).toThrow();
    expect(articleInput.safeParse({ title: '', document: doc(), sourceUrl: href }).success).toBe(
      false,
    );
  });

  it('按 UTF-8 字节限制正文，允许超过未核实平台限额的安全稿件', () => {
    expect(documentSchema.safeParse(doc(paragraph(text('中'.repeat(700000))))).success).toBe(false);
    expect(
      documentSchema.safeParse(doc(...Array.from({ length: 5001 }, () => paragraph()))).success,
    ).toBe(false);
    const parsed = articleInput.parse({
      title: '题'.repeat(300),
      author: '名'.repeat(100),
      digest: '摘'.repeat(600),
      document: doc(),
    });
    expect(parsed.title.length).toBe(300);
    expect(parsed.author.length).toBe(100);
    expect(parsed.digest.length).toBe(600);
  });

  it('不能通过图片地址映射注入危险地址', () => {
    const id = '078e32a9-9e61-462f-8dd5-c59ab916296b';
    const document = doc({ type: 'image', attrs: { assetId: id } });
    expect(() => renderDocument(document, { [id]: 'javascript:alert(1)' })).toThrow('图片地址无效');
    expect(() => renderDocument(document, { [id]: 'https://example.com/\nattack' })).toThrow(
      '图片地址无效',
    );
    expect(renderDocument(document, { [id]: 'https://example.com/image?x=1&y=2' })).toContain(
      'x=1&amp;y=2',
    );
  });

  it('拒绝 JSON 中的原型属性，不能通过解析时过滤而静默接受', () => {
    for (const document of [
      JSON.parse(
        '{"type":"doc","content":[{"type":"paragraph","attrs":{"__proto__":{"unsafe":true}}}]}',
      ),
      JSON.parse(
        '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"x","marks":[{"type":"bold","attrs":{"__proto__":{"unsafe":true}}}]}]}]}',
      ),
    ]) {
      expect(documentSchema.safeParse(document).success).toBe(false);
      expect(() => renderDocument(document)).toThrow();
    }
  });

  it.each(['\u0000', '\uD800', '\uDC00'])('明确拒绝 PostgreSQL 无法存储的字符 %j', (invalid) => {
    expect(documentSchema.safeParse(doc(paragraph(text(invalid)))).success).toBe(false);
    expect(
      documentSchema.safeParse(
        doc({
          type: 'image',
          attrs: { assetId: '078e32a9-9e61-462f-8dd5-c59ab916296b', alt: invalid },
        }),
      ).success,
    ).toBe(false);
    for (const field of ['title', 'author', 'digest', 'sourceUrl']) {
      expect(articleInput.safeParse({ title: '', document: doc(), [field]: invalid }).success).toBe(
        false,
      );
    }
    expect(documentSchema.safeParse(doc(paragraph(text('有效 😀 𠮷 Unicode')))).success).toBe(true);
  });
});
