import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import '@fontsource-variable/manrope';
import './style.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfigProvider
      locale={zhCN}
      button={{ autoInsertSpace: false }}
      theme={{
        token: {
          colorPrimary: '#35634e',
          borderRadius: 8,
          controlHeight: 40,
          fontSize: 14,
          fontFamily: '"Manrope Variable", "Microsoft YaHei", sans-serif',
        },
      }}
    >
      <App />
    </ConfigProvider>
  </StrictMode>,
);
