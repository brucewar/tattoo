import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Modal, Pagination, Select, Spin } from 'antd';
import type { Account, Article, DeliveryCheck } from '@tattoo/contracts';
import { api, ApiError, errorMessage, jsonRequest } from '../../api';
import { date, type DeliveryRecord, type Page } from '../../ui';
import { DeliveryDetail } from '../DeliveryDetail';

export function ArticleDelivery({
  article,
  dirty,
  busy,
  remoteWritesEnabled,
  onNotice,
  onInspectRecords,
  onActivityChange,
}: {
  article: Article | null;
  dirty: boolean;
  busy: boolean;
  remoteWritesEnabled: boolean;
  onNotice: (text: string) => void;
  onInspectRecords: () => void;
  onActivityChange: (active: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<Article | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accountId, setAccountId] = useState<string>();
  const [accountPage, setAccountPage] = useState(1);
  const [accountTotal, setAccountTotal] = useState(0);
  const [accountsLoading, setAccountsLoading] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [reload, setReload] = useState(0);
  const [check, setCheck] = useState<DeliveryCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState('');
  const [deliveryId, setDeliveryId] = useState<string | null>(null);
  const submitting = useRef(false);
  const mounted = useRef(true);
  const sameRevision = Boolean(snapshot && article?.revisionId === snapshot.revisionId);
  const unresolved = attempted && !deliveryId;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    onActivityChange(open);
    return () => onActivityChange(false);
  }, [open, onActivityChange]);

  useEffect(() => {
    if (!open || deliveryId) return;
    const controller = new AbortController();
    setAccountsLoading(true);
    setAccountError('');
    api<Page<Account>>(`/accounts?page=${accountPage}&pageSize=100`, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        setAccounts(result.items);
        setAccountTotal(result.total);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setAccountError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setAccountsLoading(false);
      });
    return () => controller.abort();
  }, [open, accountPage, reload, deliveryId]);

  useEffect(() => {
    if (!open || !snapshot || !accountId || deliveryId) {
      setChecking(false);
      return;
    }
    setCheck(null);
    setCheckError('');
    const controller = new AbortController();
    const revisionId = snapshot.revisionId;
    const targetAccountId = accountId;
    setChecking(true);
    api<DeliveryCheck>('/deliveries/check', {
      method: 'POST',
      ...jsonRequest({ revisionId, accountId: targetAccountId }),
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.revisionId !== revisionId || result.account.id !== targetAccountId) {
          setCheckError('检查结果与所选目标不一致，请重新检查。');
          return;
        }
        setCheck(result);
        if (attempted && result.existingDelivery) setDeliveryId(result.existingDelivery.id);
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setCheckError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setChecking(false);
      });
    return () => controller.abort();
  }, [open, snapshot, accountId, reload, deliveryId, attempted]);

  function startSelection() {
    if (!article || busy || pending || submitting.current) return;
    if (dirty) {
      onNotice('当前有未保存修改，请先保存后再存入微信草稿。');
      return;
    }
    setSnapshot(article);
    setAccountId(undefined);
    setAccountPage(1);
    setCheck(null);
    setCheckError('');
    setActionError('');
    setConfirmed(false);
    setAttempted(false);
    setDeliveryId(null);
    setOpen(true);
  }

  function openDialog() {
    if (unresolved || (sameRevision && deliveryId)) {
      setOpen(true);
      setReload((value) => value + 1);
      return;
    }
    startSelection();
  }

  async function submit() {
    if (submitting.current || !snapshot || !accountId || !confirmed || !check) return;
    if (dirty || !sameRevision) {
      setActionError('当前编辑内容已变化，请先保存，并为最新修订重新选择投递目标。');
      return;
    }
    if (!remoteWritesEnabled || !check.limitsVerified || !check.canSubmit || check.problems.length)
      return;
    submitting.current = true;
    setPending(true);
    setAttempted(true);
    setActionError('');
    try {
      const record = await api<DeliveryRecord>('/deliveries', {
        method: 'POST',
        ...jsonRequest({ revisionId: snapshot.revisionId, accountId, confirmed: true }),
      });
      if (mounted.current) setDeliveryId(record.id);
    } catch (failure) {
      if (mounted.current) {
        setActionError(errorMessage(failure));
        if (
          failure instanceof ApiError &&
          ((failure.status >= 400 && failure.status < 500) ||
            failure.code === 'REMOTE_WRITES_DISABLED')
        ) {
          setAttempted(false);
          setReload((value) => value + 1);
        }
      }
    } finally {
      submitting.current = false;
      if (mounted.current) setPending(false);
    }
  }

  const existing = check?.existingDelivery;
  const canSubmit = Boolean(
    check?.canSubmit &&
    check.limitsVerified &&
    !check.problems.length &&
    confirmed &&
    accountId &&
    remoteWritesEnabled &&
    !checking &&
    !pending &&
    !dirty &&
    sameRevision,
  );
  const entryLabel = unresolved
    ? '获取本次投递结果'
    : sameRevision && deliveryId
      ? '查看本次投递'
      : '存入微信草稿';

  return (
    <>
      <Button aria-label={entryLabel} onClick={openDialog} disabled={!article || busy}>
        {entryLabel}
      </Button>
      <Modal
        open={open}
        title={deliveryId ? '文章投递详情' : '存入微信草稿'}
        width={680}
        footer={null}
        onCancel={() => setOpen(false)}
        closable={!pending}
        keyboard={!pending}
        maskClosable={false}
      >
        {snapshot && (
          <dl className="revision-metadata delivery-target" aria-label="本次投递目标">
            <div>
              <dt>文章标题</dt>
              <dd>{check?.title ?? snapshot.title}</dd>
            </div>
            <div>
              <dt>已保存修订</dt>
              <dd>v{check?.version ?? snapshot.version}</dd>
            </div>
            <div>
              <dt>保存时间</dt>
              <dd>{date(check?.savedAt ?? snapshot.updatedAt)}</dd>
            </div>
            {check?.account && (
              <div>
                <dt>目标公众号</dt>
                <dd>{check.account.name}</dd>
              </div>
            )}
          </dl>
        )}
        {deliveryId ? (
          <>
            <DeliveryDetail
              key={deliveryId}
              id={deliveryId}
              remoteWritesEnabled={remoteWritesEnabled}
            />
            <div className="modal-actions">
              <Button onClick={onInspectRecords}>查看全部投递记录</Button>
              <Button onClick={startSelection} disabled={!article || busy || dirty || pending}>
                选择其他公众号或新修订
              </Button>
              <Button onClick={() => setOpen(false)} disabled={pending}>
                关闭
              </Button>
            </div>
          </>
        ) : (
          <>
            {!existing && (
              <Alert
                type="warning"
                showIcon
                message="确认后会上传微信素材并创建一篇新草稿"
                description="任务绑定这里展示的已保存修订。排队后继续编辑不会改动本次投递，旧微信草稿也会保留。"
              />
            )}
            {!remoteWritesEnabled && (
              <Alert
                type="info"
                showIcon
                message="部署配置尚未启用远程写入"
                description="请由部署管理员设置 REMOTE_WRITES_ENABLED=true 并重启 API 和 Worker，然后刷新工作台。"
              />
            )}
            {(dirty || !sameRevision) && (
              <Alert
                type="warning"
                showIcon
                message="当前编辑内容已变化，请先保存并重新选择修订。"
              />
            )}
            <div className="metadata-field delivery-account-picker">
              <label htmlFor="delivery-account">目标公众号</label>
              <Select
                id="delivery-account"
                aria-label="目标公众号"
                virtual={false}
                placeholder="请选择公众号"
                value={accountId}
                loading={accountsLoading}
                disabled={pending || attempted}
                options={accounts.map((account) => ({ value: account.id, label: account.name }))}
                onChange={(value: string) => {
                  setAccountId(value);
                  setCheck(null);
                  setConfirmed(false);
                  setActionError('');
                }}
              />
              {accountError && (
                <Alert
                  type="error"
                  showIcon
                  message={accountError}
                  action={
                    <Button
                      size="small"
                      disabled={pending}
                      onClick={() => setReload((value) => value + 1)}
                    >
                      重新加载账号
                    </Button>
                  }
                />
              )}
              {!accountsLoading && !accountError && !accounts.length && (
                <p className="form-note">尚未配置公众号，请先到“公众号账号”添加账号。</p>
              )}
              {accountTotal > 100 && (
                <Pagination
                  size="small"
                  current={accountPage}
                  total={accountTotal}
                  pageSize={100}
                  showSizeChanger={false}
                  disabled={attempted || pending}
                  onChange={(page) => {
                    setAccountPage(page);
                    setAccountId(undefined);
                    setCheck(null);
                    setCheckError('');
                    setConfirmed(false);
                  }}
                />
              )}
            </div>
            {checking && (
              <p className="delivery-check-loading" role="status">
                <Spin size="small" /> 正在检查已保存修订…
              </p>
            )}
            {checkError && (
              <Alert
                type="error"
                showIcon
                message={checkError}
                action={
                  <Button
                    size="small"
                    disabled={pending}
                    onClick={() => setReload((value) => value + 1)}
                  >
                    重新检查
                  </Button>
                }
              />
            )}
            {check && (
              <div className="delivery-checks" aria-label="投递前检查">
                {!check.limitsVerified && (
                  <Alert
                    type="warning"
                    showIcon
                    message="微信官方规则尚未核验，暂不能提交普通文章。"
                  />
                )}
                {check.problems.map((problem, index) => (
                  <Alert type="error" showIcon message={problem} key={`problem-${index}`} />
                ))}
                {check.warnings.map((warning, index) => (
                  <Alert type="warning" showIcon message={warning} key={`warning-${index}`} />
                ))}
                {!check.problems.length && check.limitsVerified && !existing && (
                  <Alert
                    type="success"
                    showIcon
                    message="已保存修订通过本地投递检查"
                    description="实际接口权限和最终格式以微信返回及后台显示为准。"
                  />
                )}
              </div>
            )}
            {actionError && <Alert type="error" showIcon message={actionError} />}
            {existing ? (
              <>
                <Alert
                  type="info"
                  showIcon
                  message="这个公众号已有该修订的投递记录"
                  description="请查看原任务的进度或结果。已成功的修订不会再次创建草稿；保存新修订后可另行投递。"
                />
                <div className="modal-actions">
                  <Button onClick={() => setOpen(false)}>关闭</Button>
                  <Button type="primary" onClick={() => setDeliveryId(existing.id)}>
                    查看已有投递
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Checkbox
                  checked={confirmed}
                  disabled={pending || attempted || !check || checking}
                  onChange={(event) => setConfirmed(event.target.checked)}
                >
                  我确认将此修订上传到所选公众号，创建微信素材与一篇新草稿
                </Checkbox>
                {attempted && (
                  <p className="form-note">
                    提交结果尚未取回。下方按钮只获取同一公众号、同一修订的投递结果；也可前往投递记录核对。
                  </p>
                )}
                <div className="modal-actions">
                  <Button
                    onClick={attempted ? onInspectRecords : () => setOpen(false)}
                    disabled={pending}
                  >
                    {attempted ? '查看全部投递记录' : '取消'}
                  </Button>
                  <Button
                    type="primary"
                    aria-label={attempted ? '获取本次投递结果' : '确认存入微信草稿'}
                    onClick={() => void submit()}
                    loading={pending}
                    disabled={!canSubmit}
                  >
                    {attempted ? '获取本次投递结果' : '确认存入微信草稿'}
                  </Button>
                </div>
              </>
            )}
          </>
        )}
      </Modal>
    </>
  );
}
