import {
  AGENT_DIMENSIONS,
  FINDING_LINE_SCOPES,
  FINDING_ORIGINS,
  FINDING_STATUSES,
  LLM_RUNTIME_STATUSES,
  SEVERITIES,
} from '@ai-review/shared';
import { index, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * 审查记录表（对齐方案六 reviews 表）。
 * 与方案的差异：追加 model / report_json 列——报告五段落（summary/assessment 等）为非规范化字符串，
 * 拆列存储成本过高，故整体以 JSON 存于 report_json，findings 仍走规范化的行级存储（支持误报标记）。
 */
export const reviews = sqliteTable('reviews', {
  id: text('id').primaryKey(),
  repoPath: text('repo_path').notNull(),
  branch: text('branch').notNull(),
  commitHash: text('commit_hash'),
  author: text('author'),
  /** 如 "mock + 静态分析" */
  model: text('model').notNull(),
  mode: text('mode', { enum: ['fast', 'full'] }).notNull(),
  /** 发起时配置的阻断阈值（SSE 晚连接重放需按原阈值重算 blocking）；存量记录为 NULL（等同 BLOCKER） */
  blockOn: text('block_on', { enum: ['BLOCKER', 'WARNING', 'NIT'] }),
  /** 审查目标（staged/worktree/commit/range）；存量记录为 NULL（等同 staged） */
  target: text('target'),
  /** 审查来源的可读描述（如 range:main...HEAD），供列表页展示 */
  sourceLabel: text('source_label'),
  status: text('status', { enum: ['completed', 'failed', 'cancelled'] })
    .notNull()
    .default('completed'),
  /** 0-100 综合风险评分（Risk Planner 输出的最大文件风险分） */
  riskScore: real('risk_score').notNull(),
  totalFindings: integer('total_findings').notNull().default(0),
  blockerCount: integer('blocker_count').notNull().default(0),
  warningCount: integer('warning_count').notNull().default(0),
  nitCount: integer('nit_count').notNull().default(0),
  tokenUsed: integer('token_used').notNull().default(0),
  durationMs: integer('duration_ms').notNull(),
  reportJson: text('report_json').notNull(),
  /** 被审查的原始 unified diff（Dashboard diff 视图数据源；超长截断，存量记录为 NULL） */
  diffText: text('diff_text'),
  /** 失败/取消原因（status 异常时非空） */
  errorMessage: text('error_message'),
  /**
   * 发起人用户 id（Web 端数据隔离依据）。
   * 软引用：不建 FK——存量 CLI 直跑的记录无发起人，且删除用户时历史审查应保留。
   */
  createdBy: text('created_by'),
  /** 0-100 变更风险分（RiskPlanner 输出，与审查结论分分离） */
  changeRiskScore: real('change_risk_score'),
  /** 0-100 审查结论分（发现加权） */
  reviewScore: real('review_score'),
  /** 本次审查的 LLM 运行时状态；NULL 表示旧记录（视为正常） */
  llmStatus: text('llm_status', { enum: LLM_RUNTIME_STATUSES }),
  /** 审查 Prompt 版本（回溯与缓存失效依据） */
  promptVersion: text('prompt_version'),
  /** 内容哈希缓存命中的文件数 */
  cacheHits: integer('cache_hits').notNull().default(0),
  /** 自愈复核轮次 */
  healRounds: integer('heal_rounds').notNull().default(0),
  /** 实际启用的审查维度（JSON 数组字符串） */
  dimensions: text('dimensions'),
  /** 重跑来源审查 id（链路追溯） */
  parentReviewId: text('parent_review_id'),
  /** 人工审查决策：approve / request_changes / comment */
  decision: text('decision', { enum: ['approve', 'request_changes', 'comment'] }),
  /** 决策备注 */
  decisionComment: text('decision_comment'),
  /** 决策人用户 id */
  decidedBy: text('decided_by'),
  decidedAt: text('decided_at'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

/** 审查发现表（对齐方案六 findings 表；id 为误报标记 API 的行键） */
export const findings = sqliteTable(
  'findings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    reviewId: text('review_id')
      .notNull()
      .references(() => reviews.id),
    agent: text('agent', { enum: AGENT_DIMENSIONS }).notNull(),
    severity: text('severity', { enum: SEVERITIES }).notNull(),
    /** 0-1（交叉验证阶段 2 计算后落库） */
    confidence: real('confidence').notNull(),
    filePath: text('file_path').notNull(),
    lineStart: integer('line_start').notNull(),
    lineEnd: integer('line_end').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    suggestion: text('suggestion'),
    codeSnippet: text('code_snippet'),
    cweId: text('cwe_id'),
    lowConfidence: integer('low_confidence', { mode: 'boolean' }).notNull().default(false),
    /** Dashboard 误报标记，回流为置信度模型优化数据（方案 3.10） */
    isFalsePositive: integer('is_false_positive', { mode: 'boolean' }).notNull().default(false),
    /** 问题指纹：跨维度/跨轮次/缓存复用的稳定身份 */
    fingerprint: text('fingerprint'),
    /** 发现来源：llm / static / heal / cross-file / cache */
    origin: text('origin', { enum: FINDING_ORIGINS }),
    /** 行号语义：changed（变更行）/ context（上下文行，不阻断） */
    lineScope: text('line_scope', { enum: FINDING_LINE_SCOPES }),
    /** 同一问题命中的维度列表（JSON 数组字符串） */
    agents: text('agents'),
    /** 人工处置状态（open/acknowledged/fixed/ignored/false_positive） */
    status: text('status', { enum: FINDING_STATUSES }).notNull().default('open'),
    /** 命中的自定义规则 id（规则命中溯源） */
    ruleId: text('rule_id'),
    /** 产出该发现的审查轮次（0=首轮，1..=自愈） */
    reviewRound: integer('review_round').notNull().default(0),
    updatedAt: text('updated_at'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_findings_review').on(table.reviewId),
    index('idx_findings_fingerprint').on(table.fingerprint),
  ],
);

/** 发现评论表：人工协作记录，不参与流水线判定 */ export const findingComments = sqliteTable(
  'finding_comments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    findingId: integer('finding_id')
      .notNull()
      .references(() => findings.id),
    /** 评论人；账号删除后保留用户名（软引用） */
    userId: text('user_id'),
    username: text('username').notNull(),
    body: text('body').notNull(),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [index('idx_finding_comments_finding').on(table.findingId)],
);

/** 审查决策历史（append-only；reviews 表保留最新决策，便于列表查询） */
export const reviewDecisionEvents = sqliteTable(
  'review_decision_events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    reviewId: text('review_id').notNull(),
    decision: text('decision', { enum: ['approve', 'request_changes', 'comment'] }).notNull(),
    comment: text('comment'),
    decidedBy: text('decided_by').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('idx_review_decision_events_review').on(table.reviewId)],
);

/**
 * 流水线节点检查点（每完成一个节点落一行）。
 * 与 SSE 的实时事件互补：进程重启后仍能回答“这次审查执行到哪、每个节点耗时多少”。
 */
export const reviewStages = sqliteTable(
  'review_stages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    reviewId: text('review_id').notNull(),
    node: text('node').notNull(),
    status: text('status', { enum: ['completed', 'failed'] }).notNull(),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at').notNull(),
    durationMs: integer('duration_ms').notNull().default(0),
    /** 节点摘要（JSON 字符串；不存整份 state，避免重复膨胀） */
    detail: text('detail'),
  },
  (table) => [index('idx_review_stages_review').on(table.reviewId)],
);

/**
 * 模型调用审计表（一次维度调用一行；自愈轮次单独一行）。
 * 与 reviews.token_used 的区别：这里保留每次调用的 provider/model/usage/耗时/失败原因，
 * 用于回答“为什么降级、为什么这次审查没调用模型、哪个维度最贵”。
 */
export const llmCalls = sqliteTable(
  'llm_calls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    reviewId: text('review_id')
      .notNull()
      .references(() => reviews.id),
    dimension: text('dimension').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    status: text('status', { enum: LLM_RUNTIME_STATUSES }).notNull(),
    /** 0=首轮；1..=自愈轮次 */
    round: integer('round').notNull().default(0),
    promptTokens: integer('prompt_tokens').notNull().default(0),
    completionTokens: integer('completion_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    /** usage 是否为字符数估算（provider 未返回 usage 时） */
    estimated: integer('estimated', { mode: 'boolean' }).notNull().default(false),
    latencyMs: integer('latency_ms').notNull().default(0),
    promptChars: integer('prompt_chars').notNull().default(0),
    fallbackUsed: integer('fallback_used', { mode: 'boolean' }).notNull().default(false),
    /** 降级链每次尝试（JSON 数组字符串） */
    attemptsJson: text('attempts_json').notNull().default('[]'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_llm_calls_review').on(table.reviewId),
    index('idx_llm_calls_created').on(table.createdAt),
  ],
);

/**
 * 审查缓存表（方案六 review_cache；方案 3.0 步骤 8 内容哈希去重）。
 * 键为 hash(agent + prompt 版本 + 新侧内容全文)，与仓库路径无关——
 * 相同代码块跨仓库、跨审查复用同一份发现，token_saved 量化节省成本。
 */
export const reviewCache = sqliteTable('review_cache', {
  cacheKey: text('cache_key').primaryKey(),
  reviewId: text('review_id'),
  findingsJson: text('findings_json').notNull(),
  tokenSaved: integer('token_saved').notNull().default(0),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

/**
 * 用户表（Web 端认证，方案 3.10 团队版扩展）。
 * 首个注册用户自动获得 admin 角色（服务端事务内判定），其余为 user。
 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  username: text('username').notNull().unique(),
  /** scrypt 哈希（salt$hash 格式），明文密码与哈希均不出服务端 */
  passwordHash: text('password_hash').notNull(),
  /** 头像文件在服务端的相对访问路径；未上传为 NULL */
  avatarUrl: text('avatar_url'),
  role: text('role', { enum: ['admin', 'user'] })
    .notNull()
    .default('user'),
  status: text('status', { enum: ['active', 'disabled'] })
    .notNull()
    .default('active'),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
  lastLoginAt: text('last_login_at'),
});

/** 会话表：不透明令牌（Cookie 承载）→ 用户。过期行由创建新会话时惰性清理 */
export const sessions = sqliteTable('sessions', {
  token: text('token').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

/** 角色表（RBAC）：权限为系统动态路由的访问路径集合（JSON 数组） */
export const roles = sqliteTable('roles', {
  id: text('id').primaryKey(),
  /** 角色名唯一 */
  name: text('name').notNull().unique(),
  description: text('description'),
  /** 数值越小优先级越高；多角色时取最高优先级角色作为默认角色 */
  priority: integer('priority').notNull().default(100),
  /** 权限集合：JSON 字符串数组，元素为路由路径，'*' 表示全部 */
  permissions: text('permissions').notNull().default('[]'),
  /** 内置角色不可删除（admin/user） */
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at')
    .notNull()
    .$defaultFn(() => new Date().toISOString()),
});

/**
 * 登录日志表（认证事件审计，参照云审计字段规范）。
 * 失败登录同样入库（含尝试用户名与 IP），供安全分析与异常登录检测；
 * 不记录密码、令牌等任何敏感信息。
 */
export const loginLogs = sqliteTable(
  'login_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 操作用户 id；登录失败且用户不存在时为 NULL */
    userId: text('user_id'),
    /** 尝试登录的用户名（失败登录同样记录） */
    username: text('username').notNull(),
    action: text('action', {
      enum: ['login', 'logout', 'register', 'change_password'],
    }).notNull(),
    status: text('status', { enum: ['success', 'failed'] }).notNull(),
    /** 失败原因（invalid-credentials / account-disabled 等）；成功为 NULL */
    reason: text('reason'),
    /** 来源 IP */
    ip: text('ip').notNull(),
    /** 客户端 User-Agent；无则空串 */
    userAgent: text('user_agent').notNull().default(''),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_login_logs_created_at').on(table.createdAt),
    index('idx_login_logs_username').on(table.username),
  ],
);

/**
 * 操作日志表（管理后台与审查写操作审计）。
 * 记录操作者、动作、目标资源与结果；detail 为 JSON 摘要，禁止记录密码/令牌。
 */
export const operationLogs = sqliteTable(
  'operation_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** 操作者用户 id；匿名请求（如登录失败）为 NULL */
    userId: text('user_id'),
    username: text('username').notNull(),
    action: text('action', {
      enum: [
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
      ],
    }).notNull(),
    /** 资源类型（user / role / config / rules / review / finding / knowledge / auth） */
    resource: text('resource').notNull(),
    /** 目标资源 id（如用户 id、审查 id）；无则空串 */
    resourceId: text('resource_id').notNull().default(''),
    /** 操作摘要 JSON；不记录密码/令牌等敏感字段 */
    detail: text('detail').notNull().default(''),
    status: text('status', { enum: ['success', 'failed'] }).notNull(),
    /** 失败原因 */
    reason: text('reason'),
    ip: text('ip').notNull(),
    userAgent: text('user_agent').notNull().default(''),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index('idx_operation_logs_created_at').on(table.createdAt),
    index('idx_operation_logs_username').on(table.username),
  ],
);

/** 用户-角色关联表（多对多） */
export const userRoles = sqliteTable(
  'user_roles',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [primaryKey({ columns: [table.userId, table.roleId] })],
);

/**
 * Git Hook / CI 令牌表（Web 一键安装 Hook 的凭据）。
 * 令牌以 SHA-256 摘要保存：数据库泄露不直接泄漏可用凭据；
 * 明文只在签发响应中出现一次，落盘位置由安装接口写入 `.ai-review-cache/hook-token`（已 gitignore）。
 */
export const hookTokens = sqliteTable(
  'hook_tokens',
  {
    id: text('id').primaryKey(),
    /** 令牌摘要（sha256 hex）；比对按摘要进行，库内不存在明文 */
    tokenHash: text('token_hash').notNull().unique(),
    /** 展示用前缀（明文前 8 位），供管理员辨认具体令牌 */
    prefix: text('prefix').notNull(),
    label: text('label').notNull().default('hook'),
    /** 签发人；令牌由管理员创建，故通常非 NULL */
    createdBy: text('created_by'),
    createdAt: text('created_at')
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
    /** 过期时间；NULL 表示不过期 */
    expiresAt: text('expires_at'),
    lastUsedAt: text('last_used_at'),
    revokedAt: text('revoked_at'),
  },
  (table) => [index('idx_hook_tokens_hash').on(table.tokenHash)],
);

export type ReviewRow = typeof reviews.$inferSelect;
export type FindingRow = typeof findings.$inferSelect;
export type FindingCommentRow = typeof findingComments.$inferSelect;
export type ReviewDecisionEventRow = typeof reviewDecisionEvents.$inferSelect;
export type ReviewStageRow = typeof reviewStages.$inferSelect;
export type LlmCallRow = typeof llmCalls.$inferSelect;
export type ReviewCacheRow = typeof reviewCache.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type LoginLogRow = typeof loginLogs.$inferSelect;
export type OperationLogRow = typeof operationLogs.$inferSelect;
export type HookTokenRow = typeof hookTokens.$inferSelect;
