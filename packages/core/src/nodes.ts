import { createHash } from 'node:crypto';
import pMap from 'p-map';
import { ReviewAgent, REVIEW_PROMPT_VERSION, validateFindings } from '@ai-review/agents';
import { DiffContextBuilder } from '@ai-review/diff';
import type { GitReader } from '@ai-review/diff';
import type { LlmUsage, ReviewDimension, ReviewProvider, TokenBudget } from '@ai-review/llm';
import type { ToolRegistry } from '@ai-review/tools';
import { worstLlmStatus } from '@ai-review/shared';
import type {
  CodeContext,
  Finding,
  FileContext,
  FileDiff,
  FileHistory,
  IgnoreRules,
  LlmCallRecord,
  LlmRuntimeStatus,
  RagRetriever,
  ReviewMetrics,
  ReviewPlan,
  ReviewSource,
  ReviewToolDescriptor,
} from '@ai-review/shared';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import { crossValidate } from './cross-validate.js';
import { RiskPlanner } from './risk-planner.js';
import type { ReviewState } from './state.js';

/** LLM 语义审查承担的三个维度（方案 3.3 三 Agent）；static 由工具总线产出 */
const LLM_DIMENSIONS = ['correctness', 'security', 'performance'] as const;
export type LlmDimension = ReviewDimension;

function isLlmDimension(value: string): value is LlmDimension {
  return LLM_DIMENSIONS.some((dimension) => dimension === value);
}

/**
 * 将配置的 review.dimensions 收敛为可执行的 LLM 维度集合。
 * 配置为空或缺省时退回全量三维；无法执行的维度（如 maintainability）显式丢弃。
 * @param configured 配置中的维度名
 * @returns 实际参与 fan-out 的维度（顺序固定，保证图结构稳定）
 */
export function resolveReviewDimensions(configured?: readonly string[]): LlmDimension[] {
  if (configured === undefined || configured.length === 0) return [...LLM_DIMENSIONS];
  const selected = configured.filter(isLlmDimension);
  return selected.length === 0 ? [...LLM_DIMENSIONS] : [...new Set(selected)];
}

/** 审查缓存 Prompt 版本（缓存键的组成：内容哈希 + 维度 + prompt 版本） */
export { REVIEW_PROMPT_VERSION } from '@ai-review/agents';

/**
 * 审查缓存接口（方案 3.0 步骤 8：内容哈希去重，相同代码块 + 相同维度不重复消耗 LLM）。
 * 面向接口注入（规范 §4.1）：生产为 db 包的 SQLite 表实现，测试可用内存 Map 替换。
 */
export type ReviewCache = {
  /** @returns 命中时返回该维度对该代码块的发现；未命中返回 undefined（损坏条目同样按未命中降级） */
  get(key: string): Promise<Finding[] | undefined>;
  /** @param tokenSaved 该条目下次命中可省去的预估 token（供 review_cache.token_saved 记账） */
  set(key: string, findings: Finding[], tokenSaved: number): Promise<void>;
};

/** 自愈回退触发条件：BLOCKER 置信度低于该阈值（方案 3.7/3.9 routeAfterValidate） */
export const HEAL_CONFIDENCE_THRESHOLD = 0.6;
/** 自愈回退轮次上限（方案 3.7：最多 3 轮） */
export const MAX_HEAL_ROUNDS = 3;

