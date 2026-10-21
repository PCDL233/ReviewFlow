import { ensureFindingFingerprint } from '@ai-review/shared';
import type {
  CodeContext,
  Finding,
  LlmRuntimeStatus,
  ReviewToolDescriptor,
} from '@ai-review/shared';
import type {
  LlmAttempt,
  LlmUsage,
  ReviewDimension,
  ReviewProvider,
  ReviewRequest,
} from '@ai-review/llm';
import { DIMENSION_PROFILES, buildSystemPrompt } from './dimensions.js';
import { buildReviewPrompt } from './prompt.js';
import { validateFindings } from './validate.js';
import type { RejectedFindingReason } from './validate.js';

/** 一次 Agent 审查的输入：上下文 + 确定性证据 + 项目约定 + 上一轮发现（自愈） */
export type ReviewAgentInput = {
  context: CodeContext;
  /** 静态工具的确定性发现（注入 prompt，供模型佐证/交叉验证） */
  evidence?: readonly Finding[];
  /** 项目约定摘要（AGENTS.md / CLAUDE.md / 规则说明） */
  conventions?: string;
  /** 自愈轮次：上一轮的低置信度发现 */
  priorFindings?: readonly Finding[];
  /** 是否为复核轮次（使用更严格的 system prompt） */
  strict?: boolean;
  /** 只读仓库工具（ReAct）；缺省为单轮生成 */
  tools?: readonly ReviewToolDescriptor[];
};

/** 一次 Agent 审查的输出：可用发现 + 真实用量 + 可解释状态 */
export type ReviewAgentOutput = {
  findings: Finding[];
  usage: LlmUsage;
  model: string;
  provider: string;
  latencyMs: number;
  status: LlmRuntimeStatus;
  attempts: readonly LlmAttempt[];
  /** 被校验拒绝的发现数（行号越界/文件不存在/schema） */
  rejected: number;
  /** 落在上下文行、不能直接阻断的发现数 */
  contextFindings: number;
  /** 拒绝原因分布（可观测数据） */
  rejectionReasons: Partial<Record<RejectedFindingReason, number>>;
  /** prompt 字符数（成本与上下文预算的诊断数据） */
  promptChars: number;
};

/**
 * 单维度审查器：负责“构造证据载荷 → 调用 Provider → 校验发现归属与行号”。
 * Provider 只负责传输；维度评审标准与输出校验都在本类，保证语义不随 Provider 漂移。
 */
export class ReviewAgent {
  constructor(
    private readonly provider: ReviewProvider,
    private readonly dimension: ReviewDimension,
  ) {}

  /**
   * 审查上下文并返回经过 schema 与行号校验的发现。
   * @param input 上下文、证据与复核输入
   * @param signal 全局取消信号
   * @returns 发现、用量与拒绝统计
   */
  public async review(input: ReviewAgentInput, signal?: AbortSignal): Promise<ReviewAgentOutput> {
    const profile = DIMENSION_PROFILES[this.dimension];
    const system = buildSystemPrompt(this.dimension, input.strict === true);
    const prompt = buildReviewPrompt(input);
    const request: ReviewRequest = {
      dimension: this.dimension,
      system,
      prompt,
      context: input.context,
      ...(profile.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: profile.maxOutputTokens }),
      ...(input.tools === undefined || input.tools.length === 0
        ? {}
        : { tools: input.tools, maxSteps: 6 }),
    };

    const result = await this.provider.review(request, signal);
    const validation = validateFindings(result.findings, input.context, this.dimension);
    return {
      findings: validation.findings.map((finding) => ensureFindingFingerprint(finding)),
      usage: result.usage,
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
      status: result.status,
      attempts: result.attempts,
      rejected: validation.rejected,
      contextFindings: validation.contextFindings,
      rejectionReasons: validation.reasons,
      promptChars: system.length + prompt.length,
    };
  }
}
