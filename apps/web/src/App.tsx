import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Modal, Spin } from './components/ui';
import {
  Files,
  Broadcast,
  Books,
  SlidersHorizontal,
  ClockCounterClockwise,
  List,
  SignOut,
  CaretRight,
  ShieldCheck,
} from '@phosphor-icons/react';
import { ThemePicker } from './theme';
import { api, ApiError, errorMessage } from './api';
import { Brand, type User } from './ui';
import { Login } from './views/Login';
import { Accounts } from './views/Accounts';
import { Records } from './views/Records';
import { Content } from './views/Content';
import { Models } from './views/Models';
import { Sources } from './views/Sources';
import { Security } from './views/Security';
import { isDemo } from './demo/mode';

type Section = 'content' | 'accounts' | 'records' | 'models' | 'sources' | 'security';
const sections = [
  { id: 'content', label: '内容', icon: Files },
  { id: 'sources', label: '资料', icon: Books },
  { id: 'records', label: '投递记录', icon: ClockCounterClockwise },
  { id: 'accounts', label: '公众号账号', icon: Broadcast },
  { id: 'models', label: '模型配置', icon: SlidersHorizontal },
  { id: 'security', label: '账户安全', icon: ShieldCheck },
] as const;

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [bootError, setBootError] = useState('');
  const [expired, setExpired] = useState(false);
  const [section, setSection] = useState<Section>('content');
  const [contentDirty, setContentDirty] = useState(false);
  const [modelsDirty, setModelsDirty] = useState(false);
  const [sourcesDirty, setSourcesDirty] = useState(false);
  const [securityDirty, setSecurityDirty] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const loadSession = useCallback(async () => {
    setBootError('');
    try {
      setUser(await api<User>('/auth/me'));
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) setUser(null);
      else {
        setUser(undefined);
        setBootError(errorMessage(failure));
      }
    }
  }, []);
  useEffect(() => {
    void loadSession();
  }, [loadSession]);
  useEffect(() => {
    const unauthorized = () => {
      setExpired(true);
      // Preserve the mounted editor until reauthentication restores the session.
      setUser((current) => current ?? null);
    };
    window.addEventListener('tattoo:unauthorized', unauthorized);
    return () => window.removeEventListener('tattoo:unauthorized', unauthorized);
  }, []);
  async function logout() {
    if (isDemo) {
      if (window.confirm('重置演示会清除本浏览器中的演示文章、修订与图片。确定继续吗？')) {
        const { resetDemo } = await import('./demo/api');
        resetDemo();
        window.location.reload();
      }
      return;
    }
    if (
      (contentDirty || modelsDirty || sourcesDirty || securityDirty) &&
      !window.confirm(
        securityDirty
          ? '账户安全有未完成的操作、未保存输入或恢复码。确定退出并放弃这些内容吗？'
          : sourcesDirty
            ? '搜索配置有未保存修改。确定退出并放弃修改吗？'
            : modelsDirty
              ? '模型配置有未保存修改。确定退出并放弃修改吗？'
              : '文章有未保存修改或正在处理的操作。确定退出并放弃本地编辑吗？',
      )
    )
      return;
    setLoggingOut(true);
    setLogoutError('');
    try {
      await api('/auth/logout', { method: 'POST' });
      setExpired(false);
      setUser(null);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 401) {
        setExpired(false);
        setUser(null);
      } else setLogoutError(errorMessage(failure));
    } finally {
      setLoggingOut(false);
    }
  }
  function navigate(next: Section) {
    if (next === section) {
      setMenuOpen(false);
      return;
    }
    if (
      (contentDirty || modelsDirty || sourcesDirty || securityDirty) &&
      !window.confirm(
        securityDirty
          ? '账户安全有未完成的操作、未保存输入或恢复码。确定离开并放弃这些内容吗？'
          : sourcesDirty
            ? '搜索配置有未保存修改。确定离开并放弃修改吗？'
            : modelsDirty
              ? '模型配置有未保存修改。确定离开并放弃修改吗？'
              : '文章有未保存修改或正在处理的操作。确定离开并放弃本地编辑吗？',
      )
    )
      return;
    setContentDirty(false);
    setModelsDirty(false);
    setSourcesDirty(false);
    setSecurityDirty(false);
    setSection(next);
    setMenuOpen(false);
  }
  function navigation() {
    return (
      <nav aria-label="工作台导航">
        {sections.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            aria-current={section === id ? 'page' : undefined}
            className={section === id ? 'active' : ''}
            onClick={() => navigate(id)}
          >
            <Icon size={18} aria-hidden />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    );
  }
  if (user === undefined)
    return (
      <main className="boot-screen">
        <Brand />
        {bootError ? (
          <>
            <Alert type="error" showIcon message={bootError} />
            <Button onClick={loadSession}>重新连接</Button>
          </>
        ) : (
          <>
            <Spin />
            <p className="secondary">正在打开工作台…</p>
          </>
        )}
      </main>
    );
  if (user === null)
    return (
      <Login
        expired={expired}
        onLogin={(session) => {
          setExpired(false);
          setUser(session);
          window.dispatchEvent(new Event('tattoo:authenticated'));
        }}
      />
    );
  return (
    <>
      <a href="#workspace-main" className="skip-link">
        跳到主要内容
      </a>
      <div
        className="app-shell"
        inert={expired}
        aria-hidden={expired || undefined}
        style={expired ? { visibility: 'hidden' } : undefined}
      >
        <aside className="sidebar">
          <div className="sidebar-brand">
            <Brand />
            <span className="sidebar-subtitle">内容工作台</span>
          </div>
          <p className="nav-caption">工作空间</p>
          {navigation()}
          <div className="sidebar-footer">
            <ThemePicker />
            <div className="user-profile">
              <span className="user-avatar" aria-hidden>
                {user.email.slice(0, 1).toUpperCase()}
              </span>
              <div>
                <span className="secondary">管理员</span>
                <span className="user-email">{user.email}</span>
              </div>
            </div>
            <Button
              type="text"
              size="small"
              onClick={logout}
              loading={loggingOut}
              icon={<SignOut aria-hidden />}
            >
              {isDemo ? '重置演示' : '退出登录'}
            </Button>
          </div>
        </aside>
        <div className="workspace-area">
          <header className="workspace-header">
            <Button
              className="mobile-menu-button"
              type="text"
              size="small"
              aria-label="打开导航"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              <List size={20} aria-hidden />
            </Button>
            <span className="breadcrumb-root">工作空间</span>
            <CaretRight size={12} aria-hidden />
            <span>{sections.find((item) => item.id === section)?.label}</span>
            <span className="workspace-local">个人工作台</span>
          </header>
          <main className="main-content" id="workspace-main" tabIndex={-1}>
            {isDemo && (
              <Alert
                type="info"
                showIcon
                message="在线演示 · 修改仅保存在当前浏览器；AI 使用固定示例，微信投递、联网采集与凭证保存已关闭。请勿输入真实密钥或密码。"
                action={
                  <a
                    href="https://github.com/brucewar/tattoo#快速部署"
                    target="_blank"
                    rel="noreferrer"
                  >
                    部署自己的工作台
                  </a>
                }
              />
            )}
            {logoutError && <Alert type="error" showIcon message={logoutError} />}
            {section === 'content' ? (
              <Content
                onDirtyChange={setContentDirty}
                remoteWritesEnabled={Boolean(user.remoteWritesEnabled)}
                onInspectRecords={() => navigate('records')}
                onConfigureModels={() => navigate('models')}
              />
            ) : section === 'accounts' ? (
              <Accounts
                remoteWritesEnabled={Boolean(user.remoteWritesEnabled)}
                onInspectRecords={() => navigate('records')}
              />
            ) : section === 'models' ? (
              <Models onDirtyChange={setModelsDirty} />
            ) : section === 'sources' ? (
              <Sources onDirtyChange={setSourcesDirty} />
            ) : section === 'security' ? (
              <Security email={user.email} onDirtyChange={setSecurityDirty} />
            ) : (
              <Records remoteWritesEnabled={Boolean(user.remoteWritesEnabled)} />
            )}
          </main>
        </div>
      </div>
      {expired && (
        <div className="session-expired-scrim" data-ui="session-expired-scrim" aria-hidden="true" />
      )}
      <Modal
        open={menuOpen && !expired}
        title="工作台导航"
        width={320}
        footer={null}
        onCancel={() => setMenuOpen(false)}
        className="mobile-navigation"
      >
        <div className="sidebar-brand">
          <Brand />
        </div>
        {navigation()}
        <ThemePicker />
        <div className="user-profile">
          <span className="user-email">{user.email}</span>
        </div>
        <Button
          type="text"
          onClick={() => {
            setMenuOpen(false);
            void logout();
          }}
          loading={loggingOut}
          icon={<SignOut aria-hidden />}
        >
          {isDemo ? '重置演示' : '退出登录'}
        </Button>
        <Button onClick={() => setMenuOpen(false)}>关闭导航</Button>
      </Modal>
      <Modal
        open={expired}
        title="会话已过期，请重新登录"
        footer={null}
        closable={false}
        maskClosable={false}
        keyboard={false}
        width={480}
        zIndex={2000}
        destroyOnClose
      >
        <Login
          embedded
          expired
          email={user.email}
          onLogin={(session) => {
            setExpired(false);
            setUser(session);
            window.dispatchEvent(new Event('tattoo:authenticated'));
          }}
        />
      </Modal>
    </>
  );
}
