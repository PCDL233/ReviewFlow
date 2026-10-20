import { StrictMode, Suspense } from 'react';
import type { ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { GlobalFeedbackBridge } from './components/GlobalFeedbackBridge';
import { RouteLoading } from './components/RouteState';
import { queryClient } from './query-client';
import { router } from './router';
import { ThemeProvider, useTheme } from './theme-context';
import { createAntdTheme } from './antd-theme';
import { setUnauthorizedHandler } from './parse-response';
import { AUTH_QUERY_KEY } from './hooks/use-auth';
import './styles.css';

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('missing #root element');

// 会话过期（401）全局处理：清除本地认证缓存并跳转登录页（带回跳地址）。
// 在模块顶层注册，登录/注册表单内的 401 由调用方显式跳过，不会误触发。
setUnauthorizedHandler(() => {
  queryClient.setQueryData(AUTH_QUERY_KEY, null);
  const current = window.location.pathname + window.location.search;
  if (current === '/login' || current.startsWith('/register')) return;
  const target = current === '/' ? '/login' : `/login?redirect=${encodeURIComponent(current)}`;
  window.location.assign(target);
});

function AppRoot(): ReactElement {
  const { mode } = useTheme();

  return (
    <ConfigProvider locale={zhCN} theme={createAntdTheme(mode)}>
      <AntdApp>
        {/* 全局兜底监听：必须位于 <AntdApp> 内部才能拿到真实 message 实例 */}
        <GlobalFeedbackBridge />
        {/* 渲染期兜底：组件抛错时展示统一错误页而非白屏 */}
        <AppErrorBoundary>
          {/* 路由级懒加载所需的 Suspense 边界 */}
          <Suspense fallback={<RouteLoading />}>
            <RouterProvider router={router} />
          </Suspense>
        </AppErrorBoundary>
      </AntdApp>
    </ConfigProvider>
  );
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AppRoot />
      </ThemeProvider>
    </QueryClientProvider>
  </StrictMode>,
);
