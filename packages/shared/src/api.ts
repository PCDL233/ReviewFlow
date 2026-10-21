import { z } from 'zod';
import { FindingSchema } from './finding.js';
import { FINDING_STATUSES } from './finding.js';
import { LLM_RUNTIME_STATUSES } from './llm.js';
import { AiReviewConfigSchema, CustomRuleSchema } from './config-schema.js';
import { ReviewReportSchema } from './report.js';
import { CUSTOM_RULE_MATCH_SCOPES } from './config-schema.js';
import { GitRefSchema, REVIEW_TARGETS } from './review-source.js';
import { EXIT_CODES } from './exit-codes.js';

// 认证/用户契约无 node 依赖，随 api 子路径一并供浏览器端消费
export * from './auth.js';
export { FindingSchema } from './finding.js';
export type { Finding } from './finding.js';
// 发现来源/行号语义/处置状态：详情页与统计页共用同一枚举
export {
  FINDING_ORIGINS,
  FINDING_LINE_SCOPES,
  FINDING_STATUSES,
  resolveFindingOrigin,
} from './finding.js';
export type { FindingOrigin, FindingLineScope, FindingStatus } from './finding.js';
// LLM 运行时状态：报告横幅与管理台可观测页共用
export { LLM_RUNTIME_STATUSES, describeLlmStatus } from './llm.js';
export type { LlmRuntimeStatus } from './llm.js';
// 评分与指纹：前端展示与后端判定同一口径
export { computeReviewScore, ensureFindingFingerprint, fingerprintFinding } from './score.js';
// 严重度与阻断判定：详情页与 Hook/CI 使用同一阈值函数
export { SEVERITY_RANK, severityMeetsThreshold } from './severity.js';
export type { AgentDimension, Severity } from './severity.js';
// 自定义规则 schema 与匹配范围枚举：供管理后台规则表单与试跑面板消费
export { CustomRuleSchema, CUSTOM_RULE_MATCH_SCOPES } from './config-schema.js';
export type { CustomRule, CustomRuleMatchScope } from './config-schema.js';
// 审查目标：Web 发起审查、Hook/CI 同步审查共用同一枚举与标签
export {
  REVIEW_TARGETS,
  REVIEW_TARGET_LABELS,
  ReviewSourceSchema,
  GitRefSchema,
  normalizeReviewSource,
  describeReviewSource,
} from './review-source.js';
export type { ReviewSource, ReviewTarget } from './review-source.js';
// 退出码：Hook/CI 同步审查响应的 exitCode 字段与调用方脚本共用同一契约
export { EXIT_CODES } from './exit-codes.js';
export type { ExitCode } from './exit-codes.js';
// 模型服务商目录同样无 node 依赖，供管理后台页面经浏览器安全子路径导入
export * from './model-catalog.js';

/**
 * —— API 契约（方案 2.3：前端零手工类型，全部推导自 shared）——
 * 本文件是 @ai-review/server 的 REST/SSE 响应形状与 @ai-review/web 的消费端的单一事实源。
 */

/** 附带数据库行 id 的发现——误报标记 API 的目标（Finding 契约本身不含 id） */
export const IdentifiedFindingSchema = FindingSchema.extend({
  id: z.number().int().positive(),
});
export type IdentifiedFinding = z.infer<typeof IdentifiedFindingSchema>;

/** 审查历史列表项（Dashboard 列表页行模型，方案 3.10 页面 1） */
export const ReviewListItemSchema = z.object({
  reviewId: z.string(),
  repoPath: z.string(),
  branch: z.string(),
  /** 被审查提交（staged/worktree 目标取 HEAD，range 取 head 端）；旧记录为 null */
  commitHash: z.string().nullable().optional(),
  /** 审查目标（staged/worktree/commit/range）；旧记录缺省视为 staged */
  target: z.enum(REVIEW_TARGETS).optional(),
  /** 审查来源的可读描述（如 range:main...HEAD） */
  sourceLabel: z.string().optional(),
  model: z.string(),
  mode: z.enum(['fast', 'full']),
  status: z.enum(['completed', 'failed', 'cancelled']).default('completed'),
  /** 失败/取消原因（status 异常时非空） */
  errorMessage: z.string().nullable().optional(),
  /** 0-100 综合风险评分 */
  riskScore: z.number(),
  totalFindings: z.number().int(),
  blockerCount: z.number().int(),
  warningCount: z.number().int(),
  nitCount: z.number().int(),
  tokenUsed: z.number().int(),
  durationMs: z.number().int(),
  createdAt: z.string(),
  /** 发起人用户 id（数据隔离依据；存量旧记录为 null） */
  createdBy: z.string().nullable().optional(),
});
export type ReviewListItem = z.infer<typeof ReviewListItemSchema>;