/** 流水线依赖：全部面向接口注入（规范 §4.1），节点工厂经闭包捕获 */
export type PipelineDeps = {
  gitReader: GitReader;
  rag: RagRetriever;
  ignores: IgnoreRules;
  history: FileHistory;
  /** LLM 审查维度的 Provider；fast 模式仅 deep 文件，full 模式 deep+quick */
  providers: Record<LlmDimension, ReviewProvider>;
  registry: ToolRegistry;
  mode: 'fast' | 'full';
  /** 仓库根：RAG 按仓库隔离索引，同时用于读取项目约定 */
  repoPath?: string | undefined;
  /** 审查来源（暂存区/工作区/单提交/区间）；缺省为暂存区 */
  source?: ReviewSource | undefined;
  /** 实际启用的 LLM 维度（review.dimensions 收敛后）；缺省为全部三维 */
  dimensions?: readonly LlmDimension[] | undefined;
  /** 单次审查纳入的文件数上限（review.maxFiles）；超限按风险分降序截断并在报告中标注 */
  maxFiles?: number | undefined;
  /** 单次审查纳入的变更行数上限（review.maxChangedLines）；超限按文件截断 */
  maxChangedLines?: number | undefined;
  /** 审查缓存（方案 3.0 步骤 8）；undefined 表示禁用缓存 */
  reviewCache?: ReviewCache | undefined;
  /** token 硬预算；预算耗尽时低优先级文件降级为 staticOnly（方案 3.3） */
  budget?: TokenBudget | undefined;
  /** 配置启用的静态工具；未传时运行注册表中的全部工具 */
  enabledTools?: readonly string[] | undefined;
  /** RAG 召回数量；未传时使用 DiffContextBuilder 默认值 5 */
  ragTopK?: number | undefined;
  /** 展示在报告元数据中的模型名称 */
  modelName?: string | undefined;
  /** 项目约定摘要（AGENTS.md / CLAUDE.md），注入每个维度的审查载荷 */
  conventions?: string | undefined;
  /** 规则指纹（自定义规则 + 阈值 + 维度 + 模型），缓存失效依据 */
  rulesFingerprint?: string | undefined;
  /** 只读仓库工具（ReAct）；缺省为单轮生成 */
  tools?: readonly ReviewToolDescriptor[] | undefined;
  /** LangGraph 检查点存储；同一进程内重试时用于断点续跑（缺省每次新建 MemorySaver） */
  checkpointer?: BaseCheckpointSaver | undefined;
};

export type PipelineNode = (
  state: ReviewState,
  config: RunnableConfig,
) => Promise<Partial<ReviewState>>;

/**
 * 单次运行的指标累加器。
 * 为什么需要它：三个维度节点并行执行，若各自返回 `{...state.metrics, +usage}`，
 * reducer 只能保留最后一次写入（实测 token 只记了 1/3）。累加器在节点内做原子累加，
 * report 节点一次性产出最终指标，避免并行读改写丢失。
 */
export type RunMetricsAccumulator = {
  addUsage(usage: LlmUsage): void;
  addLlmCall(call: LlmCallRecord): void;
  addReviewCounters(counters: {
    cacheHits: number;
    filesReviewed: number;
    rejectedFindings: number;
    contextFindings: number;
  }): void;
  noteLlmStatus(status: LlmRuntimeStatus): void;
  setPlan(plan: {
    filesDeep: number;
    filesQuick: number;
    filesStaticOnly: number;
    degradedToStatic: readonly string[];
    truncatedFiles: readonly string[];
    dimensions: readonly string[];
  }): void;
  setHeal(rounds: number, ineffective: boolean): void;
  snapshot(durationMs: number): ReviewMetrics;
};

/** 创建一次审查运行的指标累加器（每次 runReviewPipeline 新建一个） */
export function createRunMetricsAccumulator(): RunMetricsAccumulator {
  let totalTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheHits = 0;
  let filesReviewed = 0;
  let rejectedFindings = 0;
  let contextFindings = 0;
  let llmStatus: LlmRuntimeStatus | undefined;
  let plan = {
    filesDeep: 0,
    filesQuick: 0,
    filesStaticOnly: 0,
    degradedToStatic: [] as string[],
    truncatedFiles: [] as string[],
    dimensions: [] as string[],
  };
  let healRounds = 0;
  let healIneffective = false;
  const llmCalls: LlmCallRecord[] = [];

  return {
    addUsage(usage) {
      totalTokens += usage.totalTokens;
      promptTokens += usage.promptTokens;
      completionTokens += usage.completionTokens;
    },
    addLlmCall(call) {
      llmCalls.push(call);
    },
    addReviewCounters(counters) {
      cacheHits += counters.cacheHits;
      filesReviewed += counters.filesReviewed;
      rejectedFindings += counters.rejectedFindings;
      contextFindings += counters.contextFindings;
    },
    noteLlmStatus(status) {
      llmStatus = worstLlmStatus(llmStatus, status);
    },
    setPlan(next) {
      plan = {
        filesDeep: next.filesDeep,
        filesQuick: next.filesQuick,
        filesStaticOnly: next.filesStaticOnly,
        degradedToStatic: [...next.degradedToStatic],
        truncatedFiles: [...next.truncatedFiles],
        dimensions: [...next.dimensions],
      };
    },
    setHeal(rounds, ineffective) {
      healRounds = rounds;
      if (ineffective) healIneffective = true;
    },
    snapshot(durationMs) {
      return {
        totalTokens,
        durationMs,
        filesDeep: plan.filesDeep,
        filesQuick: plan.filesQuick,
        filesStaticOnly: plan.filesStaticOnly,
        degradedToStatic: [...plan.degradedToStatic],
        healRounds,
        cacheHits,
        truncatedFiles: [...plan.truncatedFiles],
        dimensions: [...plan.dimensions],
        promptTokens,
        completionTokens,
        filesReviewed,
        rejectedFindings,
        contextFindings,
        ...(llmStatus === undefined ? {} : { llmStatus }),
        ...(healIneffective ? { healIneffective: true } : {}),
        ...(llmCalls.length === 0 ? {} : { llmCalls: [...llmCalls] }),
      };
    },
  };
}

