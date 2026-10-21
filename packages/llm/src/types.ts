import type {
  AiReviewConfig,
  CodeContext,
  Finding,
  LlmRuntimeStatus,
  ReviewToolDescriptor,
} from '@ai-review/shared';

/**
 * LLM 传输层契约（方案 3.3/3.4 的“传输与语义分离”）。
 * Prompt 与维度评审标准由 @ai-review/agents 构造；本包只负责发送、超时、重试、usage 归一化与降级链，
 * 因此更换 Provider / AI SDK 不会影响审查语义。
 */

/** LLM 语义审查承担的三个维度（与 shared 的 AgentDimension 子集保持一致） */
export type ReviewDimension = 'correctness' | 'security' | 'performance';

/** 可走 HTTP 的服务商（mock 由内存 Provider 承担） */
export type HttpProviderKind = Exclude<AiReviewConfig['llm']['provider'], 'mock'>;

/** 单次传输的构造参数（HTTP 与 AI SDK 两条 transport 共用） */
export type HttpProviderOptions = {
  provider: HttpProviderKind;
  model: string;
  apiKey: string;
  baseUrl?: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  retries: number;
};

/** 模型调用失败的分类：决定是否重试以及报告中的可读原因 */
export type LlmErrorKind =
  | 'auth'
  | 'rate-limit'
  | 'timeout'
  | 'network'
  | 'http'
  | 'bad-response'
  | 'cancelled';

/** 带分类的模型调用错误（禁止静默吞错：调用方必须显式选择降级或失败） */
export class LlmError extends Error {
  constructor(
    message: string,
    public readonly kind: LlmErrorKind,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LlmError';
  }
}

/** 所有候选模型均不可用且配置为 fail 时抛出 */
export class LlmUnavailableError extends LlmError {
  constructor(
    message: string,
    public readonly attempts: readonly LlmAttempt[],
    options?: { cause?: unknown },
  ) {
    super(message, 'network', options);
    this.name = 'LlmUnavailableError';
  }
}

/** token 用量：provider 返回真实 usage 时 estimated=false；缺失时按字符数估算并显式标注 */
export type LlmUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
};

/** 单次模型尝试记录（报告与可观测页的数据源） */
export type LlmAttempt = {
  /** 主模型 / 备用模型 / mock 兜底 */
  kind: 'primary' | 'fallback' | 'mock';
  provider: string;
  model: string;
  status: 'succeeded' | 'failed';
  latencyMs: number;
  errorKind?: LlmErrorKind;
  message?: string;
};

/** 一次审查请求：system 为维度评审标准，prompt 为带证据的变更载荷 */
export type ReviewRequest = {
  dimension: ReviewDimension;
  system: string;
  prompt: string;
  /** 供 mock/回放与结果校验使用；真实传输不发送该字段 */
  context: CodeContext;
  temperature?: number;
  maxOutputTokens?: number;
  /** 只读工具（ReAct）；缺省表示单轮生成 */
  tools?: readonly ReviewToolDescriptor[];
  /** ReAct 最大步数（含工具调用轮次） */
  maxSteps?: number;
};

/** 一次审查结果：发现 + 用量 + 可解释状态 */
export type ReviewResult = {
  findings: Finding[];
  usage: LlmUsage;
  model: string;
  provider: string;
  latencyMs: number;
  /** 是否使用了备用模型或 mock 兜底 */
  fallbackUsed: boolean;
  /** ok=主模型 / degraded=备用模型 / mock=显式 mock / unavailable=全部失败后兜底 */
  status: LlmRuntimeStatus;
  attempts: readonly LlmAttempt[];
};

/** Provider 最小边界：真实模型、mock 与录制回放都遵循这一契约 */
export type ReviewProvider = {
  review(request: ReviewRequest, signal?: AbortSignal): Promise<ReviewResult>;
};

/**
 * 归一化 token 用量。
 * @param payload 原始响应
 * @param promptChars 请求字符数（用于估算兜底）
 * @param completionChars 响应字符数（用于估算兜底）
 * @returns 用量；provider 未返回 usage 时 estimated=true
 */
export function normalizeUsage(
  payload: unknown,
  promptChars: number,
  completionChars: number,
): LlmUsage {
  if (typeof payload === 'object' && payload !== null && 'usage' in payload) {
    const usage = (payload as { usage?: unknown }).usage;
    if (typeof usage === 'object' && usage !== null) {
      const record = usage as Record<string, unknown>;
      const promptTokens = numberOrUndefined(record.prompt_tokens ?? record.input_tokens);
      const completionTokens = numberOrUndefined(
        record.completion_tokens ?? record.output_tokens,
      );
      const totalTokens = numberOrUndefined(record.total_tokens);
      if (promptTokens !== undefined || completionTokens !== undefined || totalTokens !== undefined) {
        const prompt = promptTokens ?? Math.ceil(promptChars / 4);
        const completion = completionTokens ?? Math.ceil(completionChars / 4);
        return {
          promptTokens: prompt,
          completionTokens: completion,
          totalTokens: totalTokens ?? prompt + completion,
          estimated: promptTokens === undefined || completionTokens === undefined,
        };
      }
    }
  }
  return estimateUsage(promptChars, completionChars);
}

/**
 * 按字符数估算 token（约 4 字符/token）。
 * @param promptChars 请求字符数
 * @param completionChars 响应字符数
 * @returns 估算用量（estimated=true）
 */
export function estimateUsage(promptChars: number, completionChars: number): LlmUsage {
  const promptTokens = Math.ceil(promptChars / 4);
  const completionTokens = Math.ceil(completionChars / 4);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    estimated: true,
  };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