/**
 * 列表筛选与分页查询参数（GET /api/reviews?...）。
 * from/to 接受 ISO 日期串（含 `YYYY-MM-DD`，按字符串前缀比较即可命中同日记录）。
 */
export const ReviewListQuerySchema = z.object({
  /** 关键词：模糊匹配 repoPath / branch / reviewId */
  q: z.string().trim().min(1).optional(),
  status: z.enum(['completed', 'failed', 'cancelled']).optional(),
  mode: z.enum(['fast', 'full']).optional(),
  /** 严重度筛选：映射为对应计数列 > 0 */
  severity: z.enum(['BLOCKER', 'WARNING', 'NIT']).optional(),
  repo: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type ReviewListQuery = z.infer<typeof ReviewListQuerySchema>;

/** 报告详情：ReviewReport 的 findings 替换为带行 id 的版本（isFalsePositive 以落库值为准） */
export const ReviewReportDetailSchema = ReviewReportSchema.extend({
  findings: z.array(IdentifiedFindingSchema),
});
export type ReviewReportDetail = z.infer<typeof ReviewReportDetailSchema>;

/** 单次模型尝试（降级链的可观测记录） */
export const LlmCallAttemptSchema = z.object({
  kind: z.string(),
  provider: z.string(),
  model: z.string(),
  status: z.enum(['succeeded', 'failed']),
  latencyMs: z.number(),
  errorKind: z.string().optional(),
  message: z.string().optional(),
});

/** 一次维度调用（llm_calls 行；自愈轮次单独一条） */
export const LlmCallSchema = z.object({
  dimension: z.string(),
  provider: z.string(),
  model: z.string(),
  status: z.enum(LLM_RUNTIME_STATUSES),
  round: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  estimated: z.boolean(),
  latencyMs: z.number().nonnegative(),
  promptChars: z.number().int().nonnegative(),
  fallbackUsed: z.boolean(),
  attempts: z.array(LlmCallAttemptSchema),
});
export type LlmCall = z.infer<typeof LlmCallSchema>;

/** 单个流水线节点落库记录（checkpoint/审计：进程重启后仍可回溯执行到哪一步） */
export const ReviewStageSchema = z.object({
  id: z.number().int().positive(),
  node: z.string(),
  status: z.enum(['completed', 'failed']),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().nonnegative(),
  detail: z.string().optional(),
});
export type ReviewStage = z.infer<typeof ReviewStageSchema>;

/** GET /api/reviews/:id/trace：审查结论 + 模型调用明细 + 节点检查点 */
export const ReviewTraceSchema = z.object({
  reviewId: z.string(),
  llmCalls: z.array(LlmCallSchema),
  stages: z.array(ReviewStageSchema),
  summary: z.object({
    durationMs: z.number(),
    tokenUsed: z.number().int().nonnegative(),
    reviewScore: z.number(),
    changeRiskScore: z.number().optional(),
    llmStatus: z.enum(LLM_RUNTIME_STATUSES).optional(),
    cacheHits: z.number().int().nonnegative(),
    healRounds: z.number().int().nonnegative(),
    filesReviewed: z.number().int().nonnegative().optional(),
    dimensions: z.array(z.string()).optional(),
  }),
});
export type ReviewTrace = z.infer<typeof ReviewTraceSchema>;
export const ReviewTraceResponseSchema = z.object({ trace: ReviewTraceSchema });

/** 管理台可观测页查询参数 */
export const LlmCallListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
export type LlmCallListQuery = z.infer<typeof LlmCallListQuerySchema>;
export const LlmCallListItemSchema = LlmCallSchema.extend({
  reviewId: z.string(),
  createdAt: z.string(),
});
export const LlmCallListResponseSchema = z.object({ calls: z.array(LlmCallListItemSchema) });
export type LlmCallListResponse = z.infer<typeof LlmCallListResponseSchema>;

/**
 * 审查进度事件（SSE，方案 3.9 → Dashboard 实时进度条）。
 * `stage` 为流水线节点名（parse/riskPlan/correctness/security/performance/static/validate/heal/report）。
 */
export const ReviewStageEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('stage'),
    reviewId: z.string(),
    stage: z.string(),
    /** 阶段明细（如文件数、分流结果、发现计数），由节点增量状态推导 */
    detail: z.string().optional(),
  }),
  z.object({
    type: z.literal('completed'),
    reviewId: z.string(),
    riskScore: z.number(),
    blockerCount: z.number(),
    /** 是否达到阻断阈值（等价于 CLI 退出码 1 的语义） */
    blocking: z.boolean(),
  }),
  z.object({ type: z.literal('failed'), reviewId: z.string(), message: z.string() }),
  z.object({ type: z.literal('cancelled'), reviewId: z.string(), message: z.string() }),
]);
export type ReviewStageEvent = z.infer<typeof ReviewStageEventSchema>;