/** 把一次 Agent 输出转成可落库的调用记录（失败尝试一并保留） */
function toLlmCallRecord(
  dimension: LlmDimension,
  output: Awaited<ReturnType<ReviewAgent['review']>>,
  round: number,
): LlmCallRecord {
  return {
    dimension,
    provider: output.provider,
    model: output.model,
    status: output.status,
    promptTokens: output.usage.promptTokens,
    completionTokens: output.usage.completionTokens,
    totalTokens: output.usage.totalTokens,
    estimated: output.usage.estimated,
    latencyMs: output.latencyMs,
    promptChars: output.promptChars,
    fallbackUsed:
      output.status === 'unavailable' ||
      output.attempts.some(
        (attempt) => attempt.kind === 'fallback' && attempt.status === 'succeeded',
      ),
    round,
    attempts: output.attempts.map((attempt) => ({
      kind: attempt.kind,
      provider: attempt.provider,
      model: attempt.model,
      status: attempt.status,
      latencyMs: attempt.latencyMs,
      ...(attempt.errorKind === undefined ? {} : { errorKind: attempt.errorKind }),
      ...(attempt.message === undefined ? {} : { message: attempt.message }),
    })),
  };
}

/** 预留估算：按变更行 + 函数片段字符数估算，约 4 字符/token，加固定指令余量 */
function estimateTokens(file: { diff: FileDiff; snippet?: string }): number {
  const changedChars = file.diff.changedLines.reduce(
    (total, line) => total + line.content.length,
    0,
  );
  const estimate = Math.ceil((changedChars + (file.snippet ?? '').length) / 4) + 800;
  // 单文件上限 40k，避免超大文件把整次预算一次吃光
  return Math.min(40_000, estimate);
}

/**
 * 审查缓存键（方案 3.0 步骤 8 / 数据模型 review_cache.cache_key）：
 * hash(维度 + prompt 版本 + 模型 + 规则指纹 + 新侧内容全文)。
 * 缺模型/规则维度会导致“换了模型或规则仍复用旧结论”的历史缺陷。
 */
function cacheKey(dimension: LlmDimension, file: FileContext, deps: PipelineDeps): string {
  const hash = createHash('sha256');
  hash.update(dimension);
  hash.update('\u0000');
  hash.update(REVIEW_PROMPT_VERSION);
  hash.update('\u0000');
  hash.update(deps.modelName ?? '');
  hash.update('\u0000');
  hash.update(deps.rulesFingerprint ?? '');
  hash.update('\u0000');
  hash.update(file.stagedContent);
  return hash.digest('hex');
}

function selectFiles(context: CodeContext, paths: ReadonlySet<string>): CodeContext {
  const files = context.files.filter((file) => paths.has(file.diff.path));
  return { files, metadata: { ...context.metadata, totalFiles: files.length } };
}

/** 读取 diff（按审查来源）并生成浅上下文（方案 3.1；不读文件内容/AST/RAG） */
export function makeParseNode(deps: PipelineDeps): PipelineNode {
  const builder = new DiffContextBuilder(
    deps.gitReader,
    deps.rag,
    deps.ignores,
    50,
    deps.source ?? { target: 'staged' },
    deps.ragTopK,
    deps.repoPath,
  );
  return async () => {
    // readShallow 只解析 diff；AST/RAG 等昂贵步骤留到规模上限之后（buildContext 节点）
    const { context, rawDiff } = await builder.readShallow();
    return { context, rawDiff };
  };
}

