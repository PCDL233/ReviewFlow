import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  ApiError,
  getErrorMessage,
  getErrorStatus,
  parseResponse,
  setUnauthorizedHandler,
} from '../src/parse-response';
import { localizeApiError } from '../src/api/auth';

const AnySchema = {
  safeParse: (data: unknown) =>
    typeof data === 'object' && data !== null && 'ok' in data
      ? { success: true as const, data }
      : { success: false as const, error: new ZodError([]) },
};

describe('parse-response unified error plumbing', () => {
  it('maps every error kind to a unified Chinese message', () => {
    expect(getErrorMessage(new ApiError('请求参数有误'))).toBe('请求参数有误');
    expect(getErrorMessage(new TypeError('Failed to fetch'))).toBe(
      '网络连接失败，请检查网络后重试',
    );
    expect(getErrorMessage(new ZodError([]))).toBe('响应数据不符合契约');
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
    expect(getErrorMessage('本地预校验文案')).toBe('本地预校验文案');
    expect(getErrorMessage(42)).toBe('发生未知错误');
    expect(getErrorMessage(null)).toBe('发生未知错误');
  });

  it('extracts the HTTP status only from ApiError', () => {
    expect(getErrorStatus(new ApiError('x', { status: 429 }))).toBe(429);
    expect(getErrorStatus(new Error('x'))).toBeUndefined();
    expect(getErrorStatus(new ZodError([]))).toBeUndefined();
  });

  it('throws ApiError with status and fires the 401 handler, unless explicitly skipped', async () => {
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    try {
      await expect(
        parseResponse(AnySchema, new Response('{"error":"expired"}', { status: 401 })),
      ).rejects.toMatchObject({ status: 401, name: 'ApiError' });
      expect(handler).toHaveBeenCalledTimes(1);

      // 认证表单（login/register）显式跳过全局重定向
      await expect(
        parseResponse(AnySchema, new Response('{"error":"bad"}', { status: 401 }), {
          skipUnauthorizedRedirect: true,
        }),
      ).rejects.toMatchObject({ status: 401 });
      expect(handler).toHaveBeenCalledTimes(1);

      // 非 401 错误不触发会话过期回调
      await expect(
        parseResponse(AnySchema, new Response('{"error":"no"}', { status: 403 })),
      ).rejects.toMatchObject({ status: 403 });
      expect(handler).toHaveBeenCalledTimes(1);
    } finally {
      setUnauthorizedHandler(undefined);
    }
  });

  it('composes status prefix with server detail for non-ok responses', async () => {
    await expect(
      parseResponse(AnySchema, new Response('{"error":"nope"}', { status: 403 })),
    ).rejects.toThrow('没有执行此操作的权限：nope');
    await expect(
      parseResponse(AnySchema, new Response('plain text', { status: 500 })),
    ).rejects.toThrow('请求失败（500）：plain text');
  });

  it('maps 413/503 statuses to friendly prefixes and dedupes identical detail', async () => {
    await expect(
      parseResponse(AnySchema, new Response('{"error":"请求体过大"}', { status: 413 })),
    ).rejects.toThrow('请求体过大');
    await expect(
      parseResponse(AnySchema, new Response('{"error":"x"}', { status: 413 })),
    ).rejects.toThrow('请求体过大：x');
    await expect(parseResponse(AnySchema, new Response('', { status: 503 }))).rejects.toThrow(
      '服务暂不可用',
    );
    // 401 会话过期：服务端 detail 与前缀一致时不重复拼接
    await expect(
      parseResponse(AnySchema, new Response('{"error":"登录已失效，请重新登录"}', { status: 401 })),
    ).rejects.toThrow('登录已失效，请重新登录');
  });

  it('supports per-call status message overrides', async () => {
    await expect(
      parseResponse(AnySchema, new Response('{"error":"bad"}', { status: 409 }), {
        statusMessages: { 409: '用户名已被占用，请更换一个' },
      }),
    ).rejects.toThrow('用户名已被占用，请更换一个：bad');
  });

  it('rejects non-JSON bodies and schema-invalid payloads', async () => {
    await expect(parseResponse(AnySchema, new Response('<html>oops</html>'))).rejects.toThrow(
      'API 返回了非 JSON 数据',
    );
    await expect(parseResponse(AnySchema, new Response('{"nope":true}'))).rejects.toThrow(
      '响应数据不符合契约',
    );
  });

  it('localizes auth errors by status code (auth-context copy)', () => {
    expect(
      localizeApiError(new ApiError('x', { status: 401 }), {
        401: '用户名或密码错误',
      }),
    ).toMatchObject({ message: '用户名或密码错误', status: 401 });
    // 未命中映射的错误原样透传
    const raw = new ApiError('其他错误', { status: 500 });
    expect(localizeApiError(raw, { 401: '用户名或密码错误' })).toBe(raw);
    // 非 ApiError 透传
    const e = new Error('boom');
    expect(localizeApiError(e, { 401: 'x' })).toBe(e);
  });
});
