import { Annotation } from '@langchain/langgraph';
import type { CodeContext, Finding, ReviewMetrics, ReviewPlan } from '@ai-review/shared';
import { dedupeFindings } from './cross-validate.js';

export function emptyContext(): CodeContext {
  return {
    files: [],
    metadata: {
      totalFiles: 0,
      totalAdditions: 0,
      totalDeletions: 0,
      languages: [],
      generatedAt: '',
    },
  };
}

export function emptyPlan(): ReviewPlan {
  return { deep: [], quick: [], staticOnly: [] };
}

export function emptyMetrics(): ReviewMetrics {
  return {
    totalTokens: 0,
    durationMs: 0,
    filesDeep: 0,
    filesQuick: 0,
    filesStaticOnly: 0,
    degradedToStatic: [],
    healRounds: 0,
    cacheHits: 0,
    truncatedFiles: [],
    dimensions: [],
    promptTokens: 0,
    completionTokens: 0,
    filesReviewed: 0,
    rejectedFindings: 0,
    contextFindings: 0,
  };
}

/**
 * findings channel：并行分支结果自动合并去重（方案 3.9）。
 * 后写覆盖语义：交叉验证/自愈的修正版本与原始发现同簇时以修正版为准（见 dedupeFindings）。
 */
const findingList = Annotation<Finding[]>({
  reducer: (current, patch) => dedupeFindings([...current, ...patch]),
  default: () => [],
});

/**
 * metrics channel：逐字段合并——并行审查节点各自补写 degradedToStatic，
 * 通道级整体替换会丢失兄弟分支的并发写入。
 * 数组字段用 `?? []` 兜底：测试与旧调用方可能构造缺少新字段的 metrics 对象。
 */
const metricsChannel = Annotation<ReviewMetrics>({
  reducer: (current, patch) => ({
    ...current,
    ...patch,
    degradedToStatic: [
      ...new Set([...current.degradedToStatic, ...(patch.degradedToStatic ?? [])]),
    ],
    truncatedFiles: [...new Set([...current.truncatedFiles, ...(patch.truncatedFiles ?? [])])],
    dimensions:
      patch.dimensions === undefined || patch.dimensions.length === 0
        ? current.dimensions
        : patch.dimensions,
    // report 节点用累加器快照整体替换 metrics；此处仍做并集，兼容节点直跑/未来增量写入
    llmCalls: [...(current.llmCalls ?? []), ...(patch.llmCalls ?? [])],
  }),
  default: emptyMetrics,
});

/**
 * 流水线共享状态（方案 3.9，Channel/Reducer 模型）。
 * 字段名与方案文档一一对应，禁止同义替换（规范 §2.5）。
 */
export const reviewStateAnnotation = Annotation.Root({
  context: Annotation<CodeContext>({ reducer: (_, b) => b, default: emptyContext }),
  /** 原始 unified diff，用于报告详情的 Diff 视图与导出；大于 2MB 由持久层截断。 */
  rawDiff: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  plan: Annotation<ReviewPlan>({ reducer: (_, b) => b, default: emptyPlan }),
  findings: findingList,
  healRounds: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  metrics: metricsChannel,
});

export type ReviewState = typeof reviewStateAnnotation.State;
