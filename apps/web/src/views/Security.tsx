import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import {
  CheckCircle,
  Copy,
  DownloadSimple,
  Key,
  ShieldCheck,
  SignOut,
} from '@phosphor-icons/react';
import type { AccountSecurityStatus, RecoveryCodesResult, TotpSetup } from '@tattoo/contracts';
import { api, ApiError, errorMessage, jsonRequest } from '../api';
import { Alert, Button, Checkbox, Input, Modal, Spin, Tag } from '../components/ui';
import './security.css';

type Action = 'password' | 'setup' | 'disable' | 'recovery' | 'sessions';
type Proof = { currentPassword: string; code: string; recovery: boolean };
type Field = 'currentPassword' | 'newPassword' | 'confirmation' | 'code';
const emptyProof = (): Proof => ({ currentPassword: '', code: '', recovery: false });
const actionTitles: Record<Action, string> = {
  password: '修改密码',
  setup: '设置双重验证',
  disable: '关闭双重验证',
  recovery: '重新生成恢复码',
  sessions: '退出其他会话',
};
const normalizedCode = (value: string) => value.replace(/[\s-]/g, '').toUpperCase();
const publicStatus = (value: AccountSecurityStatus): AccountSecurityStatus => ({
  totpEnabled: value.totpEnabled,
  recoveryCodesRemaining: value.recoveryCodesRemaining,
  otherSessionsCount: value.otherSessionsCount,
});

