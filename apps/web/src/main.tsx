import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, Typography } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import '@fontsource-variable/manrope';
import './style.css';

function App() {
  const [connected, setConnected] = useState<boolean | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/health/ready', { signal: controller.signal })
      .then((response) => setConnected(response.ok))
      .catch(() => {
        if (!controller.signal.aborted) setConnected(false);
      });
    return () => controller.abort();
  }, []);
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#35634e',
          borderRadius: 8,
          fontFamily: '"Manrope Variable", "Microsoft YaHei", sans-serif',
        },
      }}
    >
      <main className="workspace">
        <header>
          <span className="wordmark">
            Tattoo<span className="brand-dot">.</span>
          </span>
          <span className="subtitle">内容工作台</span>
        </header>
        <section aria-labelledby="workspace-title">
          <p className="eyebrow">属于你的创作空间</p>
          <Typography.Title id="workspace-title" level={1}>
            让想法，留下印记。
          </Typography.Title>
          <p className="intro">从一份稿件开始，认真编辑，从容投递。</p>
          <p className="connection" role="status">
            {connected === null
              ? '正在连接工作台…'
              : connected
                ? '工作台连接正常'
                : '暂时无法连接，请稍后刷新重试'}
          </p>
        </section>
      </main>
    </ConfigProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
