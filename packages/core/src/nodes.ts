import { createHash } from 'node:crypto';
import pMap from 'p-map';
import { ReviewAgent } from '@ai-review/agents';
import { DiffContextBuilder } from '@ai-review/diff';
import type { GitReader } from '@ai-review/diff';
import type { ReviewProvider, TokenBudget } from '@ai-review/llm';
import type { ToolRegistry } from '@ai-review/tools';
import type {
  CodeContext,
  Finding,
  FileContext,
  FileHistory,
  IgnoreRules,
  RagRetriever,
  ReviewPlan,
  ReviewSource,
} from '@ai-review/shared';
import type { RunnableConfig } from '@langchain/core/runnables';
import { crossValidate } from './cross-validate.js';
import { RiskPlanner } from './risk-planner.js';
import type { ReviewState } from './state.js';

/** LLM 语义审查承担的三个维度（方案 3.3 三 Agent）；static 由工具总线产出 */
const LLM_DIMENSIONS = ['correctness', 'security', 'performance'] as const;
export type LlmDimension = (typeof LLM_DIMENSIONS)[number];

function isLlmDimension(value: string): value is LlmDimension {
  return LLM_DIMENSIONS.some((dimension) => dimension === value);
}

/**
 * 将配置的 review.dimensions 收敛为可执行的 LLM 维度集合。
 * maintainability 由静态工具与 LLM 语义共同覆盖，但没有独立 Agent，
 * 因此只保留有 Provider 的三维；配置为空或缺省时退回全量三维。
 * @param configured 配置中的维度名
 * @returns 实际参与 fan-out 的维度（顺序固定，保证图结构稳定）
 */
export function resolveReviewDimensions(configured?: readonly string[]): LlmDimension[] {
  if (configured === undefined || configured.length === 0) return [...LLM_DIMENSIONS];
  const selected = configured.filter(isLlmDimension);
  return selected.length === 0 ? [...LLM_DIMENSIONS] : [...new Set(selected)];
}

/**
 * 审查缓存 Prompt 版本（方案 3.0 步骤 8 缓存键的组成：内容哈希 + agent + prompt 版本）。
 * 审查 System Prompt 或输出契约变更时必须递增，避免旧口径的发现被复用。
 */
export const REVIEW_PROMPT_VERSION = 'v1';

/**
 * 审查缓存接口（方案 3.0 步骤 8：内容哈希去重，相同代码块 + 相同 Agent 不重复消耗 LLM）。
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
/** 自愈回退轮次上限（方案 3.7：最多 3 轮、逐轮收窄范围） */
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
};

export type PipelineNode = (
  state: ReviewState,
  config: RunnableConfig,
) => Promise<Partial<ReviewState>>;

/** 预留估算：约 4 字符/token，加固定的指令与输出余量 */
function estimateTokens(diff: FileContext['diff']): number {
  return Math.ceil(diff.summary.length / 4) + 600;
}

/**
 * 审查缓存键（方案 3.0 步骤 8 / 数据模型 review_cache.cache_key）：
 * hash(agent + prompt 版本 + 新侧内容全文)。内容不变即命中，与仓库路径、审查 ID 无关。
 */
function cacheKey(dimension: LlmDimension, file: FileContext): string {
  const hash = createHash('sha256');
  hash.update(dimension);
  hash.update('\u0000');
  hash.update(REVIEW_PROMPT_VERSION);
  hash.update('\u0000');
  hash.update(file.stagedContent);
  return hash.digest('hex');
}

function selectFiles(context: CodeContext, paths: ReadonlySet<string>): CodeContext {
  const files = context.files.filter((file) => paths.has(file.diff.path));
  return { files, metadata: { ...context.metadata, totalFiles: files.length } };
}

/** 读取 diff（按审查来源）并构建上下文包（方案 3.1） */
export function makeParseNode(deps: PipelineDeps): PipelineNode {
  const builder = new DiffContextBuilder(
    deps.gitReader,
    deps.rag,
    deps.ignores,
    50,
    deps.source ?? { target: 'staged' },
    deps.ragTopK,
  );
  return async () => {
    // build() 同时返回原始 diff，避免此处再执行一次 git diff（大仓库下是可观的额外开销）
    const { context, rawDiff } = await builder.build();
    return { context, rawDiff };
  };
}

/**
 * 预算降级（方案 3.3）：按风险分降序逐文件预留，余额不足的文件移入 staticOnly。
 * 在 plan 节点单点执行（而非并行审查节点内），避免并行分支对共享预算的竞争写入。
 */
