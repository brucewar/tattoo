import { useEffect, useState } from 'react';
import { Alert, Button, Empty, Pagination, Spin } from '../components/ui';
import { FileText, Plus, Sparkle, ArrowUpRight } from '@phosphor-icons/react';
import type { ArticleSummary } from '@tattoo/contracts';
import { api, errorMessage } from '../api';
import { date, type Page } from '../ui';
import { ArticleEditor } from '../components/ArticleEditor';
import { TopicCreation } from '../components/ai/TopicCreation';

export function Content({
  onDirtyChange,
  remoteWritesEnabled,
  onInspectRecords,
  onConfigureModels,
}: {
  onDirtyChange: (dirty: boolean) => void;
  remoteWritesEnabled: boolean;
  onInspectRecords: () => void;
  onConfigureModels: () => void;
}) {
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [items, setItems] = useState<ArticleSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creatingTopic, setCreatingTopic] = useState(false);
  useEffect(() => {
    if (selected !== undefined) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<Page<ArticleSummary>>(`/articles?page=${page}&pageSize=20`, { signal: controller.signal })
      .then((result) => {
        setItems(result.items);
        setTotal(result.total);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [selected, page, version]);
  if (selected !== undefined)
    return (
      <ArticleEditor
        key={selected ?? 'new'}
        id={selected}
        onDirtyChange={onDirtyChange}
        remoteWritesEnabled={remoteWritesEnabled}
        onInspectRecords={onInspectRecords}
        onConfigureModels={onConfigureModels}
        onBack={() => {
          setSelected(undefined);
          setVersion((current) => current + 1);
        }}
      />
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>内容</h1>
          <p className="secondary">从一个想法开始，把内容留在自己的工作台。</p>
        </div>
        <div className="heading-actions">
          <Button
            type="primary"
            icon={<Sparkle aria-hidden />}
            onClick={() => setCreatingTopic(true)}
          >
            主题创作
          </Button>
          <Button icon={<Plus aria-hidden />} onClick={() => setSelected(null)}>
            新建文章
          </Button>
        </div>
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          action={
            <Button size="small" onClick={() => setVersion((current) => current + 1)}>
              重新加载
            </Button>
          }
        />
      )}
      <div className="surface content-surface">
        <div className="content-list-header">
          <span>
            全部文章 <span className="list-count">{total}</span>
          </span>
          <span className="secondary">明确保存 · 修订可追溯</span>
        </div>
        {loading ? (
          <div className="loading-panel">
            <Spin />
            <p className="secondary">正在读取文章…</p>
          </div>
        ) : error && !items.length ? (
          <div className="loading-panel">
            <p className="secondary">文章暂时无法显示，请重新加载。</p>
          </div>
        ) : !items.length ? (
          <div className="empty-content">
            <Empty description="还没有文章" />
            <p className="secondary">输入一个主题，让 AI 生成文章和封面；也可以新建文章自己写。</p>
          </div>
        ) : (
          <div className="content-list">
            <div className="list-column-heading content-columns" aria-hidden="true">
              <span>文章</span>
              <span>修订</span>
              <span>操作</span>
            </div>
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="content-row"
                onClick={() => setSelected(item.id)}
              >
                <FileText className="content-file-icon" size={20} aria-hidden />
                <div>
                  <strong>{item.title}</strong>
                  <span className="secondary">保存于 {date(item.updatedAt)}</span>
                </div>
                <span className="revision-pill">v{item.version}</span>
                <span className="content-open">
                  继续编辑 <ArrowUpRight size={14} aria-hidden />
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {total > 20 && (
        <Pagination
          className="pagination"
          current={page}
          pageSize={20}
          total={total}
          showSizeChanger={false}
          onChange={setPage}
        />
      )}
      <TopicCreation
        open={creatingTopic}
        onClose={() => {
          setCreatingTopic(false);
          setVersion((current) => current + 1);
        }}
        onOpenArticle={setSelected}
        onConfigureModels={onConfigureModels}
      />
    </>
  );
}
