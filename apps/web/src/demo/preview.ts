import { documentSchema, type DocumentNode } from '@tattoo/contracts';

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );

// A deliberately local preview. No user-controlled HTML or external image URLs.
export function renderDemoDocument(document: DocumentNode): string {
  documentSchema.parse(document);
  const render = (node: DocumentNode): string => {
    const children = (node.content ?? []).map(render).join('');
    if (node.type === 'text') {
      let text = escape(node.text ?? '');
      for (const mark of node.marks ?? []) {
        const tag = (
          { bold: 'strong', italic: 'em', strike: 's', underline: 'u', code: 'code' } as Record<
            string,
            string
          >
        )[mark.type];
        if (tag) text = `<${tag}>${text}</${tag}>`;
        if (mark.type === 'link') text += ` [${escape(String(mark.attrs?.href ?? ''))}]`;
      }
      return text;
    }
    switch (node.type) {
      case 'doc':
        return `<section style="font-size:16px;line-height:1.85;word-break:break-word">${children}</section>`;
      case 'paragraph':
        return `<p>${children || '<br>'}</p>`;
      case 'heading':
        return `<h${node.attrs?.level}>${children}</h${node.attrs?.level}>`;
      case 'bulletList':
        return `<ul>${children}</ul>`;
      case 'orderedList':
        return `<ol start="${Number(node.attrs?.start ?? 1)}">${children}</ol>`;
      case 'listItem':
        return `<li>${children}</li>`;
      case 'blockquote':
        return `<blockquote style="border-left:3px solid #507d69;margin:24px 0;padding:8px 16px;background:#f4f7f5">${children}</blockquote>`;
      case 'codeBlock':
        return `<pre style="white-space:pre-wrap"><code>${children}</code></pre>`;
      case 'horizontalRule':
        return '<hr>';
      case 'hardBreak':
        return '<br>';
      case 'image':
        return `<p>[演示图片：${escape(String(node.attrs?.alt ?? '图片'))}，请在编辑器中查看]</p>`;
      default:
        return '';
    }
  };
  return render(document);
}