function applyBudget(
  plan: ReviewPlan,
  budget: TokenBudget | undefined,
): {
  plan: ReviewPlan;
  degraded: string[];
} {
  if (budget === undefined) return { plan, degraded: [] };
  const deep = [];
  const quick = [];
  const staticOnly = [...plan.staticOnly];
  const degraded = [];
  for (const file of [...plan.deep, ...plan.quick]) {
    if (!budget.tryReserve(estimateTokens(file.diff))) {
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
  const kept = [];
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
export function makePlanNode(deps: PipelineDeps): PipelineNode {
  const planner = new RiskPlanner(deps.history);
  return async (state) => {
    const planned = await planner.plan(state.context.files.map((file) => file.diff));
    const limited = applySizeLimits(planned, deps.maxFiles, deps.maxChangedLines);
    const budgeted = applyBudget(limited.plan, deps.budget);
    return {
      plan: budgeted.plan,
      metrics: {
        ...state.metrics,
        filesDeep: budgeted.plan.deep.length,
        filesQuick: budgeted.plan.quick.length,
        filesStaticOnly: budgeted.plan.staticOnly.length,
        degradedToStatic: budgeted.degraded,
        truncatedFiles: limited.truncated,
        dimensions: [...(deps.dimensions ?? LLM_DIMENSIONS)],
      },
    };
  };
}

/** LLM 审查节点工厂（方案 3.3 makeReviewNode）：按维度注入 Provider，审查本维度分到的文件 */
export function makeReviewNode(dimension: LlmDimension, deps: PipelineDeps): PipelineNode {
  const agent = new ReviewAgent(deps.providers[dimension]);
  const cache = deps.reviewCache;
  const enabled = (deps.dimensions ?? LLM_DIMENSIONS).includes(dimension);
  return async (state, config) => {
    // 维度被 review.dimensions 关闭：短路为空结果，不调用 Provider（无 token 成本）
    if (!enabled) return { findings: [] };
    const selected =
      deps.mode === 'fast' ? state.plan.deep : [...state.plan.deep, ...state.plan.quick];
    const paths = new Set(selected.map((file) => file.diff.path));
    const files = state.context.files.filter((file) => paths.has(file.diff.path));

    // 缓存分流（方案 3.0 步骤 8）：命中的文件直接复用发现，未命中的才进入 LLM
    const cachedFindings: Finding[] = [];
    const missed: FileContext[] = [];
    let cacheHits = 0;
    for (const file of files) {
      const hit = cache === undefined ? undefined : await cache.get(cacheKey(dimension, file));
      if (hit === undefined) missed.push(file);
      else {
        cachedFindings.push(...hit);
        cacheHits += 1;
      }
    }

    const subContext = selectFiles(state.context, new Set(missed.map((file) => file.diff.path)));
    const reviewed =
      subContext.files.length === 0 ? [] : await agent.review(subContext, config.signal);

    // 未命中文件按 filePath 归组回填缓存；tokenSaved 为下次命中可省去的预估消耗
    if (cache !== undefined) {
      const byFile = new Map<string, Finding[]>();
      for (const finding of reviewed) {
        const group = byFile.get(finding.filePath) ?? [];
        group.push(finding);
        byFile.set(finding.filePath, group);
      }
      for (const file of missed) {
        await cache.set(
          cacheKey(dimension, file),
          byFile.get(file.diff.path) ?? [],
          estimateTokens(file.diff),
        );
      }
    }

    if (cachedFindings.length === 0 && subContext.files.length === 0) return { findings: [] };
    return {
      findings: [...cachedFindings, ...reviewed],
      metrics: { ...state.metrics, cacheHits: state.metrics.cacheHits + cacheHits },
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
 * 自愈回退（方案 3.7）：将低置信度 BLOCKER 涉及的文件收窄为重审范围，
 * 携带完整上下文重新调用全部启用的 LLM 维度。
 * 受 token 预算与并发上限约束：预算不足时跳过本轮（记入 metrics 并在报告中体现），
 * 避免自愈路径绕过预算成为成本黑洞。
 */
export function makeHealNode(deps: PipelineDeps): PipelineNode {
  const dimensions = deps.dimensions ?? [...LLM_DIMENSIONS];
  return async (state, config) => {
    const targets = new Set(
      state.findings.filter(isHealCandidate).map((finding) => finding.filePath),
    );
    const subContext = selectFiles(state.context, targets);
    const healRounds = state.healRounds + 1;
    if (subContext.files.length === 0) {
      return { findings: [], healRounds, metrics: { ...state.metrics, healRounds } };
    }

    // 预算：重审同一批文件，逐文件预留；余额不足的文件不再重审（保守地保留原发现）
    const affordable =
      deps.budget === undefined
        ? subContext.files
        : subContext.files.filter((file) => deps.budget?.tryReserve(estimateTokens(file.diff)));
    if (affordable.length === 0) {
      return { findings: [], healRounds, metrics: { ...state.metrics, healRounds } };
    }

    const healContext: CodeContext = {
      files: affordable,
      metadata: { ...subContext.metadata, totalFiles: affordable.length },
    };
    const groups = await pMap(
      dimensions,
      (dimension) => new ReviewAgent(deps.providers[dimension]).review(healContext, config.signal),
      { concurrency: 3 },
    );
    return {
      findings: groups.flat(),
      healRounds,
      metrics: { ...state.metrics, healRounds },
    };
  };
}

/** 报告收尾：固化流水线总耗时（方案 3.9 report 节点；落库与 SSE 推送由调用方承担） */
export function makeReportNode(startedAt: number): PipelineNode {
  return async (state) => ({ metrics: { ...state.metrics, durationMs: Date.now() - startedAt } });
}
