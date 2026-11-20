import { documentSchema, type DocumentNode } from '@tattoo/contracts';

export class ContentError extends Error {}
export function inspectDocument(doc: DocumentNode): { text: string; assetIds: string[] } {
  const parsed = documentSchema.safeParse(doc);
  if (!parsed.success) throw new ContentError(parsed.error.issues[0]?.message ?? '正文结构无效');
  const assets = new Set<string>(),
    texts: string[] = [],
    stack = [{ node: doc, depth: 0 }];
  let count = 0;
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (++count > 5000 || depth > 30) throw new ContentError('正文结构过深或内容过多');
    if (node.type === 'text') texts.push(node.text ?? '');
    if (node.type === 'image') {
      const id = String(node.attrs?.assetId ?? '');
      assets.add(id);
    }
    for (const child of [...(node.content ?? [])].reverse())
      stack.push({ node: child, depth: depth + 1 });
  }
  return { text: texts.join(''), assetIds: [...assets] };
}
