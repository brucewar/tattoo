import { useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, Pagination, Spin, Tag } from '../ui';
import type { SourceSummary } from '@tattoo/contracts';
import { api, errorMessage } from '../../api';
import type { Page } from '../../ui';

export function SourcePicker({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
}) {
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Page<SourceSummary> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void api<Page<SourceSummary>>(
      `/sources?page=${page}&pageSize=6&search=${encodeURIComponent(search)}`,
      {
        signal: controller.signal,
      },
    )
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, search, version]);
  return (
    <section className="source-picker" aria-label="选择已保存资料">
      <div className="source-heading">
        <h3>已保存资料（可选）</h3>
        <span className="secondary">已选 {value.length} / 5</span>
      </div>
      <Input.Search
        aria-label="查找已保存资料"
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onSearch={() => {
          setSearch(input.trim());
          setPage(1);
        }}
        enterButton="查找资料"
        maxLength={200}
        disabled={disabled}
      />
      {error && (
        <Alert
          type="error"
          message={error}
          action={
            <Button size="small" onClick={() => setVersion((x) => x + 1)}>
              重新读取资料
            </Button>
          }
        />
      )}
      {loading && <Spin size="small" />}
      {!loading && data?.items.length === 0 && (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无匹配资料，可先在“资料”页采集，也可直接填写下方参考内容。"
        />
      )}
      {data?.items.map((source) => (
        <div className="source-picker-row" key={source.id}>
          <Checkbox
            aria-label={`选择资料：${source.title || source.url}`}
            checked={value.includes(source.id)}
            disabled={
              disabled ||
              source.textLength === 0 ||
              (!value.includes(source.id) && value.length >= 5)
            }
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...value, source.id]
                  : value.filter((id) => id !== source.id),
              )
            }
          >
            {source.title || source.url}
          </Checkbox>
          <div className="secondary source-picker-meta">
            <Tag>{source.contentKind === 'feed' ? 'RSS 文字，可能为摘要' : '网页正文'}</Tag>
            {source.textLength ? `${source.textLength} 字符` : '暂无文字，请先抓取正文'}
          </div>
        </div>
      ))}
      {data && data.total > 6 && (
        <Pagination
          size="small"
          current={page}
          pageSize={6}
          total={data.total}
          showSizeChanger={false}
          onChange={setPage}
          disabled={disabled}
        />
      )}
      {value.length > 0 && (
        <Button size="small" disabled={disabled} onClick={() => onChange([])}>
          清空已选资料
        </Button>
      )}
      <p className="form-note">
        所选资料由后端读取并保存本次使用的快照。所选文字与手填参考合计不得超过 80000
        字符，超限会提示调整。
      </p>
    </section>
  );
}
