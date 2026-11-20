import { useEffect, useState } from 'react';
import { Alert, Button, Form, Input, Modal, Pagination, Spin } from 'antd';
import type { Account } from '@tattoo/contracts';
import { api, errorMessage, jsonRequest } from '../api';
import { Capability, type Page } from '../ui';
import { TestDraft } from '../components/TestDraft';

function AccountEditor({
  account,
  onClose,
  onSaved,
}: {
  account: Account | null;
  onClose: () => void;
  onSaved: (account: Account) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function save(values: { name: string; appId: string; appSecret?: string }) {
    setPending(true);
    setError('');
    try {
      const body = account
        ? {
            name: values.name,
            ...(values.appSecret?.trim() ? { appSecret: values.appSecret.trim() } : {}),
          }
        : values;
      const saved = await api<Account>(account ? `/accounts/${account.id}` : '/accounts', {
        method: account ? 'PATCH' : 'POST',
        ...jsonRequest(body),
      });
      onSaved(saved);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <Modal
      open
      title={account ? '编辑公众号配置' : '新增公众号'}
      footer={null}
      onCancel={onClose}
      maskClosable={!pending}
      closable={!pending}
      destroyOnClose
    >
      <p className="secondary">凭证由后端加密保存，保存后不会返回 AppSecret 明文。</p>
      {error && <Alert type="error" showIcon message={error} />}
      <Form
        layout="vertical"
        onFinish={save}
        initialValues={{ name: account?.name ?? '', appId: account?.appId ?? '', appSecret: '' }}
        requiredMark={false}
        preserve={false}
      >
        <Form.Item
          label="账号名称"
          name="name"
          rules={[
            { required: true, whitespace: true, message: '请输入账号名称' },
            { max: 60, message: '账号名称最多 60 个字符' },
          ]}
        >
          <Input placeholder="例如：我的公众号" autoComplete="off" maxLength={60} />
        </Form.Item>
        <Form.Item
          label="AppID"
          name="appId"
          extra={
            account
              ? '创建后不能修改 AppID；请新增账号来接入其他公众号。'
              : '请填写微信开发者平台中的公众号 AppID。'
          }
          rules={[
            { required: true, message: '请输入 AppID' },
            { pattern: /^wx[a-zA-Z0-9]{8,40}$/, message: '请输入有效的公众号 AppID' },
          ]}
        >
          <Input disabled={Boolean(account)} autoComplete="off" placeholder="wx…" />
        </Form.Item>
        <Form.Item
          label={account ? '轮换 AppSecret（可选）' : 'AppSecret'}
          name="appSecret"
          extra={
            account
              ? '留空保留现有密钥。轮换后需要重新验证接口能力。'
              : '只在自己的实例中填写，不要提交到代码仓库。'
          }
          rules={[
            { required: !account, message: '请输入 AppSecret' },
            {
              validator: (_, value: string | undefined) =>
                !value || (value.trim().length >= 16 && value.trim().length <= 128)
                  ? Promise.resolve()
                  : Promise.reject(new Error('AppSecret 长度应为 16–128 个字符')),
            },
          ]}
        >
          <Input.Password
            autoComplete="new-password"
            placeholder={account ? '留空表示保留现有密钥' : '请输入 AppSecret'}
            maxLength={128}
          />
        </Form.Item>
        <div className="modal-actions">
          <Button onClick={onClose} disabled={pending}>
            取消
          </Button>
          <Button type="primary" htmlType="submit" loading={pending}>
            {account ? '保存配置' : '保存公众号'}
          </Button>
        </div>
      </Form>
    </Modal>
  );
}
export function Accounts({
  remoteWritesEnabled,
  onInspectRecords,
}: {
  remoteWritesEnabled: boolean;
  onInspectRecords: () => void;
}) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verificationError, setVerificationError] = useState('');
  const [editor, setEditor] = useState<{ account: Account | null } | null>(null);
  const [testAccount, setTestAccount] = useState<Account | null>(null);
  const selected = accounts.find((account) => account.id === selectedId) ?? null;
  const reload = () => setVersion((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    api<Page<Account> | Account[]>(`/accounts?page=${page}&pageSize=20`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        const items = Array.isArray(result) ? result : result.items;
        setAccounts(items);
        setTotal(Array.isArray(result) ? items.length : result.total);
        setSelectedId((current) =>
          items.some((account) => account.id === current) ? current : (items[0]?.id ?? null),
        );
      })
      .catch((failure) => {
        if (!controller.signal.aborted) setError(errorMessage(failure));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, version]);
  async function verify() {
    if (!selected) return;
    setVerifying(true);
    setError('');
    setVerificationError('');
    setNotice('');
    try {
      const result = await api<{ account: Account; draftCount: number | null }>(
        `/accounts/${selected.id}/verify`,
        { method: 'POST', timeoutMs: 70000 },
      );
      const updated = result.account;
      setAccounts((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      if (updated.capabilities.readDraft.status === 'supported')
        setNotice(
          `只读验证通过${result.draftCount === null ? '' : `，当前草稿数量为 ${result.draftCount}`}。这不代表新增草稿权限已验证。`,
        );
    } catch (failure) {
      setVerificationError(errorMessage(failure));
      reload();
    } finally {
      setVerifying(false);
    }
  }
  function closeTest() {
    setTestAccount(null);
    reload();
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">连接你的内容目的地</p>
          <h1>公众号账号</h1>
          <p className="secondary">把凭证留在自己的实例里，先验证，再存入草稿箱。</p>
        </div>
        <Button
          type="primary"
          onClick={() => {
            setNotice('');
            setEditor({ account: null });
          }}
        >
          新增公众号
        </Button>
      </div>
      {!remoteWritesEnabled && (
        <Alert
          className="write-banner"
          type="info"
          showIcon
          message="远程写入尚未启用"
          description="可以保存账号并执行只读验证。创建测试草稿前，请由部署管理员启用远程写入。"
        />
      )}
      {error && <Alert type="error" showIcon message={error} />}
      {verificationError && <Alert type="error" showIcon message={verificationError} />}
      {notice && (
        <Alert type="success" showIcon message={notice} closable onClose={() => setNotice('')} />
      )}
      {loading && accounts.length === 0 ? (
        <div className="loading-panel surface">
          <Spin />
          <p className="secondary">正在读取公众号配置…</p>
        </div>
      ) : accounts.length === 0 ? (
        <div className="surface empty-accounts">
          <span className="empty-letter">T.</span>
          <h2>接入第一个公众号</h2>
          <p className="secondary">准备好 AppID 和 AppSecret，即可在这里完成接口验证。</p>
          <Button type="primary" onClick={() => setEditor({ account: null })}>
            新增公众号
          </Button>
          <p className="form-note">只读验证不会上传图片或创建草稿。</p>
        </div>
      ) : (
        <div className="account-layout">
          <aside className="account-list surface" aria-label="选择公众号">
            <div className="list-heading">
              <span>已接入账号</span>
              <span className="secondary">{total}</span>
            </div>
            {accounts.map((account) => (
              <button
                key={account.id}
                type="button"
                className={`account-select ${account.id === selectedId ? 'selected' : ''}`}
                aria-pressed={account.id === selectedId}
                onClick={() => {
                  setSelectedId(account.id);
                  setNotice('');
                  setError('');
                  setVerificationError('');
                }}
              >
                <span className="account-avatar">{account.name.slice(0, 1)}</span>
                <span>
                  <strong>{account.name}</strong>
                  <code>{account.appId}</code>
                </span>
              </button>
            ))}
          </aside>
          {selected && (
            <section className="account-detail surface" aria-labelledby="account-name">
              <div className="account-detail-heading">
                <div>
                  <span className="platform-label">微信公众号</span>
                  <h2 id="account-name">{selected.name}</h2>
                  <code className="secondary">{selected.appId}</code>
                </div>
                <Button onClick={() => setEditor({ account: selected })} disabled={verifying}>
                  编辑配置
                </Button>
              </div>
              <div className="capability-grid">
                <Capability title="读取草稿" value={selected.capabilities.readDraft} />
                <Capability title="新增草稿" value={selected.capabilities.saveDraft} />
              </div>
              <div className="account-step">
                <div>
                  <h3>只读验证</h3>
                  <p className="secondary">
                    检查凭证并读取草稿数量。不会上传图片、创建草稿或调用发表接口。
                  </p>
                </div>
                <Button onClick={verify} loading={verifying}>
                  执行只读验证
                </Button>
              </div>
              <div className="account-step">
                <div>
                  <h3>创建测试草稿</h3>
                  <p className="secondary">
                    选择一张本地封面，以固定测试正文验证真实的新增草稿能力。
                  </p>
                </div>
                <Button
                  type="primary"
                  disabled={!remoteWritesEnabled || verifying}
                  onClick={() => setTestAccount(selected)}
                >
                  创建测试草稿
                </Button>
              </div>
              <div className="connection-guide">
                <h4>接入提示</h4>
                <p>
                  若微信返回 <code>40164</code>，请将错误中报告的公网出口 IP
                  加入白名单。群晖内网地址和 DDNS 不能代替实际出站公网 IP。
                </p>
                <p>“已验证可用”记录的是当次接口结果。密钥轮换或平台权限变化后，需要重新验证。</p>
              </div>
            </section>
          )}
        </div>
      )}
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
      <p className="page-footnote">平台凭证加密保存 · 读取与新增权限分别验证 · 首版只存草稿</p>
      {editor && (
        <AccountEditor
          key={editor.account?.id ?? 'new'}
          account={editor.account}
          onClose={() => setEditor(null)}
          onSaved={(account) => {
            setEditor(null);
            setPage(1);
            setSelectedId(account.id);
            setNotice('公众号配置已保存。');
            reload();
          }}
        />
      )}
      {testAccount && (
        <TestDraft
          key={testAccount.id}
          account={testAccount}
          remoteWritesEnabled={remoteWritesEnabled}
          onClose={closeTest}
          onInspectRecords={() => {
            closeTest();
            onInspectRecords();
          }}
        />
      )}
    </>
  );
}
