import type { FileDiff } from './diff.js';

export type ScoredFile = { diff: FileDiff; score: number };

/**
 * 风险规划分流结果（方案 3.2）：
 * ≥60 深度 LLM 审查 / 40~60 快速审查 / <40 仅静态分析。
 */
export type ReviewPlan = {
  deep: ScoredFile[];
  quick: ScoredFile[];
  staticOnly: ScoredFile[];
};

/** 流水线共享指标（报告元信息与 Dashboard 统计的数据源） */
export type ReviewMetrics = {
  totalTokens: number;
  durationMs: number;
  filesDeep: number;
  filesQuick: number;
  filesStaticOnly: number;
  /** 预算耗尽时被降级为 staticOnly 的文件，报告须标注"预算受限，已降级" */
  degradedToStatic: string[];
  /** 自愈回退执行轮次（方案 3.7，上限 3） */
  healRounds: number;
  /** 审查缓存命中文件数（方案 3.0 步骤 8：内容哈希去重省去的 LLM 调用） */
  cacheHits: number;
  /** 因 review.maxFiles / maxChangedLines 超出上限而未纳入 LLM 审查的文件（须在报告中标注） */
  truncatedFiles: string[];
  /** 本次实际启用的 LLM 审查维度（review.dimensions 的交集） */
  dimensions: string[];
};
