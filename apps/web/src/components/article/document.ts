import { Node } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { safeHttpUrl } from '@tattoo/contracts';

const assetIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const assetUrl = (id: string) => `/api/v1/assets/${id}`;

// Only an asset reference is persisted. Browser URLs are derived at render time.
export const LocalImage = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      assetId: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-asset-id'),
      },
      alt: { default: '', parseHTML: (element: HTMLElement) => element.getAttribute('alt') ?? '' },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'img[data-asset-id]',
        getAttrs: (element: HTMLElement) =>
          assetIdPattern.test(element.getAttribute('data-asset-id') ?? '') ? {} : false,
      },
    ];
  },
  renderHTML({ node }) {
    return [
      'img',
      {
        'data-asset-id': node.attrs.assetId,
        src: assetUrl(String(node.attrs.assetId)),
        alt: node.attrs.alt,
      },
    ];
  },
});

export const WritingKit = StarterKit.extend({
  addExtensions() {
    return (this.parent?.() ?? []).map((extension) => {
      if (extension.name === 'link')
        return extension.extend({
          addAttributes() {
            return {
              href: {
                default: null,
                parseHTML: (element: HTMLElement) => element.getAttribute('href'),
              },
            };
          },
        });
      if (extension.name === 'orderedList')
        return extension.extend({
          addAttributes() {
            return {
              start: {
                default: 1,
                parseHTML: (element: HTMLElement) =>
                  element.hasAttribute('start') ? Number(element.getAttribute('start')) : 1,
              },
            };
          },
        });
      return extension;
    });
  },
});

export const isSafeLink = (href: string) => safeHttpUrl.safeParse(href).success;

// Unknown structures are rejected as a whole, giving the writer a chance to paste plain text.
export function pasteProblem(html: string): string | null {
  if (new TextEncoder().encode(html).byteLength > 2 * 1024 * 1024)
    return '粘贴内容超过 2 MiB，请分段粘贴。';
  const parsed = document.createElement('template');
  parsed.innerHTML = html;
  const allowed = new Set([
    'P',
    'DIV',
    'SPAN',
    'BR',
    'H2',
    'H3',
    'STRONG',
    'B',
    'EM',
    'I',
    'S',
    'STRIKE',
    'DEL',
    'U',
    'UL',
    'OL',
    'LI',
    'BLOCKQUOTE',
    'PRE',
    'CODE',
    'HR',
    'A',
    'IMG',
    'META',
  ]);
  const elements = [...parsed.content.querySelectorAll('*')];
  if (elements.length > 5000) return '粘贴内容节点过多，请分段粘贴。';
  for (const element of elements) {
    if (element.tagName === 'IMG') {
      const id = element.getAttribute('data-asset-id') ?? '';
      const src = element.getAttribute('src');
      if (!assetIdPattern.test(id) || src !== assetUrl(id))
        return '粘贴内容含外链图片。请先将图片保存到本地，再用「正文图片」上传；本次粘贴未插入。';
    }
    if (!allowed.has(element.tagName))
      return '粘贴内容含暂不支持的结构。请使用 Ctrl/Cmd + Shift + V 粘贴为纯文本，再进行排版。';
    if ([...element.attributes].some((attribute) => /^on/i.test(attribute.name)))
      return '粘贴内容含事件属性，未插入。请粘贴为纯文本。';
    if (element.tagName === 'A' && !isSafeLink(element.getAttribute('href') ?? ''))
      return '正文链接只支持不含凭据的 HTTP / HTTPS 地址，本次粘贴未插入。';
    if (
      element.tagName === 'OL' &&
      element.hasAttribute('type') &&
      element.getAttribute('type') !== '1'
    )
      return '当前只支持数字有序列表，请转换列表编号后重新粘贴，或粘贴为纯文本。';
  }
  return null;
}
