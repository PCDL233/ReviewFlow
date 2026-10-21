import { z } from 'zod';
import { FindingSchema } from './finding.js';
import { LLM_RUNTIME_STATUSES } from './llm.js';

/**
 * 报告元信息 schema（对齐方案 3.8 五段式报告的"元信息"段与 reviews 表）。
 * 新增字段全部 optional：旧报告 JSON 与旧客户端无需迁移即可解析。
 */
export const ReviewMetaSchema = z.object({
  reviewId: z.string(),
  repoPath: z.string(),
  branch: z.string(),
  commitHash: z.string().optional(),
  author: z.string().optional(),
  /** 如 "claude-sonnet-5 + 静态分析" 或 "mock + 静态分析" */
  model: z.string(),
  mode: z.enum(['fast', 'full']),
  /** 审查终态；缺省视为 completed（CLI 直跑报告不落库无状态语义） */
  status: z.enum(['completed', 'failed', 'cancelled']).optional(),
  /** 失败/取消原因（status 异常时由服务端填充） */
  errorMessage: z.string().optional(),
  /** 0-100 综合风险评分（= reviewScore，兼容旧字段语义） */
  riskScore: z.number(),
  /** 0-100 变更风险分（RiskPlanner 输出，表达"这次改动本身有多危险"） */
  changeRiskScore: z.number().optional(),
  /** 0-100 审查结论分（发现加权，表达"这次审查到底查出了多严重的问题"） */
  reviewScore: z.number().optional(),
  durationMs: z.number(),
  tokenUsed: z.number(),
  /** 本次审查是否真的由模型完成；缺省视为 ok（旧记录） */
  llmStatus: z.enum(LLM_RUNTIME_STATUSES).optional(),
  /** 实际生效的审查维度 */
  dimensions: z.array(z.string()).optional(),
  /** 内容哈希缓存命中的文件数 */
  cacheHits: z.number().int().nonnegative().optional(),
  /** 自愈回退轮次 */
  healRounds: z.number().int().nonnegative().optional(),
  /** 审查 Prompt 版本（缓存失效与回溯依据） */
  promptVersion: z.string().optional(),
  /** 因规模上限未做 LLM 审查的文件（报告中必须显式说明） */
  truncatedFiles: z.array(z.string()).optional(),
  /** 因忽略规则/二进制/无实质变更被跳过的文件 */
  skippedFiles: z.array(z.string()).optional(),
  /** 审查来源的可读描述（如 range:main...HEAD） */
  sourceLabel: z.string().optional(),
  /** 触发来源 */
  trigger: z.enum(['web', 'hook', 'ci', 'api']).optional(),
  /** 本次审查的阻断阈值（前端按同一口径判定 blocking） */
  blockOn: z.enum(['BLOCKER', 'WARNING', 'NIT']).optional(),
  /** 人工审查决策（不改变已生成的报告与退出码） */
  decision: z.enum(['approve', 'request_changes', 'comment']).optional(),
  decisionComment: z.string().optional(),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
});
export type ReviewMeta = z.infer<typeof ReviewMetaSchema>;

/** 五段式报告整体 schema：Markdown/JSON 两种渲染与 API 响应共享同一数据源（方案 3.8） */
export const ReviewReportSchema = z.object({
  meta: ReviewMetaSchema,
  /** 第 1 段：变更概述 */
  summary: z.string(),
  /** 第 2 段：发现的问题（已去重排序） */
  findings: z.array(FindingSchema),
  /** 第 3 段：代码质量考量 */
  qualityNotes: z.array(z.string()),
  /** 第 4 段：改进建议 */
  suggestions: z.array(z.string()),
  /** 第 5 段：总体评估 */
  assessment: z.string(),
  /** 预算受限降级标注（非空时报告附加说明） */
  degradedToStatic: z.array(z.string()),
});
export type ReviewReport = z.infer<typeof ReviewReportSchema>;