/**
 * 为入选文件构建内容上下文（方案 3.1 的成本控制点）。
 * deep/quick 文件构建 AST + RAG；staticOnly/被截断文件只读取内容与行窗口，
 * 因此 `review.maxFiles` 真正挡住了最贵的一步，而不是先全量构建再丢弃。
 */
export function makeContextNode(deps: PipelineDeps): PipelineNode {
  const builder = new DiffContextBuilder(
    deps.gitReader,
    deps.rag,
    deps.ignores,
    50,
    deps.source ?? { target: 'staged' },
    deps.ragTopK,
    deps.repoPath,
  );
  return async (state) => {
    const diffs = state.context.files.map((file) => file.diff);
    if (diffs.length === 0) return {};
    const fullPaths = new Set(
      [...state.plan.deep, ...state.plan.quick].map((file) => file.diff.path),
    );
    const context = await builder.buildContexts(diffs, {
      fullPaths,
      metadata: state.context.metadata,
    });
    return { context };
  };
}

/**
 * 预算降级（方案 3.3）：按风险分降序逐文件预留，余额不足的文件移入 staticOnly。
 * 预留在 plan 节点单点执行（而非并行审查节点内），避免并行分支对共享预算的竞争写入；
 * 每个文件按“启用维度数”预留，因为同一文件会被多个维度各审一次。
 */
function applyBudget(
  plan: ReviewPlan,
  budget: TokenBudget | undefined,
  dimensionCount: number,
): {
  plan: ReviewPlan;
  degraded: string[];
} {
  if (budget === undefined) return { plan, degraded: [] };
  const deep: ReviewPlan['deep'] = [];
  const quick: ReviewPlan['quick'] = [];
  const staticOnly = [...plan.staticOnly];
  const degraded: string[] = [];
  const multiplier = Math.max(1, dimensionCount);
  for (const file of [...plan.deep, ...plan.quick]) {
    if (!budget.tryReserve(estimateTokens({ diff: file.diff }) * multiplier)) {
      staticOnly.push(file);
      degraded.push(file.diff.path);
      continue;
    }
    if (file.score >= 60) deep.push(file);
    else quick.push(file);
  }
  return { plan: { deep, quick, staticOnly }, degraded };
}

/**
 * 规模上限（review.maxFiles / review.maxChangedLines）：
 * 超出上限的文件降级为 staticOnly 并记录到 truncatedFiles——
 * 报告必须显式标注"未完整 LLM 审查"，不能静默丢弃。
 * @param plan 风险规划结果（已按分数降序）
 * @param maxFiles 文件数上限；undefined 表示不限制
 * @param maxChangedLines 变更行数上限；undefined 表示不限制
 * @returns 截断后的计划与被截断文件路径
 */
export function applySizeLimits(
  plan: ReviewPlan,
  maxFiles: number | undefined,
  maxChangedLines: number | undefined,
): { plan: ReviewPlan; truncated: string[] } {
  if (maxFiles === undefined && maxChangedLines === undefined) {
    return { plan, truncated: [] };
  }
  const fileLimit = maxFiles ?? Number.POSITIVE_INFINITY;
  const lineLimit = maxChangedLines ?? Number.POSITIVE_INFINITY;
  // 已有 staticOnly 的文件本来就不进 LLM，无需计入额度
  const candidates = [...plan.deep, ...plan.quick];
  const keptStatic = [...plan.staticOnly];
  const kept: ReviewPlan['deep'] = [];
  const truncated: string[] = [];
  let usedLines = 0;
  for (const file of candidates) {
    const changed = file.diff.additions + file.diff.deletions;
    const overFiles = kept.length >= fileLimit;
    const overLines = usedLines + changed > lineLimit;
    if (overFiles || overLines) {
      keptStatic.push(file);
      truncated.push(file.diff.path);
      continue;
    }
    usedLines += changed;
    kept.push(file);
  }
  return {
    plan: {
      deep: kept.filter((file) => file.score >= 60),
      quick: kept.filter((file) => file.score < 60),
      staticOnly: keptStatic,
    },
    truncated,
  };
}

