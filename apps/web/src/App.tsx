import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Spin } from 'antd';
import { api, ApiError, errorMessage } from './api';
import { Brand, type User } from './ui';
import { Login } from './views/Login';
import { Accounts } from './views/Accounts';
import { Records } from './views/Records';

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [bootError, setBootError] = useState('');
  const [expired, setExpired] = useState(false);
  const [section, setSection] = useState<'accounts' | 'records'>('accounts');
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
      setUser(null);
    };
    window.addEventListener('tattoo:unauthorized', unauthorized);
    return () => window.removeEventListener('tattoo:unauthorized', unauthorized);
  }, []);
  async function logout() {
    setLoggingOut(true);
    setLogoutError('');
    try {
      await api('/auth/logout', { method: 'POST' });
      setExpired(false);
      setUser(null);
    } catch (failure) {
      setLogoutError(errorMessage(failure));
    } finally {
      setLoggingOut(false);
    }
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
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Brand />
          <span className="sidebar-subtitle">内容工作台</span>
        </div>
        <nav aria-label="工作台导航">
          <button
            type="button"
            aria-current={section === 'accounts' ? 'page' : undefined}
            className={section === 'accounts' ? 'active' : ''}
            onClick={() => setSection('accounts')}
          >
            公众号账号
          </button>
          <button
            type="button"
            aria-current={section === 'records' ? 'page' : undefined}
            className={section === 'records' ? 'active' : ''}
            onClick={() => setSection('records')}
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
        {section === 'accounts' ? (
          <Accounts
            remoteWritesEnabled={Boolean(user.remoteWritesEnabled)}
            onInspectRecords={() => setSection('records')}
          />
        ) : (
          <Records remoteWritesEnabled={Boolean(user.remoteWritesEnabled)} />
        )}
      </main>
    </div>
  );
}
