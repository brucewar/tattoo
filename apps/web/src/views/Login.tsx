import { useState } from 'react';
import { Alert, Button, Form, Input } from 'antd';
import { api, errorMessage, jsonRequest } from '../api';
import { Brand, type User } from '../ui';

export function Login({ onLogin, expired }: { onLogin: (user: User) => void; expired: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function login(values: { email: string; password: string }) {
    setPending(true);
    setError('');
    try {
      await api<User>('/auth/login', { method: 'POST', ...jsonRequest(values) });
      onLogin(await api<User>('/auth/me'));
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  }
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
        <div className="login-form-inner">
          <p className="eyebrow">欢迎回来</p>
          <h2>登录工作台</h2>
          <p className="secondary">使用部署时配置的管理员账号。</p>
          {expired && <Alert type="info" showIcon message="会话已过期，请重新登录。" />}
          {error && <Alert type="error" showIcon message={error} />}
          <Form layout="vertical" onFinish={login} requiredMark={false} size="large" name="login">
            <Form.Item
              name="email"
              label="管理员邮箱"
              rules={[
                { required: true, message: '请输入管理员邮箱' },
                { type: 'email', message: '请输入有效的邮箱地址' },
              ]}
            >
              <Input autoComplete="username" placeholder="请输入邮箱" autoFocus />
            </Form.Item>
            <Form.Item
              name="password"
              label="密码"
              rules={[{ required: true, message: '请输入密码' }]}
            >
              <Input.Password
                autoComplete="current-password"
                placeholder="请输入密码"
                maxLength={256}
              />
            </Form.Item>
            <Button block type="primary" htmlType="submit" loading={pending}>
              登录
            </Button>
          </Form>
          <p className="form-note">忘记密码时，请由部署管理员在服务器上重置。</p>
        </div>
      </section>
    </main>
  );
}
