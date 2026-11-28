import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Checkbox, Input, Radio, Spin } from './ui';
import { api, errorMessage, jsonRequest } from '../api';
import { date, StateTag, type DeliveryRecord } from '../ui';

function useDelivery(id: string | null) {
  const [delivery, setDelivery] = useState<DeliveryRecord | null>(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    if (!id) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    setDelivery(null);
    setError('');
    async function read() {
      try {
        const record = await api<DeliveryRecord>(`/deliveries/${id}`, {
          signal: controller.signal,
        });
        if (stopped) return;
        setDelivery(record);
        setError('');
        if (record.state === 'QUEUED' || record.state === 'RUNNING') timer = setTimeout(read, 2000);
      } catch (failure) {
        if (!stopped) {
          setError(errorMessage(failure));
          timer = setTimeout(read, 4000);
        }
      }
    }
    void read();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, revision]);
  return { delivery, error, refresh };
}

export function DeliveryDetail({
  id,
  remoteWritesEnabled,
}: {
  id: string;
  remoteWritesEnabled: boolean;
}) {
  const { delivery, error, refresh } = useDelivery(id);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState('');
  const [stopped, setStopped] = useState(false);
  const [retryConfirmed, setRetryConfirmed] = useState(false);
  const [resolved, setResolved] = useState(false);
  const [resolution, setResolution] = useState({ outcome: 'created', note: '', remoteId: '' });
  async function resolve(values: { outcome: string; note: string; remoteId?: string }) {
    setPending(true);
    setActionError('');
    try {
      await api(`/deliveries/${id}/resolve`, {
        method: 'POST',
        ...jsonRequest({
          ...values,
          remoteId: values.remoteId?.trim() || undefined,
          workerStoppedConfirmed: stopped,
        }),
      });
      setResolved(true);
      refresh();
    } catch (failure) {
      setActionError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }
  async function retry() {
    setPending(true);
    setActionError('');
    try {
      await api(`/deliveries/${id}/retry`, { method: 'POST', ...jsonRequest({ confirmed: true }) });
      setRetryConfirmed(false);
      refresh();
    } catch (failure) {
      setActionError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }
  if (!delivery)
    return (
      <div className="loading-panel">
        <Spin />
        <p>{error || '正在读取投递记录…'}</p>
      </div>
    );
  return (
    <div className="delivery-detail">
      <div className="detail-status">
        <StateTag state={delivery.state} />
        <span className="secondary">{date(delivery.createdAt)}</span>
      </div>
      <h3>{delivery.revision?.title ?? 'Tattoo 接口测试草稿'}</h3>
      {delivery.account?.name && <p className="secondary">目标账号：{delivery.account.name}</p>}
      {delivery.revision?.version && (
        <p className="secondary">投递修订：v{delivery.revision.version}</p>
      )}
      <p role="status">当前阶段：{delivery.stage}</p>
      {(error || actionError) && <Alert type="error" showIcon message={actionError || error} />}
      {delivery.error && (
        <Alert
          type={delivery.state === 'UNCERTAIN' ? 'warning' : 'error'}
          showIcon
          message={delivery.error}
          description={
            delivery.state === 'FAILED' && /\b4800[14]\b/.test(delivery.error)
              ? '请在微信后台核对该账号的新增草稿权限；只读验证成功不代表可写入草稿。'
              : undefined
          }
        />
      )}
      {(delivery.state === 'QUEUED' || delivery.state === 'RUNNING') && (
        <p className="form-note">可以关闭此窗口，后台会继续执行。页面只查询状态，不会重复提交。</p>
      )}
      {delivery.state === 'SUCCEEDED' && (
        <Alert
          type="success"
          showIcon
          message={
            delivery.resultSource === 'manual'
              ? '已由管理员人工确认创建'
              : '微信接口已返回草稿创建成功'
          }
          description="请到微信后台检查封面与正文。草稿和素材保留在所选公众号中，请按需管理。"
        />
      )}
      {delivery.remoteId && (
        <div className="remote-id">
          <span className="secondary">远程草稿 ID</span>
          <code>{delivery.remoteId}</code>
        </div>
      )}
      {resolved && (
        <Alert type="info" message="核对结果已记录。需要继续处理排队任务时，请重新启动 Worker。" />
      )}
      {delivery.state === 'UNCERTAIN' && (
        <div className="reconcile-panel">
          <h4>核对这次投递</h4>
          <p>
            微信可能已经创建草稿，系统不会自动重投。请先停止旧 Worker，再到微信后台核对本次草稿。
          </p>
          <p className="form-note">
            部署管理员停止命令：<code>docker compose stop worker</code>。正在运行的 Worker
            会阻止人工解除待核对状态。
          </p>
          <Checkbox checked={stopped} onChange={(event) => setStopped(event.target.checked)}>
            我已确认旧 Worker 停止，并在微信后台核对了结果
          </Checkbox>
          <form
            className="workspace-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (!stopped || pending) return;
              if (resolution.note.trim().length < 5) {
                setActionError('请至少填写 5 个字符说明核对依据');
                return;
              }
              void resolve(resolution);
            }}
          >
            <div className="form-field">
              <span className="field-label" id="reconcile-outcome-label">
                核对结果
              </span>
              <Radio.Group
                aria-label="核对结果"
                value={resolution.outcome}
                disabled={pending}
                onChange={(event) => setResolution({ ...resolution, outcome: event.target.value })}
              >
                <Radio value="created">确认已创建</Radio>
                <Radio value="not_created">确认未创建</Radio>
              </Radio.Group>
            </div>
            <div className="form-field">
              <label htmlFor="reconcile-note">核对说明</label>
              <Input.TextArea
                id="reconcile-note"
                required
                minLength={5}
                value={resolution.note}
                disabled={pending}
                onChange={(event) => setResolution({ ...resolution, note: event.target.value })}
                rows={3}
                maxLength={1000}
                placeholder="例如：已检查此账号草稿箱，记录标题与创建时间。"
              />
            </div>
            <div className="form-field">
              <label htmlFor="reconcile-id">远程草稿 ID（可选）</label>
              <Input
                id="reconcile-id"
                disabled={pending}
                value={resolution.remoteId}
                onChange={(event) => setResolution({ ...resolution, remoteId: event.target.value })}
                maxLength={256}
                placeholder="微信后台可取得时填写"
              />
            </div>
            <Button htmlType="submit" type="primary" loading={pending} disabled={!stopped}>
              记录核对结果
            </Button>
          </form>
        </div>
      )}
      {delivery.state === 'FAILED' && (
        <div className="retry-panel">
          <Checkbox
            checked={retryConfirmed}
            onChange={(event) => setRetryConfirmed(event.target.checked)}
          >
            我确认要重试这条投递记录
          </Checkbox>
          <Button
            onClick={retry}
            loading={pending}
            disabled={!retryConfirmed || !remoteWritesEnabled}
          >
            重试该投递
          </Button>
          {!remoteWritesEnabled && <p className="form-note">远程写入尚未启用，暂不能重试。</p>}
        </div>
      )}
      {Boolean(delivery.events?.length) && (
        <div className="event-log">
          <h4>执行记录</h4>
          <ol>
            {delivery.events!.map((event, index) => (
              <li key={`${event.createdAt}-${index}`}>
                <p>{event.message}</p>
                <span className="secondary">
                  {date(event.createdAt)} · {event.actor}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <p className="record-id secondary">投递 ID：{delivery.id}</p>
    </div>
  );
}
