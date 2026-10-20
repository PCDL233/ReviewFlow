import { ZodError } from 'zod';

/** zod 校验器的最小结构签名（避免依赖 zod 内部泛型的推导差异） */
type SchemaParser<T> = {
  safeParse(data: unknown): { success: true; data: T } | { success: false; error: unknown };
};

/**
 * API 响应统一经 zod 校验后返回（规范 §5.5 四链路之"API 响应"）。
 * 校验失败抛 ApiError，由调用方以统一错误 UI 呈现，禁止静默吞掉。
 */
export class ApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = 'ApiError';
    this.status = options?.status;
  }
}

/**
 * 会话过期后的全局处理回调（在 main.tsx 注册）。
 * 通过回调注册而非直接依赖 router/queryClient，避免 parse-response 与上层产生循环依赖。
 */
let unauthorizedHandler: (() => void) | undefined;
export function setUnauthorizedHandler(handler: (() => void) | undefined): void {
  unauthorizedHandler = handler;
}

/**
 * 统一错误消息翻译：
 * - ApiError → 服务端/契约层已转译的中文消息（含状态码前缀）
 * - ZodError → 响应契约不符
 * - TypeError → fetch 网络层失败（浏览器 fetch 拒绝时抛 TypeError）
 * - string → 直接作为消息（本地预校验等场景）
 * - 其余 Error → 原始 message；未知值 → 兜底文案
 */
export function getErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof ApiError) return error.message;
  if (error instanceof ZodError) return '响应数据不符合契约';
  if (error instanceof TypeError) return '网络连接失败，请检查网络后重试';
  if (error instanceof Error) return error.message;
  return '发生未知错误';
}

/** 提取 HTTP 状态码（仅 ApiError 携带；其余错误返回 undefined） */
export function getErrorStatus(error: unknown): number | undefined {
  return error instanceof ApiError ? error.status : undefined;
}

export type ParseResponseOptions = {
  /** 401 时不触发全局"会话过期"重定向（登录/注册等认证表单场景） */
  skipUnauthorizedRedirect?: boolean;
  /** 按调用覆盖全局状态前缀（认证端点等需上下文专属文案时使用） */
  statusMessages?: Partial<Record<number, string>>;
};

export async function parseResponse<T>(
  schema: SchemaParser<T>,
  response: Response,
  options?: ParseResponseOptions,
): Promise<T> {
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    let detail = bodyText;
    try {
      const parsed = JSON.parse(bodyText) as unknown;
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'error' in parsed &&
        typeof parsed.error === 'string'
      ) {
        detail = parsed.error;
      }
    } catch {
      // 非 JSON 错误体保留原始文本，便于定位代理或网关问题。
    }
    const statusMessage: Record<number, string> = {
      400: '请求参数有误',
      401: '登录已失效，请重新登录',
      403: '没有执行此操作的权限',
      404: '请求的资源不存在',
      409: '当前状态不允许执行此操作',
      413: '请求体过大',
      429: '请求过于频繁，请稍后再试',
      503: '服务暂不可用',
    };
    const prefix =
      options?.statusMessages?.[response.status] ??
      statusMessage[response.status] ??
      `请求失败（${response.status}）`;
    // 服务端 detail 与状态前缀一致（如 401 会话过期、413 请求体过大）时不重复拼接
    const message = detail === '' || detail === prefix ? prefix : `${prefix}：${detail}`;
    const apiError = new ApiError(message, {
      status: response.status,
    });
    // 统一处理 401：仅非认证表单请求触发全局会话过期重定向（方案 6）
    if (response.status === 401 && options?.skipUnauthorizedRedirect !== true) {
      unauthorizedHandler?.();
    }
    throw apiError;
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch (e) {
    throw new ApiError('API 返回了非 JSON 数据', { cause: e });
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new ApiError('响应数据不符合契约', { cause: result.error });
  }
  return result.data;
}