/** —— REST 响应包装 —— */

/** POST /api/reviews → 202 */
export const StartReviewResponseSchema = z.object({ reviewId: z.string() });
/** POST /api/reviews/:id/rerun → 202 */
export const RerunReviewResponseSchema = z.object({ reviewId: z.string() });
/** DELETE /api/reviews/:id → 200 */
export const DeleteReviewResponseSchema = z.object({ deleted: z.boolean() });
/** POST /api/reviews/:id/cancel → 200（目标不在运行中时 404） */
export const CancelReviewResponseSchema = z.object({ cancelled: z.boolean() });

/** GET /api/reviews（筛选 + 服务端分页；旧记录无 diff/错误信息字段为空） */
export const ReviewListResponseSchema = z.object({
  reviews: z.array(ReviewListItemSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

/** GET /api/reviews/:id/diff → 被审查的原始 unified diff（存量记录未持久化时为 null） */
export const ReviewDiffResponseSchema = z.object({ diffText: z.string().nullable() });

/** PATCH /api/findings/:id → 200 */
export const FalsePositiveResponseSchema = z.object({ updated: z.boolean() });

/** PATCH /api/findings/:id：状态/误报/原因（至少提供一个字段） */
export const FindingUpdateSchema = z
  .object({
    isFalsePositive: z.boolean().optional(),
    status: z.enum(FINDING_STATUSES).optional(),
    /** 处置原因/备注（≤500 字，供误报回流与审计） */
    reason: z.string().trim().max(500).optional(),
  })
  .refine((value) => value.isFalsePositive !== undefined || value.status !== undefined, {
    message: '至少提供 isFalsePositive 或 status',
  });
export type FindingUpdate = z.infer<typeof FindingUpdateSchema>;

/** 发现评论（人工协作；不参与流水线判定） */
export const FindingCommentSchema = z.object({
  id: z.number().int().positive(),
  findingId: z.number().int().positive(),
  userId: z.string().nullable(),
  username: z.string(),
  body: z.string(),
  createdAt: z.string(),
});
export type FindingComment = z.infer<typeof FindingCommentSchema>;
export const FindingCommentCreateSchema = z.object({
  body: z.string().trim().min(1).max(2_000),
});
export type FindingCommentCreate = z.infer<typeof FindingCommentCreateSchema>;
export const FindingCommentListResponseSchema = z.object({
  comments: z.array(FindingCommentSchema),
});

/** 审查决策（人工处置结论；不改变已生成的报告与退出码） */
export const REVIEW_DECISIONS = ['approve', 'request_changes', 'comment'] as const;
export const ReviewDecisionSchema = z.enum(REVIEW_DECISIONS);
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;
export const ReviewDecisionRequestSchema = z.object({
  decision: ReviewDecisionSchema,
  comment: z.string().trim().max(2_000).optional(),
});
export type ReviewDecisionRequest = z.infer<typeof ReviewDecisionRequestSchema>;
export const ReviewDecisionResponseSchema = z.object({
  reviewId: z.string(),
  decision: ReviewDecisionSchema,
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
});

/** 决策历史（append-only） */
export const ReviewDecisionEventSchema = z.object({
  id: z.number().int().positive(),
  reviewId: z.string(),
  decision: ReviewDecisionSchema,
  comment: z.string().nullable(),
  decidedBy: z.string(),
  createdAt: z.string(),
});
export type ReviewDecisionEvent = z.infer<typeof ReviewDecisionEventSchema>;
export const ReviewDecisionHistoryResponseSchema = z.object({
  decisions: z.array(ReviewDecisionEventSchema),
});

/** 两次审查对比：按指纹判断新增/已修复/仍存在 */
export const ReviewCompareSchema = z.object({
  reviewId: z.string(),
  baseId: z.string(),
  summary: z.object({
    added: z.number().int().nonnegative(),
    resolved: z.number().int().nonnegative(),
    persisting: z.number().int().nonnegative(),
  }),
  added: z.array(IdentifiedFindingSchema),
  resolved: z.array(IdentifiedFindingSchema),
  persisting: z.array(IdentifiedFindingSchema),
});
export type ReviewCompare = z.infer<typeof ReviewCompareSchema>;
export const ReviewCompareResponseSchema = z.object({ compare: ReviewCompareSchema });

/** PR 评论回写（GitHub Issues Comments API） */
export const PrCommentWriteRequestSchema = z.object({
  repo: z
    .string()
    .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'repo 需为 owner/name')
    .max(200),
  pullNumber: z.number().int().min(1).max(10_000_000),
});
export type PrCommentWriteRequest = z.infer<typeof PrCommentWriteRequestSchema>;
export const PrCommentWriteResponseSchema = z.object({ url: z.string() });
export type PrCommentWriteResponse = z.infer<typeof PrCommentWriteResponseSchema>;

/** —— 统计分析（方案 3.10 页面 4：ECharts 数据源，全部由 db 聚合产出）—— */

/** 严重度维度的发现计数（含 PRAISE，与 Finding 契约的严重度字面量一致） */
export const SeverityCountSchema = z.object({
  severity: z.enum(['BLOCKER', 'WARNING', 'NIT', 'PRAISE']),
  count: z.number().int().nonnegative(),
});
export type SeverityCount = z.infer<typeof SeverityCountSchema>;

/** 按自然日聚合的风险分趋势点（createdAt 截取日期部分） */
export const RiskTrendPointSchema = z.object({
  date: z.string(),
  reviews: z.number().int().nonnegative(),
  avgRiskScore: z.number(),
});
export type RiskTrendPoint = z.infer<typeof RiskTrendPointSchema>;

/** 发现数最多的文件（Top 高风险文件榜，按发现数降序） */
export const RiskyFileSchema = z.object({
  filePath: z.string(),
  findingCount: z.number().int().nonnegative(),
  blockerCount: z.number().int().nonnegative(),
});
export type RiskyFile = z.infer<typeof RiskyFileSchema>;

/** GET /api/stats 查询范围；日期按 UTC 自然日闭区间处理。 */
export const ReviewStatsQuerySchema = z.object({
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
});
export type ReviewStatsQuery = z.infer<typeof ReviewStatsQuerySchema>;

/** 规则命中统计（按 ruleId 聚合；仅统计自定义规则命中的发现） */
export const RuleHitStatSchema = z.object({
  ruleId: z.string(),
  count: z.number().int().nonnegative(),
  blocker: z.number().int().nonnegative(),
  warning: z.number().int().nonnegative(),
  nit: z.number().int().nonnegative(),
  falsePositives: z.number().int().nonnegative(),
});
export type RuleHitStat = z.infer<typeof RuleHitStatSchema>;
export const RuleHitStatsResponseSchema = z.object({
  rules: z.array(RuleHitStatSchema),
});

export const AgentCountSchema = z.object({
  agent: z.string(),
  count: z.number().int().nonnegative(),
});
export type AgentCount = z.infer<typeof AgentCountSchema>;

export const TokenTrendPointSchema = z.object({
  date: z.string(),
  tokenUsed: z.number().int().nonnegative(),
});
export type TokenTrendPoint = z.infer<typeof TokenTrendPointSchema>;

/** GET /api/stats 响应体（空库时所有计数为 0、均值与趋势为空数组） */
export const ReviewStatsSchema = z.object({
  totalReviews: z.number().int().nonnegative(),
  totalFindings: z.number().int().nonnegative(),
  falsePositiveCount: z.number().int().nonnegative(),
  avgRiskScore: z.number().nonnegative(),
  /** 全部审查的平均耗时（毫秒） */
  avgDurationMs: z.number().nonnegative(),
  totalTokenUsed: z.number().int().nonnegative(),
  severityDistribution: z.array(SeverityCountSchema),
  /** 按日期升序的风险分趋势 */
  riskTrend: z.array(RiskTrendPointSchema),
  topRiskyFiles: z.array(RiskyFileSchema),
  /** 各审查 agent 产出的发现数量 */
  agentDistribution: z.array(AgentCountSchema),
  /** 按自然日聚合的 token 消耗 */
  tokenTrend: z.array(TokenTrendPointSchema),
});
export type ReviewStats = z.infer<typeof ReviewStatsSchema>;

/** GET /api/stats */
export const ReviewStatsResponseSchema = z.object({ stats: ReviewStatsSchema });

/** 管理后台配置读写契约；API key 支持环境变量引用、直接填写或由服务端返回的掩码。 */
export const AdminConfigSchema = AiReviewConfigSchema.superRefine((config, ctx) => {
  if (config.llm.apiKey !== '********' && config.llm.apiKey.trim().length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['llm', 'apiKey'],
      message: 'apiKey cannot be empty',
    });
  }
});
/** 服务端运行环境只读信息（web 配置页展示，不提供编辑：端口/DB 等属启动参数） */
export const ServerRuntimeSchema = z.object({
  port: z.number().int(),
  dbPath: z.string(),
  webDistDir: z.string().nullable(),
  configPath: z.string(),
  allowedRoots: z.array(z.string()),
});
export type ServerRuntime = z.infer<typeof ServerRuntimeSchema>;

