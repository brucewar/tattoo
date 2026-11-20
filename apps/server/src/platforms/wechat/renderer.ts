import { safeHttpUrl, type DocumentNode } from '@tattoo/contracts';
import { ContentError, inspectDocument } from '../../content/document';
import { isWechatImageUrl } from './image-url';

export const RENDER_VERSION = 'wechat-editorial-v2';
const escape = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export function renderDocument(doc: DocumentNode, imageUrls: Record<string, string> = {}): string {
  inspectDocument(doc);
  function render(n: DocumentNode): string {
    const children = () => (n.content ?? []).map(render).join('');
    switch (n.type) {
      case 'doc':
        return `<section style="font-size:16px;line-height:1.85;color:#303735;word-break:break-word;">${children()}</section>`;
      case 'text': {
        let value = escape(n.text ?? '');
        for (const mark of n.marks ?? []) {
          if (mark.type === 'bold') value = `<strong>${value}</strong>`;
          if (mark.type === 'italic') value = `<em>${value}</em>`;
          if (mark.type === 'strike') value = `<s>${value}</s>`;
          if (mark.type === 'underline') value = `<u>${value}</u>`;
          if (mark.type === 'code')
            value = `<code style="background:#f0f3f2;padding:2px 5px;font-family:monospace;">${value}</code>`;
          if (mark.type === 'link') {
            const href = String(mark.attrs?.href ?? '');
            value += ` <span style="font-size:12px;color:#758078;">[${escape(href)}]</span>`;
          }
        }
        return value;
      }
      case 'paragraph':
        return `<p style="margin:0 0 18px;">${children() || '<br>'}</p>`;
      case 'heading': {
        const level = Number(n.attrs?.level);
        return `<h${level} style="font-size:${level === 2 ? 22 : 18}px;line-height:1.5;margin:30px 0 16px;font-weight:700;color:#182f26;">${children()}</h${level}>`;
      }
      case 'bulletList':
        return `<ul style="padding-left:24px;">${children()}</ul>`;
      case 'orderedList':
        return `<ol start="${n.attrs?.start ?? 1}" style="padding-left:24px;">${children()}</ol>`;
      case 'listItem':
        return `<li style="margin-bottom:8px;">${children()}</li>`;
      case 'blockquote':
        return `<blockquote style="border-left:3px solid #507d69;padding:8px 16px;margin:24px 0;background:#f4f7f5;color:#59675f;">${children()}</blockquote>`;
      case 'codeBlock':
        return `<pre style="white-space:pre-wrap;word-break:break-all;padding:18px;background:#f1f4f3;border-radius:6px;font-size:13px;line-height:1.7;"><code>${children()}</code></pre>`;
      case 'hardBreak':
        return '<br>';
      case 'horizontalRule':
        return '<hr style="border:0;border-top:1px solid #e4e9e6;margin:28px 0;">';
      case 'image': {
        const url = imageUrls[String(n.attrs?.assetId)] ?? `/api/v1/assets/${n.attrs?.assetId}`;
        if (
          !(url.startsWith('https://') && safeHttpUrl.safeParse(url).success) &&
          !isWechatImageUrl(url) &&
          !/^\/api\/v1\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            url,
          )
        )
          throw new ContentError('图片地址无效');
        return `<img src="${escape(url)}" alt="${escape(String(n.attrs?.alt ?? ''))}" style="display:block;max-width:100%;height:auto;margin:20px auto;">`;
      }
      default:
        throw new ContentError('正文格式不支持');
    }
  }
  return render(doc);
}
// Numeric rules are centralized in limits.ts; optional explicit limits support boundary tests.
export type WechatLimits = {
  titleCharacters: number;
  digestCharacters: number;
  authorCharacters: number;
  htmlCharacters: number;
  htmlBytes: number;
  sourceUrlBytes?: number;
};
export function validateWechat(
  input: {
    title: string;
    digest: string;
    author: string;
    coverId: string | null;
    document: DocumentNode;
    sourceUrl?: string;
  },
  limits: WechatLimits,
  finalHtml?: string,
) {
  const problems: string[] = [];
  if (!input.title.trim()) problems.push('请填写标题');
  if (input.title.length > limits.titleCharacters) problems.push('标题超出公众号限制');
  if (input.digest.length > limits.digestCharacters) problems.push('摘要超出公众号限制');
  if (input.author.length > limits.authorCharacters) problems.push('作者超出公众号限制');
  if (
    limits.sourceUrlBytes !== undefined &&
    Buffer.byteLength(input.sourceUrl ?? '', 'utf8') > limits.sourceUrlBytes
  )
    problems.push('原文链接超出公众号限制');
  if (!input.coverId) problems.push('请上传文章封面');
  const info = inspectDocument(input.document);
  if (!info.text.trim() && !info.assetIds.length) problems.push('正文不能为空');
  const html = finalHtml ?? renderDocument(input.document);
  if (html.length >= limits.htmlCharacters || Buffer.byteLength(html, 'utf8') >= limits.htmlBytes)
    problems.push('排版后的正文超出公众号限制');
  return problems;
}
