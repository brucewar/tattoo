import { useState } from 'react';
import { Alert, Button, Checkbox, Modal } from './ui';
import type { Account, Asset } from '@tattoo/contracts';
import { api, errorMessage, jsonRequest, requestId } from '../api';
import type { DeliveryRecord } from '../ui';
import { DeliveryDetail } from './DeliveryDetail';

export function TestDraft({
  account,
  remoteWritesEnabled,
  onClose,
  onInspectRecords,
}: {
  account: Account;
  remoteWritesEnabled: boolean;
  onClose: () => void;
  onInspectRecords: () => void;
}) {
  const [cover, setCover] = useState<Asset | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pending, setPending] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [testRequestId] = useState(requestId);
  async function upload(file?: File) {
    if (!file) return;
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      setError('请选择 JPG 或 PNG 图片');
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError('图片不能超过 10 MiB');
      return;
    }
    setUploading(true);
    setError('');
    try {
      setCover(
        await api<Asset>('/assets', {
          method: 'POST',
          body: file,
          headers: { 'Content-Type': file.type, 'X-Filename': encodeURIComponent(file.name) },
          timeoutMs: 40000,
        }),
      );
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setUploading(false);
    }
  }
  async function submit() {
    if (!cover || !confirmed) return;
    setAttempted(true);
    setPending(true);
    setError('');
    try {
      const record = await api<DeliveryRecord>(`/accounts/${account.id}/test-draft`, {
        method: 'POST',
        ...jsonRequest({ coverId: cover.id, requestId: testRequestId, confirmed: true }),
        timeoutMs: 40000,
      });
      setDeliveryId(record.id);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <Modal
      open
      title={deliveryId ? '测试投递详情' : '创建测试草稿'}
      footer={null}
      width={640}
      onCancel={onClose}
      closable={!pending}
      maskClosable={false}
      destroyOnClose
    >
      {deliveryId ? (
        <>
          <DeliveryDetail id={deliveryId} remoteWritesEnabled={remoteWritesEnabled} />
          <div className="modal-actions">
            <Button onClick={onClose}>关闭</Button>
          </div>
        </>
      ) : (
        <>
          <p>
            目标公众号：<strong>{account.name}</strong>
          </p>
          <Alert
            type="warning"
            showIcon
            message="这次操作会创建真实的微信素材和草稿"
            description="使用固定的测试正文和你选择的封面。它不会发表或群发，完成后请在微信后台检查并按需手动清理。"
          />
          {!remoteWritesEnabled && (
            <Alert type="info" message="远程写入尚未启用，请由部署管理员启用后再测试。" />
          )}
          {error && <Alert type="error" showIcon message={error} />}
          <div className="cover-picker">
            <label htmlFor="test-cover">测试封面</label>
            <input
              id="test-cover"
              type="file"
              accept="image/png,image/jpeg"
              disabled={uploading || attempted}
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                void upload(file);
              }}
            />
            {uploading && <p role="status">正在安全处理图片…</p>}
            {cover && (
              <div className="cover-preview">
                <img src={cover.url} alt="所选测试封面" />
                <span>{cover.name}</span>
              </div>
            )}
            <p className="form-note">JPG/PNG，最大 10 MiB。图片会先保存到本地实例。</p>
          </div>
          <Checkbox
            checked={confirmed}
            disabled={attempted}
            onChange={(event) => setConfirmed(event.target.checked)}
          >
            我了解会上传封面并创建一篇测试草稿，同意继续
          </Checkbox>
          {attempted && !deliveryId && (
            <p className="form-note">
              若未收到结果，请使用下方按钮重试获取同一次测试，或先在投递记录中核对。不要反复创建新的测试。
            </p>
          )}
          <div className="modal-actions">
            {attempted ? (
              <Button onClick={onInspectRecords} disabled={pending}>
                查看投递记录
              </Button>
            ) : (
              <Button onClick={onClose}>取消</Button>
            )}
            <Button
              type="primary"
              onClick={submit}
              loading={pending}
              disabled={!cover || !confirmed || uploading || !remoteWritesEnabled}
            >
              {attempted ? '获取这次测试结果' : '创建测试草稿'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
