import { createMiddleware } from 'hono/factory';
import type { Context, MiddlewareHandler } from 'hono';

/**
 * 轻量内存固定窗口限流（方案 10：认证接口防爆破 + /api/* 泛化防 DoS）。
 * 以「IP（+可选路径）」为键在窗口内计数；超出上限返回 429 并附带 retry-after。
 * 注意：这是固定窗口（非滑动窗口），窗口边界处理论上可放过至多 2×max 的突发；
 * 对本场景（人机交互流量）足够，且实现零分配、可预期。
 * 进程内 Map 存储，触达内存上限时先清扫过期窗口、仍超限则按插入序强制淘汰最旧条目
 * ——内存硬性封顶，防止攻击者用海量伪造 IP 撑爆进程；多实例部署需换共享存储。
 */

type Window = { count: number; resetAt: number };

export interface RateLimitOptions {
  /** 窗口时长（毫秒） */
  windowMs: number;
  /** 窗口内允许的最大请求数 */
  max: number;
  /** 为 true 时按「IP+路径」独立计数（认证等按端点精确限流） */
  keyByPath?: boolean;
  /** 触发清理的内存上限（条数），防止攻击者用海量伪造 IP 撑爆内存 */
  maxEntries?: number;
}

/**
 * 从请求提取客户端 IP（限流与审计日志共用）。
 * - 默认优先底层 socket 地址（不可伪造），回退 x-forwarded-for 首个值
 * - AI_REVIEW_TRUST_PROXY=true 时反转优先级：反向代理（nginx 等）后面
 *   所有请求的 socket 地址都是代理 IP，须改用 XFF；此时取「最后一个」值——
 *   单层代理会把真实客户端 IP 追加在末尾，首值可被客户端伪造
 */
export function getClientIp(c: Context, trustProxy?: boolean): string {
  const useForwarded = trustProxy ?? process.env.AI_REVIEW_TRUST_PROXY === 'true';
  if (useForwarded) {
    const forwarded = c.req.header('x-forwarded-for');
    if (forwarded !== undefined && forwarded !== '') {
      const parts = forwarded.split(',');
      const last = parts[parts.length - 1]?.trim();
      if (last !== undefined && last !== '') return last;
    }
    // 无 XFF（如健康检查直连）：回退 socket 地址
    const direct = socketAddress(c);
    if (direct !== undefined) return direct;
    return 'unknown';
  }
  const direct = socketAddress(c);
  if (direct !== undefined) return direct;
  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded !== undefined && forwarded !== '') {
    return forwarded.split(',')[0]?.trim() ?? 'unknown';
  }
  return 'unknown';
}

function socketAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const addr = env?.incoming?.socket?.remoteAddress;
  return addr !== undefined && addr !== '' ? addr : undefined;
}

export function createRateLimiter(options: RateLimitOptions): MiddlewareHandler {
  const { windowMs, max, keyByPath = false, maxEntries = 10_000 } = options;
  const buckets = new Map<string, Window>();

  /** 触达内存上限时：先清扫过期窗口，仍超限则按插入序（最旧）强制淘汰，硬性封顶 */
  const sweep = (now: number): void => {
    if (buckets.size < maxEntries) return;
    for (const [key, window] of buckets) {
      if (now >= window.resetAt) buckets.delete(key);
    }
    while (buckets.size >= maxEntries) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  };

  return createMiddleware(async (c, next) => {
    const ip = getClientIp(c);
    const key = keyByPath ? `${ip}:${c.req.path}` : ip;
    const now = Date.now();

    sweep(now);

    let window = buckets.get(key);
    if (window === undefined || now >= window.resetAt) {
      window = { count: 0, resetAt: now + windowMs };
      buckets.set(key, window);
    }
    window.count += 1;

    if (window.count > max) {
      const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
      c.header('retry-after', String(retryAfter));
      return c.json({ error: '请求过于频繁，请稍后再试' }, 429);
    }

    await next();
  });
}
