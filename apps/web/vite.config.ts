import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // React Compiler 自动 memoization（方案 3.10：全仓禁手写 useMemo/useCallback）；
  // plugin-react 6 为 oxc 内核，经 compiler 选项启用（需 oxc-transform-react）
  plugins: [react({ compiler: true })],
  // dev 期 API 转发到 Hono；生产由 Hono 同源托管静态产物，无需代理
  // /metrics 是 Prometheus 文本端点（非 /api 前缀），管理端指标页直接请求
  server: { proxy: { '/api': 'http://localhost:8080', '/metrics': 'http://localhost:8080' } },
  build: {
    rollupOptions: {
      output: {
        // Vite 8（Rolldown 内核）以 advancedChunks 取代 manualChunks 对象形式：
        // echarts 按需注册后仍较重，独立 chunk 利于浏览器缓存
        advancedChunks: {
          groups: [
            { name: 'echarts', test: /node_modules[\/]echarts[\/]/ },
            { name: 'antd', test: /node_modules[\/](antd|@ant-design|rc-[a-z-]+)[\/]/ },
          ],
        },
      },
    },
  },
});
