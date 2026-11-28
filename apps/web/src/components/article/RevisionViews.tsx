import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal, Spin, Tag } from '../ui';
import type { Article, ArticlePreview, Revision, RevisionSummary } from '@tattoo/contracts';
import { api, errorMessage, jsonRequest } from '../../api';
import { date, type Page } from '../../ui';
import { assetUrl } from './document';

export function ArticleRevisionActions({
  article,
  dirty,
  busy,
  onNotice,
  onError,
  onActivityChange,
}: {
  article: Article | null;
  dirty: boolean;
  busy: boolean;
  onNotice: (text: string) => void;
  onError: (text: string) => void;
  onActivityChange: (active: boolean) => void;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<RevisionSummary[]>([]);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historicalRevision, setHistoricalRevision] = useState<Revision | null>(null);
  const [previewSnapshot, setPreviewSnapshot] = useState<Article | Revision | null>(null);
  const [preview, setPreview] = useState<ArticlePreview | null>(null);
  const [previewTitle, setPreviewTitle] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const historyRequest = useRef<AbortController | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const previewOpener = useRef<HTMLElement | null>(null);
  useEffect(
    () => () => {
      historyRequest.current?.abort();
      previewRequest.current?.abort();
    },
    [],
  );
  useEffect(() => {
    onActivityChange(historyOpen || Boolean(preview) || previewLoading);
    return () => onActivityChange(false);
  }, [historyOpen, preview, previewLoading, onActivityChange]);
  async function openHistory(page = 1) {
    if (!article || busy || previewLoading) return;
    historyRequest.current?.abort();
    const controller = new AbortController();
    historyRequest.current = controller;
    setHistoryOpen(true);
    setHistoryLoading(true);
    setHistoryError('');
    setHistoryPage(page);
    try {
      const result = await api<Page<RevisionSummary>>(
        `/articles/${article.id}/revisions?page=${page}&pageSize=20`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted) return;
      setHistory(result.items);
      setHistoryTotal(result.total);
    } catch (failure) {
      if (!controller.signal.aborted) setHistoryError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) setHistoryLoading(false);
    }
  }

  async function openPreview(revisionId?: string) {
    if (!article || busy || previewLoading) return;
    const savedArticle = article;
    if (!revisionId && dirty) {
      onNotice('当前有未保存修改，请先保存后再预览当前文章。');
      return;
    }
    // The trigger is temporarily disabled while fetching the saved preview.
    // Capture it before that can move focus back to the document body.
    previewOpener.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    onError('');
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    setPreviewLoading(true);
    try {
      let snapshot: Article | Revision = savedArticle;
      if (revisionId)
        snapshot = await api<Revision>(`/articles/${savedArticle.id}/revisions/${revisionId}`, {
          signal: controller.signal,
        });
      const result = await api<ArticlePreview>(`/articles/${savedArticle.id}/preview`, {
        method: 'POST',
        ...jsonRequest({ revisionId: revisionId ?? savedArticle.revisionId }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setHistoricalRevision(revisionId ? (snapshot as Revision) : null);
      setHistoryOpen(false);
      setPreviewSnapshot(snapshot);
      setPreviewTitle(snapshot.title);
      setPreview(result);
    } catch (failure) {
      if (!controller.signal.aborted) onError(errorMessage(failure));
    } finally {
      if (!controller.signal.aborted) setPreviewLoading(false);
    }
  }
  function closePreview() {
    if (historicalRevision) setHistoryOpen(true);
    setPreview(null);
    setHistoricalRevision(null);
  }

  return (
    <>
      <Button onClick={() => void openHistory()} disabled={!article || busy || previewLoading}>
        修订历史
      </Button>
      <Button
        aria-label="微信预览"
        onClick={() => void openPreview()}
        loading={previewLoading}
        disabled={!article || busy || previewLoading}
      >
        微信预览
      </Button>
      <Modal
        open={historyOpen}
        title="修订历史"
        onCancel={() => {
          historyRequest.current?.abort();
          previewRequest.current?.abort();
          setPreviewLoading(false);
          setHistoryOpen(false);
        }}
        footer={null}
        width={680}
      >
        <p className="secondary">查看已保存快照。后续编辑不会覆盖这些内容。</p>
        {historyError && <Alert type="error" showIcon message={historyError} />}
        {historyLoading ? (
          <div className="loading-panel">
            <Spin />
          </div>
        ) : (
          <div className="revision-list">
            {history.map((revision) => (
              <div key={revision.id} className="revision-row">
                <div>
                  <strong>
                    修订 v{revision.version}{' '}
                    {revision.id === article?.revisionId && <Tag>当前修订</Tag>}
                  </strong>
                  <span className="revision-title">{revision.title}</span>
                  <span className="secondary">{date(revision.createdAt)}</span>
                </div>
                <Button
                  onClick={() => void openPreview(revision.id)}
                  loading={previewLoading}
                  disabled={previewLoading}
                >
                  查看 v{revision.version}
                </Button>
              </div>
            ))}
          </div>
        )}
        {historyTotal > 20 && (
          <div className="history-pages">
            <Button
              disabled={historyPage <= 1 || historyLoading}
              onClick={() => void openHistory(historyPage - 1)}
            >
              上一页
            </Button>
            <span>第 {historyPage} 页</span>
            <Button
              disabled={historyPage * 20 >= historyTotal || historyLoading}
              onClick={() => void openHistory(historyPage + 1)}
            >
              下一页
            </Button>
          </div>
        )}
      </Modal>
      <Modal
        open={Boolean(preview)}
        title={
          historicalRevision
            ? `历史修订 v${preview?.version} · 只读`
            : `微信预览 · 修订 v${preview?.version}`
        }
        width={760}
        footer={null}
        onCancel={closePreview}
        className="article-preview-modal"
        returnFocusRef={previewOpener}
      >
        <p className="secondary">固定公众号排版的近似效果，最终以微信后台为准。</p>
        {preview?.warnings.map((warning, index) => (
          <Alert key={index} type="warning" showIcon message={warning} />
        ))}
        {previewSnapshot && (
          <dl className="revision-metadata">
            <div>
              <dt>作者</dt>
              <dd>{previewSnapshot.author || '未填写'}</dd>
            </div>
            <div>
              <dt>摘要</dt>
              <dd>{previewSnapshot.digest || '未填写'}</dd>
            </div>
            <div>
              <dt>原文链接</dt>
              <dd>{previewSnapshot.sourceUrl || '未填写'}</dd>
            </div>
            <div>
              <dt>保存时间</dt>
              <dd>
                {date(
                  'createdAt' in previewSnapshot
                    ? previewSnapshot.createdAt
                    : previewSnapshot.updatedAt,
                )}
              </dd>
            </div>
            {previewSnapshot.coverId && (
              <div>
                <dt>封面</dt>
                <dd>
                  <img
                    src={assetUrl(previewSnapshot.coverId)}
                    alt={historicalRevision ? '历史修订封面' : '预览封面'}
                    className="history-cover"
                  />
                </dd>
              </div>
            )}
          </dl>
        )}
        {preview && (
          <div className="preview-paper">
            <h2>{previewTitle}</h2>
            <iframe
              title="微信正文预览"
              sandbox="allow-same-origin"
              onLoad={(event) => {
                // The existing same-origin sandbox permits the parent to bind
                // this handler; scripts inside the preview remain prohibited.
                event.currentTarget.contentDocument?.addEventListener('keydown', (key) => {
                  if (key.key === 'Escape') {
                    key.preventDefault();
                    closePreview();
                  }
                });
              }}
              srcDoc={`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="color-scheme" content="light"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><style>:root{color-scheme:light}body{margin:0;padding:0 4px;background:#fff;color:#222;font-family:system-ui,'Microsoft YaHei',sans-serif}img{max-width:100%}</style></head><body>${preview.html}</body></html>`}
            />
          </div>
        )}
      </Modal>
    </>
  );
}
