import { useEffect, useState } from 'react';
import { Alert, Button, Empty, Pagination, Spin } from 'antd';
import type { ArticleSummary } from '@tattoo/contracts';
import { api, errorMessage } from '../api';
import { date, type Page } from '../ui';
import { ArticleEditor } from '../components/ArticleEditor';

export function Content({
  onDirtyChange,
  remoteWritesEnabled,
  onInspectRecords,
}: {
  onDirtyChange: (dirty: boolean) => void;
  remoteWritesEnabled: boolean;
  onInspectRecords: () => void;
}) {
  const [selected, setSelected] = useState<string | null | undefined>(undefined);
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [items, setItems] = useState<ArticleSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
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
          <p className="eyebrow">从一篇好内容开始</p>
          <h1>内容</h1>
          <p className="secondary">写作、整理图片，保存可以随时回看的修订。</p>
        </div>
        <Button type="primary" onClick={() => setSelected(null)}>
          新建文章
        </Button>
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
        {loading ? (
          <div className="loading-panel">
            <Spin />
            <p className="secondary">正在读取文章…</p>
          </div>
        ) : !items.length ? (
          <div className="empty-content">
            <Empty description="还没有文章" />
            <p className="secondary">从空白开始，逐步把想法写成文章。</p>
          </div>
        ) : (
          <div className="content-list">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                className="content-row"
                onClick={() => setSelected(item.id)}
              >
                <div>
                  <strong>{item.title}</strong>
                  <span className="secondary">保存于 {date(item.updatedAt)}</span>
                </div>
                <span className="revision-pill">v{item.version}</span>
                <span className="content-open">继续编辑 →</span>
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
    </>
  );
}