/** 风险规划分流 + 预算降级 + 规模上限（方案 3.2/3.3） */
export function makePlanNode(deps: PipelineDeps, runMetrics?: RunMetricsAccumulator): PipelineNode {
  const planner = new RiskPlanner(deps.history);
  return async (state) => {
    const planned = await planner.plan(state.context.files.map((file) => file.diff));
    const limited = applySizeLimits(planned, deps.maxFiles, deps.maxChangedLines);
    const dimensions = deps.dimensions ?? LLM_DIMENSIONS;
    const budgeted = applyBudget(limited.plan, deps.budget, dimensions.length);
    runMetrics?.setPlan({
      filesDeep: budgeted.plan.deep.length,
      filesQuick: budgeted.plan.quick.length,
      filesStaticOnly: budgeted.plan.staticOnly.length,
      degradedToStatic: budgeted.degraded,
      truncatedFiles: limited.truncated,
      dimensions,
    });
    if (runMetrics !== undefined) return { plan: budgeted.plan };
    return {
      plan: budgeted.plan,
      metrics: {
        ...state.metrics,
        filesDeep: budgeted.plan.deep.length,
        filesQuick: budgeted.plan.quick.length,
        filesStaticOnly: budgeted.plan.staticOnly.length,
        degradedToStatic: budgeted.degraded,
        truncatedFiles: limited.truncated,
        dimensions: [...dimensions],
      },
    };
  };
}

/**
 * LLM 审查节点工厂（方案 3.3 makeReviewNode）：按维度注入评审标准与 Provider，
 * 审查本维度分到的文件；静态证据与项目约定一并注入，命中缓存时重新做行号校验。
 */
export function makeReviewNode(
  dimension: LlmDimension,
  deps: PipelineDeps,
  runMetrics?: RunMetricsAccumulator,
): PipelineNode {
  const agent = new ReviewAgent(deps.providers[dimension], dimension);
  const cache = deps.reviewCache;
  const enabled = (deps.dimensions ?? LLM_DIMENSIONS).includes(dimension);
  return async (state, config) => {
    // 维度被 review.dimensions 关闭：短路为空结果，不调用 Provider（无 token 成本）
    if (!enabled) return { findings: [] };
    const selected =
      deps.mode === 'fast' ? state.plan.deep : [...state.plan.deep, ...state.plan.quick];
    const paths = new Set(selected.map((file) => file.diff.path));
    const files = state.context.files.filter((file) => paths.has(file.diff.path));

    // 缓存分流（方案 3.0 步骤 8）：命中的文件复用发现，但必须重新校验行号/文件归属
    const cachedFindings: Finding[] = [];
    const missed: FileContext[] = [];
    let cacheHits = 0;
    for (const file of files) {
      const hit =
        cache === undefined ? undefined : await cache.get(cacheKey(dimension, file, deps));
      if (hit === undefined) {
        missed.push(file);
        continue;
      }
      const singleFileContext: CodeContext = {
        files: [file],
        metadata: { ...state.context.metadata, totalFiles: 1 },
      };
      const validated = validateFindings(hit, singleFileContext, dimension);
      cachedFindings.push(
        ...validated.findings.map((finding) => ({ ...finding, origin: 'cache' as const })),
      );
      cacheHits += 1;
    }

    const subContext = selectFiles(state.context, new Set(missed.map((file) => file.diff.path)));
    const evidence = state.findings.filter(
      (finding) => finding.agent === 'static' && paths.has(finding.filePath),
    );
    const missedEstimate = missed.reduce((total, file) => total + estimateTokens(file), 0);
    let output: Awaited<ReturnType<ReviewAgent['review']>> | undefined;
    if (subContext.files.length > 0) {
      try {
        output = await agent.review(
          {
            context: subContext,
            evidence,
            ...(deps.conventions === undefined ? {} : { conventions: deps.conventions }),
            ...(deps.tools === undefined ? {} : { tools: deps.tools }),
          },
          config.signal,
        );
      } catch (error) {
        // 预算预留必须释放，否则失败会永久吃掉后续文件的预算
        deps.budget?.release(missedEstimate);
        throw error;
      }
      deps.budget?.account(output.usage);
      deps.budget?.release(Math.max(0, missedEstimate - output.usage.totalTokens));
    } else {
      deps.budget?.release(missedEstimate);
    }

    // 未命中文件按 filePath 归组回填缓存；tokenSaved 为下次命中可省去的预估消耗
    if (cache !== undefined) {
      const byFile = new Map<string, Finding[]>();
      for (const finding of output?.findings ?? []) {
        const group = byFile.get(finding.filePath) ?? [];
        group.push(finding);
        byFile.set(finding.filePath, group);
      }
      for (const file of missed) {
        await cache.set(
          cacheKey(dimension, file, deps),
          byFile.get(file.diff.path) ?? [],
          estimateTokens(file),
        );
      }
    }

    if (runMetrics !== undefined) {
      if (output !== undefined) {
        runMetrics.addUsage(output.usage);
        runMetrics.noteLlmStatus(output.status);
        runMetrics.addLlmCall(toLlmCallRecord(dimension, output, state.healRounds));
      }
      runMetrics.addReviewCounters({
        cacheHits,
        filesReviewed: subContext.files.length,
        rejectedFindings: output?.rejected ?? 0,
        contextFindings:
          (output?.contextFindings ?? 0) +
          cachedFindings.filter((finding) => finding.lineScope === 'context').length,
      });
    }
    if (cachedFindings.length === 0 && output === undefined) return { findings: [] };
    if (runMetrics !== undefined) {
      return { findings: [...cachedFindings, ...(output?.findings ?? [])] };
    }
    return {
      findings: [...cachedFindings, ...(output?.findings ?? [])],
      metrics: {
        ...state.metrics,
        cacheHits: state.metrics.cacheHits + cacheHits,
        filesReviewed: (state.metrics.filesReviewed ?? 0) + subContext.files.length,
        totalTokens: state.metrics.totalTokens + (output?.usage.totalTokens ?? 0),
        promptTokens: (state.metrics.promptTokens ?? 0) + (output?.usage.promptTokens ?? 0),
        completionTokens:
          (state.metrics.completionTokens ?? 0) + (output?.usage.completionTokens ?? 0),
        rejectedFindings: (state.metrics.rejectedFindings ?? 0) + (output?.rejected ?? 0),
        contextFindings:
          (state.metrics.contextFindings ?? 0) +
          (output?.contextFindings ?? 0) +
          cachedFindings.filter((finding) => finding.lineScope === 'context').length,
        ...(output === undefined
          ? {}
          : { llmStatus: worstLlmStatus(state.metrics.llmStatus, output.status) }),
      },
    };
  };
}

