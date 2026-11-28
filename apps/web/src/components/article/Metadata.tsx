import { Button, Input } from '../ui';
import type { Article, ArticleInput } from '@tattoo/contracts';
import { WECHAT_DIGEST_MAX_LENGTH } from '@tattoo/contracts';
import { date } from '../../ui';
import { assetUrl } from './document';
import { isDemo } from '../../demo/mode';

export function ArticleMetadata({
  draft,
  article,
  disabled,
  onChange,
  onCover,
  onRemoveCover,
}: {
  draft: ArticleInput;
  article: Article | null;
  disabled: boolean;
  onChange: (key: keyof Omit<ArticleInput, 'document' | 'coverId'>, value: string) => void;
  onCover: () => void;
  onRemoveCover: () => void;
}) {
  const digestLength = draft.digest.length;
  const digestOverflow = Math.max(0, digestLength - WECHAT_DIGEST_MAX_LENGTH);
  return (
    <aside className="surface article-metadata" aria-label="文章信息">
      <h2>文章信息</h2>
      <p className="secondary">不完整的稿件也可以先保存。</p>
      <div className="metadata-field">
        <label htmlFor="article-author">作者</label>
        <Input
          id="article-author"
          value={draft.author}
          disabled={disabled}
          onChange={(event) => onChange('author', event.target.value)}
        />
      </div>
      <div className="metadata-field">
        <label htmlFor="article-digest">摘要</label>
        <Input.TextArea
          id="article-digest"
          rows={4}
          value={draft.digest}
          disabled={disabled}
          status={digestOverflow ? 'error' : undefined}
          aria-invalid={digestOverflow > 0 || undefined}
          aria-describedby="article-digest-help"
          onChange={(event) => onChange('digest', event.target.value)}
        />
        <p
          id="article-digest-help"
          className={`digest-hint${digestOverflow ? ' is-over-limit' : ''}`}
          title="按公众号字符限制计数，部分 emoji 会占多个字符。"
          aria-live="polite"
        >
          {digestLength} / {WECHAT_DIGEST_MAX_LENGTH} 字符（含标点）
          {digestOverflow > 0 && (
            <span>超出 {digestOverflow} 字符，投递前请缩短摘要；当前仍可保存。</span>
          )}
        </p>
      </div>
      <div className="metadata-field">
        <label htmlFor="article-source">原文链接</label>
        <Input
          id="article-source"
          placeholder="https://"
          value={draft.sourceUrl}
          disabled={disabled}
          onChange={(event) => onChange('sourceUrl', event.target.value)}
        />
        <p className="form-note">仅支持 HTTP / HTTPS，正文外链在预览中显示为文字与网址。</p>
      </div>
      <div className="metadata-field">
        <span className="field-label">文章封面</span>
        {draft.coverId ? (
          <img className="article-cover" src={assetUrl(draft.coverId)} alt="文章封面" />
        ) : (
          <div className="cover-empty">尚未选择封面</div>
        )}
        <div className="cover-actions">
          <Button onClick={onCover} disabled={disabled}>
            {draft.coverId ? '更换封面' : '上传封面'}
          </Button>
          {draft.coverId && (
            <Button type="text" disabled={disabled} onClick={onRemoveCover}>
              移除封面
            </Button>
          )}
        </div>
        <p className="form-note">
          {isDemo
            ? 'JPG / PNG，单张不超过 2 MiB，仅保存在当前浏览器。'
            : 'JPG / PNG，单张不超过 10 MiB、2000 万像素。图片读取需要登录。'}
        </p>
      </div>
      {article && (
        <p className="saved-at">
          最近保存
          <br />
          <strong>{date(article.updatedAt)}</strong>
        </p>
      )}
    </aside>
  );
}
