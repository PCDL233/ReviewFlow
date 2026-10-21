import { z } from 'zod';

/**
 * LLM 运行时状态（报告与 Dashboard 的“本次审查是否真的由模型完成”契约）。
 * 该枚举必须能区分“模型正常”“降级到备用模型”“显式 mock”“全部失败”，
 * 避免出现“审查通过但其实没调用模型”的静默假象。
 */
export const LLM_RUNTIME_STATUSES = ['ok', 'degraded', 'mock', 'unavailable'] as const;
export type LlmRuntimeStatus = (typeof LLM_RUNTIME_STATUSES)[number];

/** 状态严重度排序：多维度并行时取“最差”状态作为整次审查的 LLM 状态 */
const LLM_STATUS_RANK: Record<LlmRuntimeStatus, number> = {
  ok: 0,
  degraded: 1,
  mock: 2,
  unavailable: 3,
};

/**
 * 合并多个维度的 LLM 状态。
 * @param left 当前状态；undefined 表示尚无维度上报
 * @param right 新状态
 * @returns 更差的一个（ok < degraded < mock < unavailable）
 */
export function worstLlmStatus(
  left: LlmRuntimeStatus | undefined,
  right: LlmRuntimeStatus,
): LlmRuntimeStatus {
  if (left === undefined) return right;
  return LLM_STATUS_RANK[right] > LLM_STATUS_RANK[left] ? right : left;
}

/**
 * 只读审查工具描述（ReAct 用）。
 * Agent 构造描述，传输层负责把描述适配为 AI SDK tool；工具本身在组合根（server）绑定仓库访问，
 * 因此 llm/agents 不直接依赖文件系统，也不会把任意路径读取能力带进提示词。
 */
export type ReviewToolDescriptor = {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  execute(input: unknown): Promise<string>;
};

/**
 * 单次模型尝试的审计记录（降级链的每一次尝试，不论成功失败）。
 * 与 LlmCallRecord 一起落库到 llm_calls.attempts_json，支撑“为什么换了模型/为什么失败”的追踪。
 */
export type LlmCallAttemptRecord = {
  kind: string;
  provider: string;
  model: string;
  status: 'succeeded' | 'failed';
  latencyMs: number;
  errorKind?: string;
  message?: string;
};

/**
 * 一次维度审查的模型调用记录（llm_calls 行；自愈轮次单独一行）。
 * 这是“审查是否真的调用模型、花了多少 token、是否降级”的唯一可查询事实源。
 */
export type LlmCallRecord = {
  dimension: string;
  provider: string;
  model: string;
  status: LlmRuntimeStatus;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
  latencyMs: number;
  promptChars: number;
  fallbackUsed: boolean;
  /** 0=首轮；1..=自愈轮次 */
  round: number;
  attempts: LlmCallAttemptRecord[];
};

/**
 * LLM 状态的中文标签（报告渲染与前端同一口径）。
 * @param status LLM 运行时状态
 * @returns 展示文案
 */
export function describeLlmStatus(status: LlmRuntimeStatus): string {
  switch (status) {
    case 'ok':
      return '模型审查正常';
    case 'degraded':
      return '主模型不可用，已降级到备用模型';
    case 'mock':
      return '当前为 mock 模式（未调用真实模型）';
    case 'unavailable':
      return '模型不可用，本次仅完成静态分析';
  }
}