/** 静态分析节点：确定性工具覆盖全部文件（fast/full 模式均全量执行，方案 3.0） */
export function makeStaticReviewNode(deps: PipelineDeps): PipelineNode {
  return async (state) => ({ findings: deps.registry.runAll(state.context, deps.enabledTools) });
}

/** 交叉验证 + 幻觉抑制（方案 3.6 五阶段后处理，当前实现阶段 1/2/5） */
export function makeValidateNode(): PipelineNode {
  return async (state) => ({ findings: crossValidate(state.findings, state.context) });
}

function isHealCandidate(finding: ReviewState['findings'][number]): boolean {
  return finding.severity === 'BLOCKER' && finding.confidence < HEAL_CONFIDENCE_THRESHOLD;
}

/**
 * 自愈回退（方案 3.7）：把低置信度 BLOCKER 涉及的文件收窄为重审范围，
 * 携带完整上下文、上一轮发现与更严格的 system prompt 重新审查。
 * 受 token 预算与并发上限约束：预算不足时跳过本轮（记入 metrics 并在报告中体现），
 * 避免自愈路径绕过预算成为成本黑洞。
 */
export function makeHealNode(deps: PipelineDeps, runMetrics?: RunMetricsAccumulator): PipelineNode {
  const dimensions = deps.dimensions ?? [...LLM_DIMENSIONS];
  return async (state, config) => {
    const prior = state.findings.filter(isHealCandidate);
    const targets = new Set(prior.map((finding) => finding.filePath));
    const subContext = selectFiles(state.context, targets);
    const healRounds = state.healRounds + 1;
    if (subContext.files.length === 0) {
      runMetrics?.setHeal(healRounds, false);
      return runMetrics === undefined
        ? { findings: [], healRounds, metrics: { ...state.metrics, healRounds } }
        : { findings: [], healRounds };
    }

    // 预算：重审同一批文件 × 启用维度数，逐文件预留；余额不足的文件不再重审（保守地保留原发现）
    const estimatePerRound = (file: FileContext): number =>
      estimateTokens(file) * Math.max(1, dimensions.length);
    const affordable =
      deps.budget === undefined
        ? subContext.files
        : subContext.files.filter((file) => deps.budget?.tryReserve(estimatePerRound(file)));
    if (affordable.length === 0) {
      runMetrics?.setHeal(healRounds, false);
      return runMetrics === undefined
        ? { findings: [], healRounds, metrics: { ...state.metrics, healRounds } }
        : { findings: [], healRounds };
    }

    const affordablePaths = new Set(affordable.map((file) => file.diff.path));
    const healContext: CodeContext = {
      files: affordable,
      metadata: { ...subContext.metadata, totalFiles: affordable.length },
    };
    const evidence = state.findings.filter(
      (finding) => finding.agent === 'static' && affordablePaths.has(finding.filePath),
    );
    const priorForFiles = prior.filter((finding) => affordablePaths.has(finding.filePath));
    const reserved = affordable.reduce((total, file) => total + estimatePerRound(file), 0);
    let groups: Awaited<ReturnType<ReviewAgent['review']>>[];
    try {
      groups = await pMap(
        dimensions,
        (dimension) =>
          new ReviewAgent(deps.providers[dimension], dimension).review(
            {
              context: healContext,
              evidence,
              priorFindings: priorForFiles,
              strict: true,
              ...(deps.conventions === undefined ? {} : { conventions: deps.conventions }),
              ...(deps.tools === undefined ? {} : { tools: deps.tools }),
            },
            config.signal,
          ),
        { concurrency: 3 },
      );
    } catch (error) {
      deps.budget?.release(reserved);
      throw error;
    }

    const used = groups.reduce((total, group) => total + group.usage.totalTokens, 0);
    deps.budget?.account({ totalTokens: used });
    deps.budget?.release(Math.max(0, reserved - used));

    const healed = groups.flatMap((group) => group.findings);
    // 复核是否真的改变了结论：置信度提升、结论被否定（上一轮发现消失）都算改善
    const healedByFingerprint = new Map(
      healed.flatMap((finding) =>
        finding.fingerprint === undefined ? [] : [[finding.fingerprint, finding] as const],
      ),
    );
    const improved = priorForFiles.some((finding) => {
      const match =
        finding.fingerprint === undefined
          ? undefined
          : healedByFingerprint.get(finding.fingerprint);
      return match === undefined || match.confidence > finding.confidence;
    });
    const stillLow = healed.some(isHealCandidate);
    if (runMetrics !== undefined) {
      groups.forEach((group, index) => {
        runMetrics.addUsage(group.usage);
        runMetrics.noteLlmStatus(group.status);
        const groupDimension = dimensions[index];
        if (groupDimension !== undefined) {
          runMetrics.addLlmCall(toLlmCallRecord(groupDimension, group, healRounds));
        }
      });
      runMetrics.setHeal(healRounds, stillLow && !improved);
      return { findings: healed, healRounds };
    }

    const promptTokens = groups.reduce((total, group) => total + group.usage.promptTokens, 0);
    const completionTokens = groups.reduce(
      (total, group) => total + group.usage.completionTokens,
      0,
    );
    const llmStatus = groups.reduce(
      (status, group) => worstLlmStatus(status, group.status),
      state.metrics.llmStatus,
    );
    return {
      findings: healed,
      healRounds,
      metrics: {
        ...state.metrics,
        healRounds,
        totalTokens: state.metrics.totalTokens + used,
        promptTokens: (state.metrics.promptTokens ?? 0) + promptTokens,
        completionTokens: (state.metrics.completionTokens ?? 0) + completionTokens,
        ...(llmStatus === undefined ? {} : { llmStatus }),
        ...(stillLow && !improved ? { healIneffective: true } : {}),
      },
    };
  };
}

/** 报告收尾：固化流水线总耗时与指标快照（方案 3.9 report 节点；落库与 SSE 推送由调用方承担） */
export function makeReportNode(
  startedAt: number,
  runMetrics?: RunMetricsAccumulator,
): PipelineNode {
  return async (state) => ({
    metrics:
      runMetrics === undefined
        ? { ...state.metrics, durationMs: Date.now() - startedAt }
        : runMetrics.snapshot(Date.now() - startedAt),
  });
}