export function Security({
  email,
  onDirtyChange,
}: {
  email: string;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [status, setStatus] = useState<AccountSecurityStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeType, setNoticeType] = useState<'success' | 'warning'>('success');
  const [action, setAction] = useState<Action | null>(null);
  const [proof, setProof] = useState<Proof>(emptyProof);
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<Field, string>>>({});
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [qrImage, setQrImage] = useState('');
  const [qrError, setQrError] = useState('');
  const [now, setNow] = useState(Date.now);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [codesSaved, setCodesSaved] = useState(false);
  const [copyNotice, setCopyNotice] = useState('');
  const submitting = useRef(false);
  const statusSequence = useRef(0);
  const mounted = useRef(true);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const sequence = ++statusSequence.current;
    setLoading(true);
    setLoadError('');
    try {
      const value = await api<AccountSecurityStatus>('/auth/security', { signal });
      if (mounted.current && sequence === statusSequence.current) setStatus(publicStatus(value));
    } catch (failure) {
      if (mounted.current && !signal?.aborted && sequence === statusSequence.current)
        setLoadError(errorMessage(failure));
    } finally {
      if (mounted.current && !signal?.aborted && sequence === statusSequence.current)
        setLoading(false);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, [refresh]);
  const dirty = Boolean(
    pending ||
    setup ||
    recoveryCodes ||
    proof.currentPassword ||
    proof.code ||
    newPassword ||
    confirmation,
  );
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    const authenticated = () => {
      void refresh();
    };
    window.addEventListener('tattoo:authenticated', authenticated);
    return () => window.removeEventListener('tattoo:authenticated', authenticated);
  }, [refresh]);
  useEffect(() => {
    const expired = () => {
      setProof(emptyProof());
      setNewPassword('');
      setConfirmation('');
      setSetup(null);
      setAction(null);
      setActionError('');
      setFieldErrors({});
      setRecoveryCodes(null);
      setCodesSaved(false);
      setCopyNotice('');
      setNoticeType('warning');
      setNotice('会话已过期，敏感设置已清除。若恢复码尚未保存，重新登录后可重新生成一组。');
    };
    window.addEventListener('tattoo:unauthorized', expired);
    return () => window.removeEventListener('tattoo:unauthorized', expired);
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);
  useEffect(() => {
    setQrImage('');
    setQrError('');
    if (!setup) return;
    let cancelled = false;
    void QRCode.toDataURL(setup.otpauthUrl, {
      width: 232,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#142018', light: '#ffffff' },
    })
      .then((value) => {
        if (!cancelled) setQrImage(value);
      })
      .catch(() => {
        if (!cancelled) setQrError('二维码生成失败，可在验证器中手动输入下方密钥。');
      });
    return () => {
      cancelled = true;
    };
  }, [setup]);
  useEffect(() => {
    if (!setup) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [setup]);
  useEffect(() => {
    if (!setup) return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById('security-setup-intro')?.focus({ preventScroll: true });
      document.querySelector<HTMLElement>('.security-dialog')?.scrollTo(0, 0);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [setup]);

  function clearSensitive() {
    setProof(emptyProof());
    setNewPassword('');
    setConfirmation('');
    setFieldErrors({});
    setActionError('');
  }
  function begin(next: Action) {
    if (pending || loading || recoveryCodes) return;
    clearSensitive();
    setSetup(null);
    setNotice('');
    setCopyNotice('');
    setAction(next);
  }
  function announce(message: string, type: 'success' | 'warning' = 'success') {
    setNotice(message);
    setNoticeType(type);
  }
  function changeProof(patch: Partial<Proof>) {
    setProof((value) => ({ ...value, ...patch }));
    setFieldErrors((value) => ({
      ...value,
      ...(Object.hasOwn(patch, 'currentPassword') ? { currentPassword: undefined } : {}),
      ...(Object.hasOwn(patch, 'code') || Object.hasOwn(patch, 'recovery')
        ? { code: undefined }
        : {}),
    }));
    setActionError('');
  }
  function invalid(field: Field, message: string) {
    setFieldErrors({ [field]: message });
    document.getElementById(`security-${field}`)?.focus();
    return false;
  }
  function validateProof(requireFactor: boolean) {
    if (!proof.currentPassword) return invalid('currentPassword', '请输入当前密码');
    if (requireFactor && !validCode()) return false;
    return true;
  }
  function validCode() {
    const code = normalizedCode(proof.code);
    if (proof.recovery ? !/^[0-9A-F]{32}$/.test(code) : !/^\d{6}$/.test(code))
      return invalid(
        'code',
        proof.recovery ? '请输入完整的一次性恢复码' : '请输入验证器中的 6 位验证码',
      );
    return true;
  }
  function applyStatus(value: AccountSecurityStatus) {
    ++statusSequence.current;
    setLoading(false);
    setLoadError('');
    setStatus(publicStatus(value));
  }
  async function cancelAction() {
    if (submitting.current) return;
    if (setup) {
      submitting.current = true;
      setPending(true);
      try {
        applyStatus(
          await api<AccountSecurityStatus>('/auth/totp/cancel', {
            method: 'POST',
            ...jsonRequest({ setupId: setup.setupId }),
          }),
        );
      } catch (failure) {
        announce(
          `已关闭本页设置。${errorMessage(failure)}；未确认的设置不会自动启用，过期后失效。`,
          'warning',
        );
      } finally {
        submitting.current = false;
        setPending(false);
      }
    }
    setSetup(null);
    setAction(null);
    clearSensitive();
  }
  async function submit() {
    if (!action || !status || submitting.current) return;
    setActionError('');
    setFieldErrors({});
    if (action === 'setup' && setup) {
      if (Date.parse(setup.expiresAt) <= Date.now()) {
        setActionError('本次设置已过期，请取消后重新开始。');
        return;
      }
      if (!validCode()) return;
    } else {
      if (!validateProof(status.totpEnabled)) return;
      if (action === 'password') {
        if (newPassword.length < 12 || newPassword.length > 256) {
          invalid('newPassword', '新密码需要 12 至 256 个字符');
          return;
        }
        if (confirmation !== newPassword) {
          invalid('confirmation', '两次输入的新密码不一致');
          return;
        }
      }
    }
    submitting.current = true;
    setPending(true);
    const proofInput = {
      currentPassword: proof.currentPassword,
      ...(status.totpEnabled ? { code: normalizedCode(proof.code) } : {}),
    };
    try {
      if (action === 'setup' && !setup) {
        const result = await api<TotpSetup>('/auth/totp/setup', {
          method: 'POST',
          ...jsonRequest({ currentPassword: proof.currentPassword }),
        });
        setSetup(result);
        setProof(emptyProof());
      } else if (action === 'setup' || action === 'recovery') {
        const value = await api<RecoveryCodesResult>(
          action === 'setup' ? '/auth/totp/enable' : '/auth/recovery-codes/regenerate',
          {
            method: 'POST',
            ...jsonRequest(
              action === 'setup'
                ? { setupId: setup!.setupId, code: normalizedCode(proof.code) }
                : proofInput,
            ),
          },
        );
        applyStatus(value);
        setSetup(null);
        setAction(null);
        clearSensitive();
        setRecoveryCodes(value.recoveryCodes);
        setCodesSaved(false);
        setCopyNotice('');
        announce(
          action === 'setup'
            ? '双重验证已启用，其他会话已退出。请立即保存恢复码。'
            : '恢复码已更新，旧恢复码已失效。请保存这一组新码。',
        );
      } else {
        const path =
          action === 'password'
            ? '/auth/password'
            : action === 'disable'
              ? '/auth/totp/disable'
              : '/auth/sessions/revoke-others';
        const value = await api<AccountSecurityStatus>(path, {
          method: 'POST',
          ...jsonRequest({ ...proofInput, ...(action === 'password' ? { newPassword } : {}) }),
        });
        applyStatus(value);
        setAction(null);
        clearSensitive();
        announce(
          action === 'password'
            ? '密码已更新，其他会话已退出，当前浏览器保持登录。'
            : action === 'disable'
              ? '双重验证已关闭，恢复码已失效，其他会话已退出。'
              : '其他会话已退出，当前浏览器保持登录。',
        );
      }
    } catch (failure) {
      const uncertain =
        failure instanceof ApiError && (failure.status === 0 || failure.status >= 500);
      const message = errorMessage(failure);
      if (setup || status.totpEnabled) setProof((value) => ({ ...value, code: '' }));
      if (uncertain && ((action === 'setup' && setup) || action === 'recovery')) {
        setActionError(
          `${message}。未收到完整结果，请先关闭并刷新安全状态；如需恢复码，请等待验证器验证码更新后明确重新生成，不要反复提交当前请求。`,
        );
        announce(
          '未收到恢复码结果，原恢复码可能已经失效。请刷新安全状态，必要时使用新的验证器验证码重新生成并保存恢复码。',
          'warning',
        );
      } else {
        setActionError(
          uncertain
            ? `${message}。操作结果尚未确认；请先关闭并刷新安全状态。${action === 'password' ? '密码可能已更新，请使用新密码重新登录核对。' : ''}`
            : message,
        );
        if (uncertain)
          announce('上次安全操作未收到结果，请先刷新安全状态核对后再继续。', 'warning');
      }
      const serverField: Field | null =
        failure instanceof ApiError && failure.status === 400
          ? /新密码/.test(message)
            ? 'newPassword'
            : /当前密码错误/.test(message)
              ? 'currentPassword'
              : /验证码|恢复码/.test(message) && (setup || status.totpEnabled)
                ? 'code'
                : null
          : null;
      if (serverField) {
        setFieldErrors({ [serverField]: message });
        setActionError('');
      }
      const focusField =
        serverField ??
        (/密码/.test(message) || !(setup || status.totpEnabled) ? 'currentPassword' : 'code');
      window.requestAnimationFrame(() =>
        document.getElementById(`security-${focusField}`)?.focus(),
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  async function copy(value: string, kind: 'codes' | 'secret') {
    try {
      if (!navigator.clipboard) throw new Error('unavailable');
      await navigator.clipboard.writeText(value);
      setCopyNotice(kind === 'codes' ? '恢复码已复制，请保存到安全的位置。' : '设置密钥已复制。');
    } catch {
      if (kind === 'codes') {
        const textarea = document.getElementById(
          'security-recovery-codes',
        ) as HTMLTextAreaElement | null;
        textarea?.focus();
        textarea?.select();
      }
      setCopyNotice('浏览器不允许自动复制，请选中文本后手动复制。');
    }
  }
  function downloadCodes() {
    if (!recoveryCodes) return;
    const value = `Tattoo 一次性恢复码\n管理员：${email}\n\n${recoveryCodes.join('\n')}\n\n每个恢复码只能使用一次，请离线妥善保管。重新生成后旧码全部失效。\n`;
    const url = URL.createObjectURL(new Blob([value], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'tattoo-recovery-codes.txt';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setCopyNotice('已开始下载，请确认文件已保存。');
  }
  const setupSeconds = setup
    ? Math.max(0, Math.ceil((Date.parse(setup.expiresAt) - now) / 1000))
    : 0;
  const requireFactor = Boolean(setup || status?.totpEnabled);
  const isSetupConfirm = action === 'setup' && Boolean(setup);

  function errorFor(field: Field) {
    return fieldErrors[field] ? (
      <p className="inline-error security-field-error" id={`security-${field}-error`} role="alert">
        {fieldErrors[field]}
      </p>
    ) : null;
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>账户安全</h1>
          <p className="secondary">管理自己的登录密码、双重验证与会话。</p>
        </div>
        <Button onClick={() => void refresh()} loading={loading} disabled={pending}>
          刷新安全状态
        </Button>
      </div>
      {notice && (
        <Alert type={noticeType} message={notice} closable onClose={() => setNotice('')} />
      )}
      {loadError && (
        <Alert
          type="error"
          message={loadError}
          action={
            <Button size="small" onClick={() => void refresh()}>
              重新读取安全状态
            </Button>
          }
        />
      )}
      {!status ? (
        <div className="loading-panel">
          {loading ? (
            <>
              <Spin />
              <p className="secondary">正在读取账户安全状态…</p>
            </>
          ) : (
            <p className="secondary">安全状态暂时无法显示，请重新读取。</p>
          )}
        </div>
      ) : (
        <div className="security-sections">
          <section className="surface security-card" aria-labelledby="security-password-title">
            <div className="security-card-icon">
              <Key size={20} aria-hidden />
            </div>
            <div className="security-card-copy">
              <h2 id="security-password-title">登录密码</h2>
              <p>当前管理员：{email}</p>
              <p className="form-note">
                修改时验证当前密码；成功后退出其他会话，当前浏览器继续登录。
              </p>
            </div>
            <Button disabled={pending || loading} onClick={() => begin('password')}>
              修改密码
            </Button>
          </section>
          <section className="surface security-card" aria-labelledby="security-totp-title">
            <div className="security-card-icon">
              <ShieldCheck size={20} aria-hidden />
            </div>
            <div className="security-card-copy">
              <div className="security-card-heading">
                <h2 id="security-totp-title">双重验证</h2>
                <Tag color={status.totpEnabled ? 'success' : 'default'}>
                  {status.totpEnabled ? '已启用' : '未启用'}
                </Tag>
              </div>
              <p>使用 Google Authenticator 或 Microsoft Authenticator 的动态验证码登录。</p>
              {status.totpEnabled ? (
                <>
                  <p className="form-note">
                    剩余 {status.recoveryCodesRemaining} 个一次性恢复码。重新生成会使旧码全部失效。
                  </p>
                  {status.recoveryCodesRemaining <= 2 && (
                    <Alert
                      type="warning"
                      message={
                        status.recoveryCodesRemaining
                          ? '恢复码剩余较少，建议生成并保存一组新码。'
                          : '当前没有可用恢复码，请生成并保存一组新码。'
                      }
                    />
                  )}
                </>
              ) : (
                <p className="form-note">
                  可使用任一兼容 TOTP 的验证器，不需要接入第三方登录服务。
                </p>
              )}
            </div>
            <div className="security-card-actions">
              {status.totpEnabled ? (
                <>
                  <Button disabled={pending || loading} onClick={() => begin('recovery')}>
                    重新生成恢复码
                  </Button>
                  <Button
                    type="text"
                    disabled={pending || loading}
                    onClick={() => begin('disable')}
                  >
                    关闭双重验证
                  </Button>
                </>
              ) : (
                <Button type="primary" disabled={pending || loading} onClick={() => begin('setup')}>
                  设置双重验证
                </Button>
              )}
            </div>
          </section>
          <section className="surface security-card" aria-labelledby="security-sessions-title">
            <div className="security-card-icon">
              <SignOut size={20} aria-hidden />
            </div>
            <div className="security-card-copy">
              <h2 id="security-sessions-title">登录会话</h2>
              <p>当前浏览器以外有 {status.otherSessionsCount} 个有效会话。</p>
              <p className="form-note">退出其他会话后，对方需要重新登录；当前浏览器保持登录。</p>
            </div>
            <Button disabled={pending || loading} onClick={() => begin('sessions')}>
              退出其他会话
            </Button>
          </section>
        </div>
      )}
      <Modal
        open={Boolean(action)}
        title={action ? actionTitles[action] : '账户安全'}
        width={600}
        footer={null}
        onCancel={() => void cancelAction()}
        closable={!pending}
        keyboard={!pending}
        maskClosable={false}
        className="security-dialog"
      >
        {action && (
          <form
            noValidate
            aria-label={actionTitles[action]}
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {actionError && (
              <div id="security-action-error">
                <Alert type="error" message={actionError} />
              </div>
            )}
            {action === 'disable' && (
              <Alert type="warning" message="关闭后，后续登录将只验证密码；现有恢复码全部失效。" />
            )}
            {action === 'recovery' && (
              <Alert type="warning" message="生成后旧恢复码立即失效，新码只在本次结果中显示。" />
            )}
            {action === 'sessions' && (
              <p className="secondary">验证身份后，退出当前浏览器以外的所有会话。</p>
            )}
            {isSetupConfirm && setup ? (
              <>
                <p className="secondary" id="security-setup-intro" tabIndex={-1}>
                  用 Google 或 Microsoft 验证器扫码，再输入当前验证码完成启用。
                </p>
                <div className="security-setup">
                  <div className="security-qr">
                    {qrImage ? (
                      <img
                        src={qrImage}
                        alt="用于绑定 Tattoo 的验证器二维码"
                        width={232}
                        height={232}
                      />
                    ) : qrError ? (
                      <span>使用下方密钥手动添加</span>
                    ) : (
                      <Spin />
                    )}
                  </div>
                  <div className="security-setup-instructions">
                    <h3>无法扫码时手动添加</h3>
                    <p className="form-note">
                      选择基于时间的验证码（TOTP）。账户名称可填写 Tattoo，验证器每 30 秒更新一次 6
                      位验证码。
                    </p>
                    <code className="security-manual-secret" aria-label="验证器设置密钥">
                      {setup.secret}
                    </code>
                    <Button
                      size="small"
                      disabled={pending}
                      icon={<Copy aria-hidden />}
                      onClick={() => void copy(setup.secret, 'secret')}
                    >
                      复制设置密钥
                    </Button>
                  </div>
                </div>
                {qrError && <Alert type="warning" message={qrError} />}
                {copyNotice && (
                  <p className="form-note" aria-live="polite">
                    {copyNotice}
                  </p>
                )}
                {setupSeconds ? (
                  <p className="form-note">
                    本次设置还剩 {Math.ceil(setupSeconds / 60)} 分钟；验证成功前不会启用。
                  </p>
                ) : (
                  <Alert type="warning" message="本次设置已过期，请取消后重新开始。" />
                )}
              </>
            ) : (
              <div className="form-field">
                <label htmlFor="security-currentPassword">当前密码</label>
                <Input.Password
                  id="security-currentPassword"
                  required
                  maxLength={256}
                  value={proof.currentPassword}
                  disabled={pending}
                  autoComplete="current-password"
                  autoFocus
                  aria-invalid={Boolean(fieldErrors.currentPassword) || undefined}
                  aria-describedby={
                    fieldErrors.currentPassword
                      ? 'security-currentPassword-error'
                      : actionError
                        ? 'security-action-error'
                        : undefined
                  }
                  onChange={(event) => changeProof({ currentPassword: event.target.value })}
                />
                {errorFor('currentPassword')}
              </div>
            )}
            {action === 'password' && (
              <>
                <div className="form-field">
                  <label htmlFor="security-newPassword">新密码</label>
                  <Input.Password
                    id="security-newPassword"
                    required
                    minLength={12}
                    maxLength={256}
                    value={newPassword}
                    disabled={pending}
                    autoComplete="new-password"
                    aria-invalid={Boolean(fieldErrors.newPassword) || undefined}
                    aria-describedby={
                      fieldErrors.newPassword
                        ? 'security-newPassword-error'
                        : 'security-password-help'
                    }
                    onChange={(event) => {
                      setNewPassword(event.target.value);
                      setFieldErrors((value) => ({
                        ...value,
                        newPassword: undefined,
                        confirmation: undefined,
                      }));
                    }}
                  />
                  <p className="form-note" id="security-password-help">
                    12 至 256 个字符，请使用独立的长密码。
                  </p>
                  {errorFor('newPassword')}
                </div>
                <div className="form-field">
                  <label htmlFor="security-confirmation">确认新密码</label>
                  <Input.Password
                    id="security-confirmation"
                    required
                    minLength={12}
                    maxLength={256}
                    value={confirmation}
                    disabled={pending}
                    autoComplete="new-password"
                    aria-invalid={Boolean(fieldErrors.confirmation) || undefined}
                    aria-describedby={
                      fieldErrors.confirmation ? 'security-confirmation-error' : undefined
                    }
                    onChange={(event) => {
                      setConfirmation(event.target.value);
                      setFieldErrors((value) => ({ ...value, confirmation: undefined }));
                    }}
                  />
                  {errorFor('confirmation')}
                </div>
              </>
            )}
            {requireFactor && (
              <div className="form-field">
                <div className="security-code-label">
                  <label htmlFor="security-code">
                    {proof.recovery && !isSetupConfirm ? '一次性恢复码' : '验证器验证码'}
                  </label>
                  {!isSetupConfirm && (
                    <Button
                      type="text"
                      size="small"
                      disabled={pending}
                      onClick={() => changeProof({ recovery: !proof.recovery, code: '' })}
                    >
                      {proof.recovery ? '使用验证器验证码' : '使用恢复码'}
                    </Button>
                  )}
                </div>
                <Input
                  id="security-code"
                  required
                  value={proof.code}
                  disabled={pending}
                  inputMode={proof.recovery ? 'text' : 'numeric'}
                  autoComplete={proof.recovery ? 'off' : 'one-time-code'}
                  spellCheck={false}
                  maxLength={proof.recovery ? 100 : 12}
                  placeholder={proof.recovery ? '输入完整恢复码' : '6 位验证码'}
                  className="security-code-input"
                  aria-invalid={Boolean(fieldErrors.code) || undefined}
                  aria-describedby={fieldErrors.code ? 'security-code-error' : 'security-code-help'}
                  onChange={(event) =>
                    changeProof({
                      code: proof.recovery
                        ? event.target.value
                        : event.target.value.replace(/\D/g, '').slice(0, 6),
                    })
                  }
                />
                {errorFor('code')}
                <p className="form-note" id="security-code-help">
                  {proof.recovery
                    ? '恢复码使用一次即失效，空格和连字符可保留。'
                    : '每组动态验证码仅可使用一次；刚使用过时，请等待验证器更新下一组。'}
                </p>
              </div>
            )}
            <div className="modal-actions">
              <Button onClick={() => void cancelAction()} disabled={pending}>
                取消
              </Button>
              <Button
                type="primary"
                danger={action === 'disable'}
                htmlType="submit"
                loading={pending}
                disabled={isSetupConfirm && setupSeconds === 0}
              >
                {action === 'setup' ? (setup ? '验证并启用' : '继续设置') : actionTitles[action]}
              </Button>
            </div>
          </form>
        )}
      </Modal>
      <Modal
        open={Boolean(recoveryCodes)}
        title="保存恢复码"
        width={600}
        footer={null}
        closable={false}
        keyboard={false}
        maskClosable={false}
        className="security-dialog"
      >
        <Alert
          type="warning"
          message="这组恢复码只在本次结果中显示"
          description="每个恢复码只能使用一次。手机丢失或验证器不可用时，可用其中一个恢复码登录。请离线保管，不要与密码放在同一处。"
        />
        <label className="field-label" htmlFor="security-recovery-codes">
          一次性恢复码
        </label>
        <Input.TextArea
          id="security-recovery-codes"
          readOnly
          autoComplete="off"
          value={recoveryCodes?.join('\n') ?? ''}
          rows={10}
          className="security-recovery-codes"
          spellCheck={false}
        />
        <div className="security-recovery-actions">
          <Button
            icon={<Copy aria-hidden />}
            onClick={() => void copy(recoveryCodes!.join('\n'), 'codes')}
          >
            复制恢复码
          </Button>
          <Button icon={<DownloadSimple aria-hidden />} onClick={downloadCodes}>
            下载恢复码
          </Button>
        </div>
        {copyNotice && (
          <p className="form-note" aria-live="polite">
            {copyNotice}
          </p>
        )}
        <div className="security-recovery-confirm">
          <Checkbox checked={codesSaved} onChange={(event) => setCodesSaved(event.target.checked)}>
            我已将这组恢复码保存到安全的地方
          </Checkbox>
        </div>
        <div className="modal-actions">
          <Button
            type="primary"
            disabled={!codesSaved}
            icon={<CheckCircle aria-hidden />}
            onClick={() => {
              setRecoveryCodes(null);
              setCodesSaved(false);
              setCopyNotice('');
            }}
          >
            完成
          </Button>
        </div>
      </Modal>
    </>
  );
}