export const AdminConfigResponseSchema = z.object({
  config: AiReviewConfigSchema,
  runtime: ServerRuntimeSchema,
});
export type AdminConfig = z.infer<typeof AiReviewConfigSchema>;
export type AdminConfigResponse = z.infer<typeof AdminConfigResponseSchema>;

export const KnowledgeStatusSchema = z.object({
  status: z.enum(['disabled', 'idle', 'ready', 'running', 'error']),
  indexDir: z.string(),
  chunkCount: z.number().int().nonnegative(),
  paths: z.array(z.string()),
  lastIndexedAt: z.string().nullable(),
  error: z.string().nullable(),
  /** 该状态对应的仓库（按仓库隔离索引；旧服务端缺省） */
  repoPath: z.string().optional(),
});
export type KnowledgeStatus = z.infer<typeof KnowledgeStatusSchema>;
export const KnowledgeStatusResponseSchema = z.object({ knowledge: KnowledgeStatusSchema });
export const KnowledgeReindexResponseSchema = z.object({ accepted: z.boolean() });

/** —— 自定义审查规则（admin）—— */

/** GET /api/admin/rules 与 PUT /api/admin/rules 响应体 */
export const AdminRulesResponseSchema = z.object({ rules: z.array(CustomRuleSchema) });
export type AdminRulesResponse = z.infer<typeof AdminRulesResponseSchema>;

