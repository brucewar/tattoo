import { initialDocument, type ArticleInput } from '@tattoo/contracts';

export const blankArticle = (): ArticleInput => ({
  title: '',
  author: '',
  digest: '',
  sourceUrl: '',
  coverId: null,
  document: structuredClone(initialDocument),
});
export const fields = (article: ArticleInput): ArticleInput => ({
  title: article.title,
  author: article.author,
  digest: article.digest,
  sourceUrl: article.sourceUrl,
  coverId: article.coverId,
  document: article.document,
});
export const fingerprint = (value: ArticleInput) => JSON.stringify(fields(value));
