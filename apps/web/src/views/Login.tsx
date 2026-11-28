import { useEffect, useRef, useState } from 'react';
import type { LoginResponse } from '@tattoo/contracts';
import { Alert, Button, Input } from '../components/ui';
import { ThemePicker } from '../theme';
import { api, ApiError, errorMessage, jsonRequest } from '../api';
import { Brand, type User } from '../ui';
import './security.css';

export function Login({
  onLogin,
  expired,
  embedded = false,
  email,
}: {
  onLogin: (user: User) => void;
  expired: boolean;
  embedded?: boolean;
  email?: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [values, setValues] = useState({ email: email ?? '', password: '' });
  const [challengeExpiresAt, setChallengeExpiresAt] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [codeError, setCodeError] = useState('');
  const [now, setNow] = useState(Date.now);
  const [canceling, setCanceling] = useState(false);
  const [sessionPending, setSessionPending] = useState(false);
  const submitting = useRef(false);
  const prefix = embedded ? 'reauth' : 'login';
  useEffect(() => {
    if (!challengeExpiresAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [challengeExpiresAt]);
  async function readSession() {
    setSessionPending(true);
    try {
      const session = await api<User>('/auth/me');
      onLogin(session);
      setSessionPending(false);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        setSessionPending(false);
        setChallengeExpiresAt(null);
        setCode('');
        setCodeError('');
        setRecovery(false);
        setValues((value) => ({ ...value, password: '' }));
      }
      throw failure;
    }
  }
  async function login(values: { email: string; password: string }) {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      const result = await api<LoginResponse>('/auth/login', {
        method: 'POST',
        ...jsonRequest(values),
      });
      if ('mfaRequired' in result && result.mfaRequired) {
        setChallengeExpiresAt(result.challengeExpiresAt);
        setValues((value) => ({ ...value, password: '' }));
        setCode('');
        setRecovery(false);
        setCodeError('');
        return;
      }
      setValues((value) => ({ ...value, password: '' }));
      await readSession();
    } catch (failure) {
      setError(errorMessage(failure));
      if (failure instanceof ApiError && (failure.status === 0 || failure.status >= 500))
        setSessionPending(true);
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  async function verify() {
    if (submitting.current) return;
    const normalized = code.replace(/[\s-]/g, '').toUpperCase();
    if (recovery ? !/^[0-9A-F]{32}$/.test(normalized) : !/^\d{6}$/.test(normalized)) {
      setCodeError(recovery ? '请输入完整的一次性恢复码' : '请输入验证器中的 6 位验证码');
      document.getElementById(`${prefix}-verification-code`)?.focus();
      return;
    }
    submitting.current = true;
    setPending(true);
    setError('');
    setCodeError('');
    try {
      await api<User>('/auth/login/verify', {
        method: 'POST',
        ...jsonRequest({ code: normalized }),
      });
      setCode('');
      setChallengeExpiresAt(null);
      await readSession();
    } catch (failure) {
      const message = errorMessage(failure);
      setError(message);
      setCode('');
      if (failure instanceof ApiError && failure.status === 400) {
        setCodeError(message);
        setError('');
      }
      if (failure instanceof ApiError && failure.status === 401) {
        setChallengeExpiresAt(null);
        setRecovery(false);
        setCodeError('');
        setValues((value) => ({ ...value, password: '' }));
      } else if (failure instanceof ApiError && (failure.status === 0 || failure.status >= 500)) {
        setSessionPending(true);
      }
      window.requestAnimationFrame(() =>
        document.getElementById(`${prefix}-verification-code`)?.focus(),
      );
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  async function cancelChallenge() {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setCanceling(true);
    setError('');
    try {
      await api('/auth/login/cancel', { method: 'POST', ...jsonRequest({}) });
    } catch (failure) {
      setError(`${errorMessage(failure)}。可以重新输入密码开始登录；旧验证请求会自动过期。`);
    } finally {
      setChallengeExpiresAt(null);
      setCode('');
      setCodeError('');
      setRecovery(false);
      setSessionPending(false);
      setValues((value) => ({ ...value, password: '' }));
      submitting.current = false;
      setPending(false);
      setCanceling(false);
    }
  }
  async function retrySession() {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError('');
    try {
      await readSession();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }
  const challengeExpired = challengeExpiresAt !== null && Date.parse(challengeExpiresAt) <= now;
  const form = (
    <div className="login-form-inner">
      {!embedded && (
        <>
          <p className="eyebrow">欢迎回来</p>
          <h2>登录工作台</h2>
          <p className="secondary">使用部署时配置的管理员账号。</p>
        </>
      )}
      {expired && (
        <Alert
          type="info"
          showIcon
          message={
            embedded
              ? '未保存的文章仍保留在当前页面。重新登录后可以继续保存，请勿关闭或刷新页面。'
              : '会话已过期，请重新登录。'
          }
        />
      )}
      {error && <Alert type="error" showIcon message={error} />}
      {sessionPending ? (
        <div className="workspace-form">
          <p className="secondary">
            正在确认当前浏览器的登录状态。此步骤只读取会话，不会重复提交验证码。
          </p>
          <Button block type="primary" onClick={() => void retrySession()} loading={pending}>
            重新读取登录状态
          </Button>
          <div className="login-factor-actions">
            <Button
              type="text"
              size="small"
              disabled={pending}
              onClick={() => void cancelChallenge()}
            >
              返回密码登录
            </Button>
          </div>
        </div>
      ) : challengeExpiresAt ? (
        <form
          className="workspace-form"
          noValidate
          aria-label="双重验证登录"
          onSubmit={(event) => {
            event.preventDefault();
            if (!challengeExpired) void verify();
          }}
        >
          <div className="login-factor-intro">
            <h3>验证你的身份</h3>
            <p className="secondary">
              {recovery
                ? '输入一个尚未使用的恢复码。'
                : '打开验证器，输入 Tattoo 账户当前的 6 位验证码。'}
            </p>
          </div>
          {challengeExpired && (
            <Alert type="warning" message="本次登录验证已过期，请返回并重新输入密码。" />
          )}
          <div className="form-field">
            <label htmlFor={`${prefix}-verification-code`}>
              {recovery ? '一次性恢复码' : '验证器验证码'}
            </label>
            <Input
              id={`${prefix}-verification-code`}
              required
              value={code}
              onChange={(event) => {
                setCode(
                  recovery ? event.target.value : event.target.value.replace(/\D/g, '').slice(0, 6),
                );
                setCodeError('');
                setError('');
              }}
              inputMode={recovery ? 'text' : 'numeric'}
              autoComplete={recovery ? 'off' : 'one-time-code'}
              maxLength={recovery ? 100 : 12}
              disabled={pending || challengeExpired}
              placeholder={recovery ? '输入完整恢复码' : '6 位验证码'}
              className="security-code-input"
              autoFocus
              aria-invalid={Boolean(codeError) || undefined}
              aria-describedby={codeError ? `${prefix}-code-error` : `${prefix}-code-help`}
            />
            {codeError && (
              <p className="inline-error" id={`${prefix}-code-error`} role="alert">
                {codeError}
              </p>
            )}
            <p className="form-note" id={`${prefix}-code-help`}>
              {recovery
                ? '恢复码使用一次即失效，空格和连字符可保留。'
                : '每组动态验证码仅可使用一次；刚使用过时，请等待验证器更新下一组。'}
            </p>
          </div>
          <Button
            block
            type="primary"
            htmlType="submit"
            loading={pending && !canceling}
            disabled={pending || challengeExpired}
          >
            验证并登录
          </Button>
          <div className="login-factor-actions">
            <Button
              type="text"
              size="small"
              disabled={pending || challengeExpired}
              onClick={() => {
                setRecovery((value) => !value);
                setCode('');
                setCodeError('');
                setError('');
              }}
            >
              {recovery ? '使用验证器验证码' : '使用恢复码'}
            </Button>
            <Button
              type="text"
              size="small"
              disabled={pending}
              loading={canceling}
              onClick={() => void cancelChallenge()}
            >
              返回密码登录
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="workspace-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending) void login(values);
          }}
        >
          <div className="form-field">
            <label htmlFor={embedded ? 'reauth-email' : 'login-email'}>管理员邮箱</label>
            <Input
              id={embedded ? 'reauth-email' : 'login-email'}
              type="email"
              required
              value={values.email}
              onChange={(event) => setValues({ ...values, email: event.target.value })}
              disabled={pending}
              autoComplete="username"
              placeholder="请输入邮箱"
              autoFocus
            />
          </div>
          <div className="form-field">
            <label htmlFor={embedded ? 'reauth-password' : 'login-password'}>密码</label>
            <Input.Password
              id={embedded ? 'reauth-password' : 'login-password'}
              required
              value={values.password}
              onChange={(event) => setValues({ ...values, password: event.target.value })}
              disabled={pending}
              autoComplete="current-password"
              placeholder="请输入密码"
              maxLength={256}
            />
          </div>
          <Button
            block
            type="primary"
            htmlType="submit"
            aria-label="登录"
            aria-busy={pending}
            loading={pending}
          >
            登录
          </Button>
        </form>
      )}
      <p className="form-note">忘记密码时，请由部署管理员在服务器上重置。</p>
    </div>
  );
  if (embedded) return form;
  return (
    <main className="login-layout">
      <section className="login-intro" aria-label="Tattoo 内容工作台">
        <Brand />
        <div>
          <p className="eyebrow">属于你的创作空间</p>
          <h1>
            让想法，
            <br />
            留下印记。
          </h1>
          <p className="login-copy">
            认真打磨每一份内容，
            <br />
            把发布前的准备，留在自己的工作台。
          </p>
        </div>
        <p className="login-footnote">自托管 · 内容创作与投递</p>
      </section>
      <section className="login-form-panel">
        <div className="login-theme">
          <ThemePicker />
        </div>
        {form}
      </section>
    </main>
  );
}
