import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Modal, Spin } from 'antd';
import { api, ApiError, errorMessage } from './api';
import { Brand, type User } from './ui';
import { Login } from './views/Login';
import { Accounts } from './views/Accounts';
import { Records } from './views/Records';
import { Content } from './views/Content';

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [bootError, setBootError] = useState('');
  const [expired, setExpired] = useState(false);
  const [section, setSection] = useState<'content' | 'accounts' | 'records'>('content');
  const [contentDirty, setContentDirty] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
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
    if (
      contentDirty &&
      !window.confirm('文章有未保存修改或正在处理的操作。确定退出并放弃本地编辑吗？')
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
  function navigate(next: 'content' | 'accounts' | 'records') {
    if (next === section) return;
    if (
      contentDirty &&
      !window.confirm('文章有未保存修改或正在处理的操作。确定离开并放弃本地编辑吗？')
    )
      return;
    setContentDirty(false);
    setSection(next);
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
        }}
      />
    );
  return (
    <>
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
          <nav aria-label="工作台导航">
            <button
              type="button"
              aria-current={section === 'content' ? 'page' : undefined}
              className={section === 'content' ? 'active' : ''}
              onClick={() => navigate('content')}
            >
              内容
            </button>
            <button
              type="button"
              aria-current={section === 'accounts' ? 'page' : undefined}
              className={section === 'accounts' ? 'active' : ''}
              onClick={() => navigate('accounts')}
            >
              公众号账号
            </button>
            <button
              type="button"
              aria-current={section === 'records' ? 'page' : undefined}
              className={section === 'records' ? 'active' : ''}
              onClick={() => navigate('records')}
            >
              投递记录
            </button>
          </nav>
          <div className="sidebar-footer">
            <span className="secondary">管理员</span>
            <span className="user-email">{user.email}</span>
            <Button size="small" onClick={logout} loading={loggingOut}>
              退出登录
            </Button>
          </div>
        </aside>
        <main className="main-content">
          {logoutError && <Alert type="error" showIcon message={logoutError} />}
          {section === 'content' ? (
            <Content
              onDirtyChange={setContentDirty}
              remoteWritesEnabled={Boolean(user.remoteWritesEnabled)}
              onInspectRecords={() => navigate('records')}
            />
          ) : section === 'accounts' ? (
            <Accounts
              remoteWritesEnabled={Boolean(user.remoteWritesEnabled)}
              onInspectRecords={() => navigate('records')}
            />
          ) : (
            <Records remoteWritesEnabled={Boolean(user.remoteWritesEnabled)} />
          )}
        </main>
      </div>
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
          }}
        />
      </Modal>
    </>
  );
}