/** PUT /api/admin/rules 请求体（整体替换规则列表） */
export const AdminRulesUpdateSchema = z.object({ rules: z.array(CustomRuleSchema) });
export type AdminRulesUpdate = z.infer<typeof AdminRulesUpdateSchema>;

/**
 * POST /api/admin/rules/test 入参：待试跑的规则 + 示例输入。
 * added 范围从 sampleDiffText 的 + 行取；staged/snippet 范围对 sampleSource 逐行匹配。
 */
export const CustomRuleTestRequestSchema = z.object({
  rule: CustomRuleSchema,
  /** 用于 added 范围试跑的 unified diff 文本（仅取新增行） */
  sampleDiffText: z.string().default(''),
  /** 用于 staged/snippet 范围试跑的源码全文 */
  sampleSource: z.string().default(''),
});
export type CustomRuleTestRequest = z.infer<typeof CustomRuleTestRequestSchema>;

/** POST /api/admin/rules/test 响应体：规则在示例输入上的命中行 */
export const CustomRuleTestResultSchema = z.object({
  matches: z.array(
    z.object({
      scope: z.enum(CUSTOM_RULE_MATCH_SCOPES),
      /** 命中行号（1 基）；snippet 无 AST 签名时相对片段起始行 */
      line: z.number().int().nonnegative(),
      text: z.string(),
    }),
  ),
});
export type CustomRuleTestResult = z.infer<typeof CustomRuleTestResultSchema>;

/** —— 审计日志（登录日志 + 操作日志，参照云审计事件字段规范）—— */

