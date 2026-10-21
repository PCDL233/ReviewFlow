import { createMiddleware } from 'hono/factory';
import type { MiddlewareHandler } from 'hono';

/**
 * 安全响应头中间件（方案 5：CSP / nosniff / 点击劫持 / 引荐来源 / 权限策略）。
 * SPA 同源托管（Hono 提供 API + 前端静态产物），antd 依赖内联样式与配置注入，
 * 故 style-src 放开 'unsafe-inline'；脚本仅允许本域，阻断跨域脚本注入。
 * 头在 await next() 之后设置：直接作用于最终响应（含 SSE 流式），且不触发
 * Hono 对 c.res 的惰性 Response 创建。
 */
export function securityHeaders(): MiddlewareHandler {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');

  return createMiddleware(async (c, next) => {
    await next();
    const headers = c.res.headers;
    // 仅在响应未自带同名头时补齐，避免覆盖业务语义
    if (headers.get('Content-Security-Policy') === null) {
      headers.set('Content-Security-Policy', csp);
    }
    if (headers.get('X-Content-Type-Options') === null) {
      headers.set('X-Content-Type-Options', 'nosniff');
    }
    if (headers.get('X-Frame-Options') === null) {
      headers.set('X-Frame-Options', 'DENY');
    }
    if (headers.get('Referrer-Policy') === null) {
      headers.set('Referrer-Policy', 'no-referrer');
    }
    if (headers.get('Permissions-Policy') === null) {
      headers.set(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      );
    }
    if (headers.get('Cross-Origin-Opener-Policy') === null) {
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    }
  });
}
