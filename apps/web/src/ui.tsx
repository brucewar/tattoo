import { Tag } from 'antd';
import type { CapabilityCheck, DeliveryState } from '@tattoo/contracts';

export type User = { id: string; email: string; remoteWritesEnabled?: boolean };
export type Page<T> = { items: T[]; total: number; page: number; pageSize: number };
export type DeliveryRecord = {
  id: string;
  state: DeliveryState;
  stage: string;
  remoteId: string | null;
  error: string | null;
  resultSource?: string | null;
  createdAt: string;
  account?: { id: string; name: string };
  revision?: { title: string };
  events?: { actor: string; message: string; createdAt: string }[];
};

const stateLabels: Record<DeliveryState, { text: string; color: string }> = {
  QUEUED: { text: '排队中', color: 'default' },
  RUNNING: { text: '执行中', color: 'processing' },
  SUCCEEDED: { text: '已存草稿', color: 'success' },
  FAILED: { text: '失败', color: 'error' },
  UNCERTAIN: { text: '结果待核对', color: 'warning' },
};

export function date(value?: string) {
  if (!value) return '尚未验证';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? '时间未知'
    : parsed.toLocaleString('zh-CN', { hour12: false });
}

export function StateTag({ state }: { state: DeliveryState }) {
  const status = stateLabels[state];
  return <Tag color={status?.color}>{status?.text ?? state}</Tag>;
}

export function Capability({ title, value }: { title: string; value?: CapabilityCheck }) {
  const status = value?.status ?? 'unverified';
  return (
    <div className="capability">
      <div className="capability-heading">
        <span>{title}</span>
        <Tag
          color={
            status === 'supported' ? 'success' : status === 'unsupported' ? 'error' : 'default'
          }
        >
          {status === 'supported'
            ? '已验证可用'
            : status === 'unsupported'
              ? '当前不可用'
              : '未验证'}
        </Tag>
      </div>
      <p className="secondary">
        {value?.verifiedAt ? `验证于 ${date(value.verifiedAt)}` : '尚无接口成功记录'}
      </p>
      {value?.error && <p className="inline-error">{value.error}</p>}
    </div>
  );
}
export function Brand() {
  return (
    <span className="wordmark">
      Tattoo<span className="brand-dot">.</span>
    </span>
  );
}