/** 登录/认证事件动作（登录日志） */
export const LOGIN_LOG_ACTIONS = ['login', 'logout', 'register', 'change_password'] as const;
export type LoginLogAction = (typeof LOGIN_LOG_ACTIONS)[number];

/** 登录日志行（登录日志页数据源） */
export const LoginLogSchema = z.object({
  id: z.number().int().positive(),
  /** 操作用户 id；登录失败（用户不存在）时为 null */
  userId: z.string().nullable(),
  /** 尝试登录的用户名（失败登录同样记录，供安全分析） */
  username: z.string(),
  action: z.enum(LOGIN_LOG_ACTIONS),
  status: z.enum(['success', 'failed']),
  /** 失败原因（如 invalid-credentials / account-disabled）；成功为 null */
  reason: z.string().nullable(),
  /** 来源 IP（复用限流模块的客户端 IP 判定） */
  ip: z.string(),
  /** 客户端 User-Agent；无则空串 */
  userAgent: z.string(),
  createdAt: z.string(),
});
export type LoginLog = z.infer<typeof LoginLogSchema>;

/** 操作日志动作（资源上的 create/update/delete 等） */
export const OPERATION_LOG_ACTIONS = [
  'create',
  'update',
  'delete',
  'login',
  'logout',
  'register',
  'change_password',
  'reset_password',
  'assign_roles',
  'start_review',
  'rerun_review',
  'cancel_review',
  'delete_review',
  'mark_false_positive',
  'save_config',
  'save_rules',
  'test_rules',
  'reindex_knowledge',
  'install_hook',
  'rotate_hook_token',
  'revoke_hook_token',
  'run_hook_review',
] as const;
export type OperationLogAction = (typeof OPERATION_LOG_ACTIONS)[number];

/** 操作日志行（操作日志页数据源） */
export const OperationLogSchema = z.object({
  id: z.number().int().positive(),
  /** 操作者用户 id；匿名请求（如登录失败）为 null */
  userId: z.string().nullable(),
  username: z.string(),
  action: z.enum(OPERATION_LOG_ACTIONS),
  /** 资源类型（user / role / config / rules / review / finding / knowledge / auth） */
  resource: z.string(),
  /** 目标资源 id（如用户 id、审查 id）；无则空串 */
  resourceId: z.string(),
  /** 操作摘要（JSON 字符串，如 patch 内容）；不记录密码/令牌等敏感字段 */
  detail: z.string(),
  status: z.enum(['success', 'failed']),
  reason: z.string().nullable(),
  ip: z.string(),
  userAgent: z.string(),
  createdAt: z.string(),
});
export type OperationLog = z.infer<typeof OperationLogSchema>;

