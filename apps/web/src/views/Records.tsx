import { useEffect, useState } from 'react';
import { Alert, Button, Empty, Modal, Pagination, Spin } from 'antd';
import { api, errorMessage } from '../api';
import { date, StateTag, type Page, type DeliveryRecord } from '../ui';
import { DeliveryDetail } from '../components/DeliveryDetail';

export function Records({ remoteWritesEnabled }: { remoteWritesEnabled: boolean }) {
  const [page, setPage] = useState(1);
  const [records, setRecords] = useState<DeliveryRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<Page<DeliveryRecord>>(`/deliveries?page=${page}&pageSize=20`, { signal: controller.signal })
      .then((result) => {
        setRecords(result.items);
        setTotal(result.total);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, version]);
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">每一次投递，都有迹可循</p>
          <h1>投递记录</h1>
          <p className="secondary">查看文章与测试草稿的执行结果，谨慎处理需要人工核对的投递。</p>
        </div>
        <Button onClick={() => setVersion((value) => value + 1)} loading={loading}>
          刷新记录
        </Button>
      </div>
      {error && <Alert type="error" showIcon message={error} />}
      <div className="surface records-surface">
        {loading && records.length === 0 ? (
          <div className="loading-panel">
            <Spin />
          </div>
        ) : records.length === 0 ? (
          <Empty description="还没有投递记录" />
        ) : (
          <div className="records-list">
            {records.map((record) => (
              <button
                type="button"
                className="record-row"
                key={record.id}
                onClick={() => setSelected(record.id)}
              >
                <div>
                  <span className="record-title">
                    {record.revision?.title ?? '接口测试草稿'}
                    {record.revision?.version ? ` · v${record.revision.version}` : ''}
                  </span>
                  <span className="secondary">
                    {record.account?.name ?? '公众号测试'} · {date(record.createdAt)}
                  </span>
                </div>
                <div className="record-progress">
                  <StateTag state={record.state} />
                  <span className="secondary">{record.stage}</span>
                </div>
                <span className="record-open">查看详情</span>
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
      {selected && (
        <Modal
          open
          title="投递详情"
          footer={null}
          width={680}
          onCancel={() => {
            setSelected(null);
            setVersion((value) => value + 1);
          }}
          destroyOnClose
        >
          <DeliveryDetail key={selected} id={selected} remoteWritesEnabled={remoteWritesEnabled} />
        </Modal>
      )}
    </>
  );
}