/** 登录日志查询参数（GET /api/admin/login-logs，分页 + 日期/状态/动作/用户名筛选） */
export const LoginLogQuerySchema = z.object({
  /** 关键词：模糊匹配用户名 */
  q: z.string().trim().min(1).optional(),
  status: z.enum(['success', 'failed']).optional(),
  action: z.enum(LOGIN_LOG_ACTIONS).optional(),
  /** 日期范围（YYYY-MM-DD，按 UTC 自然日闭区间） */
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type LoginLogQuery = z.infer<typeof LoginLogQuerySchema>;

/** 操作日志查询参数（GET /api/admin/operation-logs） */
export const OperationLogQuerySchema = z.object({
  /** 关键词：模糊匹配用户名 / 资源类型 / 目标 id */
  q: z.string().trim().min(1).optional(),
  action: z.enum(OPERATION_LOG_ACTIONS).optional(),
  resource: z.string().trim().min(1).optional(),
  status: z.enum(['success', 'failed']).optional(),
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type OperationLogQuery = z.infer<typeof OperationLogQuerySchema>;

/** GET /api/admin/login-logs 响应体 */
export const LoginLogListResponseSchema = z.object({
  logs: z.array(LoginLogSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type LoginLogListResponse = z.infer<typeof LoginLogListResponseSchema>;

/** GET /api/admin/operation-logs 响应体 */
export const OperationLogListResponseSchema = z.object({
  logs: z.array(OperationLogSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
export type OperationLogListResponse = z.infer<typeof OperationLogListResponseSchema>;

/** —— 发起审查（Web）—— */

/**
 * POST /api/reviews 入参。
 * target/base/commit 描述审查范围；三者与 target 的匹配关系由 ReviewSourceSchema 保证。
 * 兼容旧客户端：不带 target 时按 staged 处理（与既有"审查暂存区"语义一致）。
 */
export const StartReviewSchema = z.object({
  repoPath: z.string().min(1),
  mode: z.enum(['fast', 'full']).optional(),
  blockOn: z.enum(['BLOCKER', 'WARNING', 'NIT']).optional(),
  target: z.enum(REVIEW_TARGETS).optional(),
  /** target=range 时的基线引用 */
  base: GitRefSchema.optional(),
  /** target=commit 时的提交引用 */
  commit: GitRefSchema.optional(),
  /** 本次审查启用的 LLM 维度（缺省用配置值；maintainability 会被流水线过滤） */
  dimensions: z
    .array(z.enum(['correctness', 'security', 'performance', 'maintainability']))
    .min(1)
    .optional(),
  /** 单次审查文件数上限（缺省用配置 review.maxFiles） */
  maxFiles: z.number().int().min(1).max(2_000).optional(),
  /** 单次审查变更行数上限（缺省用配置 review.maxChangedLines） */
  maxChangedLines: z.number().int().min(100).max(200_000).optional(),
  /** 本次是否允许模型调用只读工具（缺省用配置 review.toolCalling） */
  toolCalling: z.boolean().optional(),
  /** 是否保留 PRAISE 级发现（缺省用配置 report.includePraise） */
  includePraise: z.boolean().optional(),
});
export type StartReviewInput = z.infer<typeof StartReviewSchema>;

/** —— 仓库发现（Web 发起审查的仓库/分支/提交选择器数据源）—— */

/** 仓库条目：来自允许根目录扫描与历史审查记录去重合并 */
export const RepositorySchema = z.object({
  /** 绝对路径；直接作为 POST /api/reviews 的 repoPath */
  path: z.string(),
  /** 展示名（目录名） */
  name: z.string(),
  /** 是否为 git 工作区（非 git 目录仍可展示，但发起审查会失败） */
  isGitRepo: z.boolean(),
  /** 是否来自历史审查记录（用于排序与标记） */
  reviewed: z.boolean(),
});
export type Repository = z.infer<typeof RepositorySchema>;

export const RepositoryListResponseSchema = z.object({ repositories: z.array(RepositorySchema) });
export type RepositoryListResponse = z.infer<typeof RepositoryListResponseSchema>;

/** 仓库工作区状态（发起审查前的即时校验依据） */
export const RepoStatusSchema = z.object({
  path: z.string(),
  isGitRepo: z.boolean(),
  branch: z.string(),
  headCommit: z.string().nullable(),
  headMessage: z.string().nullable(),
  stagedFiles: z.number().int().nonnegative(),
  unstagedFiles: z.number().int().nonnegative(),
  untrackedFiles: z.number().int().nonnegative(),
});
export type RepoStatus = z.infer<typeof RepoStatusSchema>;
export const RepoStatusResponseSchema = z.object({ status: RepoStatusSchema });

/** 分支条目 */
export const RepoBranchSchema = z.object({
  name: z.string(),
  /** 是否为当前分支 */
  current: z.boolean(),
  /** 最近一次提交的短哈希 */
  commit: z.string().nullable(),
});
export type RepoBranch = z.infer<typeof RepoBranchSchema>;
export const RepoBranchListResponseSchema = z.object({ branches: z.array(RepoBranchSchema) });

/** 提交条目（单个提交审查与区间 base 选择器共用） */
export const RepoCommitSchema = z.object({
  hash: z.string(),
  shortHash: z.string(),
  subject: z.string(),
  author: z.string(),
  date: z.string(),
});
export type RepoCommit = z.infer<typeof RepoCommitSchema>;
export const RepoCommitListResponseSchema = z.object({ commits: z.array(RepoCommitSchema) });

/** GET /api/repos/* 的公共查询：repoPath 必须落在服务端允许根目录内 */
export const RepoQuerySchema = z.object({
  repoPath: z.string().min(1),
  /** 提交/分支列表上限 */
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** 提交列表的起点引用（默认 HEAD） */
  ref: GitRefSchema.optional(),
});
export type RepoQuery = z.infer<typeof RepoQuerySchema>;

/** —— Git Hook 令牌（Web 一键安装 Hook 与 CI 同步审查的凭据）—— */

/** 令牌行（永不返回 token 明文，除签发响应） */
export const HookTokenSchema = z.object({
  id: z.string(),
  label: z.string(),
  /** 令牌前 8 位，供管理员辨认（明文只在签发时返回一次） */
  prefix: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  /** 最后使用时间；从未使用为 null */
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type HookToken = z.infer<typeof HookTokenSchema>;

export const HookTokenListResponseSchema = z.object({ tokens: z.array(HookTokenSchema) });

/** POST /api/admin/hooks/tokens 入参 */
export const CreateHookTokenSchema = z.object({
  label: z.string().trim().min(1).max(64).default('hook'),
  /** 有效期（天）；缺省 90 天 */
  expiresInDays: z.number().int().min(1).max(3650).default(90),
});
export type CreateHookTokenInput = z.infer<typeof CreateHookTokenSchema>;

/** POST /api/admin/hooks/tokens 响应：明文 token 仅此一次返回 */
export const CreateHookTokenResponseSchema = z.object({
  token: HookTokenSchema,
  plainText: z.string(),
});

/** GET /api/admin/hooks/script：安装所需的两份文件内容 */
export const HookScriptSchema = z.object({
  /** husky v9 的 sh 入口，内容只调用 node 运行 .mjs */
  shell: z.string(),
  /** 真正的审查调用脚本（Node ESM，跨平台） */
  runner: z.string(),
  /** 两份文件的相对路径（相对仓库根） */
  paths: z.object({ shell: z.string(), runner: z.string() }),
});
export type HookScript = z.infer<typeof HookScriptSchema>;

/** POST /api/admin/hooks/install 入参 */
export const InstallHookSchema = z.object({
  repoPath: z.string().min(1),
  /** 服务端基地址（写入脚本的 AI_REVIEW_SERVER_URL 默认值）；缺省用请求 Origin */
  serverUrl: z.string().trim().min(1).optional(),
  /** 安装时自动签发的令牌标签；未提供时不注入令牌（使用已存在的 token 文件） */
  tokenLabel: z.string().trim().min(1).max(64).optional(),
  /** 是否覆盖已存在的 hook */
  overwrite: z.boolean().default(false),
});
export type InstallHookInput = z.infer<typeof InstallHookSchema>;

/** POST /api/admin/hooks/install 响应 */
export const InstallHookResponseSchema = z.object({
  installed: z.boolean(),
  /** 实际写入的绝对路径 */
  files: z.array(z.string()),
  /** 本次签发的令牌明文（未签发时为 null） */
  plainText: z.string().nullable(),
  /** 已存在时跳过的提示 */
  skipped: z.array(z.string()),
});
export type InstallHookResponse = z.infer<typeof InstallHookResponseSchema>;

/** —— Hook / CI 同步审查（令牌鉴权，返回退出码契约）—— */

/**
 * POST /api/hooks/review 入参：Hook 与 CI 共用。
 * 与 /api/reviews 的区别是**同步**执行并返回 exitCode——调用方脚本据此决定是否放行提交。
 */
export const HookReviewRequestSchema = z.object({
  repoPath: z.string().min(1),
  target: z.enum(REVIEW_TARGETS).default('staged'),
  base: GitRefSchema.optional(),
  commit: GitRefSchema.optional(),
  mode: z.enum(['fast', 'full']).optional(),
  blockOn: z.enum(['BLOCKER', 'WARNING', 'NIT']).optional(),
});
export type HookReviewRequest = z.infer<typeof HookReviewRequestSchema>;

/** POST /api/hooks/review 响应：exitCode 沿用 packages/shared 的 0/1/2/3 契约 */
export const HookReviewResponseSchema = z.object({
  reviewId: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled']),
  /** 是否达到阻断阈值（等价 exitCode === 1） */
  blocking: z.boolean(),
  riskScore: z.number(),
  blockerCount: z.number().int().nonnegative(),
  /** 发现摘要，供终端直接打印 */
  summary: z.string(),
  /** 0 通过 / 1 阻断 / 2 配置环境错误 / 3 超时取消 */
  exitCode: z.union([
    z.literal(EXIT_CODES.ok),
    z.literal(EXIT_CODES.blocked),
    z.literal(EXIT_CODES.configError),
    z.literal(EXIT_CODES.cancelled),
  ]),
});
export type HookReviewResponse = z.infer<typeof HookReviewResponseSchema>;
