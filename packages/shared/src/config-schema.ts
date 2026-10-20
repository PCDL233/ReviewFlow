import { z } from 'zod';
import { MODEL_PROVIDER_IDS } from './model-catalog.js';

/** 自定义规则的匹配范围：变更新增行 / 暂存文件全文 / 变更函数源码片段 */
export const CUSTOM_RULE_MATCH_SCOPES = ['added', 'staged', 'snippet'] as const;
export type CustomRuleMatchScope = (typeof CUSTOM_RULE_MATCH_SCOPES)[number];

/**
 * 用户自定义代码审查规则（管理员在管理后台维护，随 .ai-review.yml 生效）。
 * 规则是确定性静态检查：正则命中即产出 Finding（agent=static），
 * 经 custom_rule_check 工具在流水线 static 阶段执行。
 * 该 schema 保持浏览器安全（不引用 node:fs），供配置、API 契约与前端表单共享。
 */
export const CustomRuleSchema = z.object({
  /** 规则名（在发现标题中展示；建议保持唯一） */
  name: z.string().min(1),
  /** 规则说明（作为发现的描述文案） */
  description: z.string().default(''),
  /** 正则表达式源码；命中即触发。仅允许 JS 正则支持的 flag 子集 */
  pattern: z.string().min(1).max(1024),
  /** 正则 flag（如 i / m / s）；非法 flag 会被规则引擎忽略并跳过该规则 */
  flags: z
    .string()
    .max(8)
    .regex(/^[dgimsuvy]*$/, 'only JS regex flags (dgimsuvy) are allowed')
    .default(''),
  /** 触发严重度（规则不产出 PRAISE） */
  severity: z.enum(['BLOCKER', 'WARNING', 'NIT']).default('WARNING'),
  /** 发现标题；为空时回退为规则名 */
  message: z.string().default(''),
  /** 修复建议 */
  suggestion: z.string().default(''),
  /** 可选 CWE 编号（映射到 Finding.cweId，如 CWE-1177） */
  cweId: z.string().optional(),
  /** 文件 glob 过滤（picomatch 语义）；为空表示匹配全部文件 */
  filePatterns: z.array(z.string()).default([]),
  /** 匹配范围；默认仅匹配变更新增行 */
  matchScope: z.array(z.enum(CUSTOM_RULE_MATCH_SCOPES)).default(['added']),
  /** 启用开关；禁用规则不参与匹配但保留配置 */
  enabled: z.boolean().default(true),
});
export type CustomRule = z.infer<typeof CustomRuleSchema>;

/**
 * 配置 schema 的浏览器安全版本。
 * 该文件不引用 node:fs，供 API 契约和前端配置表单共享同一份结构定义。
 */
export const AiReviewConfigSchema = z.object({
  llm: z
    .object({
      provider: z.enum(MODEL_PROVIDER_IDS).default('anthropic'),
      model: z.string().default('claude-sonnet-5'),
      apiKey: z.string().default('${AI_REVIEW_API_KEY}'),
      baseUrl: z.string().optional(),
      maxTokensPerReview: z.number().int().positive().max(200_000).default(50_000),
      temperature: z.number().min(0).max(2).default(0.1),
      mockFixturesDir: z.string().default('.ai-review-cache/llm-fixtures'),
    })
    .prefault({}),
  review: z
    .object({
      mode: z.enum(['fast', 'full']).default('fast'),
      dimensions: z
        .array(z.enum(['correctness', 'security', 'performance', 'maintainability']))
        .default(['correctness', 'security', 'performance', 'maintainability']),
      blockOn: z.enum(['BLOCKER', 'WARNING', 'NIT']).default('BLOCKER'),
      ignorePatterns: z
        .array(z.string())
        .default(['*.lock', 'pnpm-lock.yaml', 'dist/**', '*.min.js']),
      /** 单次审查最多纳入的文件数（按风险分降序截断）；超限文件在报告中显式标注 */
      maxFiles: z.number().int().min(1).max(2000).default(200),
      /** 单次审查最多纳入的变更行数（additions + deletions）；超限按文件截断 */
      maxChangedLines: z.number().int().min(100).max(200_000).default(20_000),
    })
    .prefault({}),
  rag: z
    .object({
      enabled: z.boolean().default(true),
      knowledgeBasePaths: z.array(z.string()).default(['docs/']),
      indexDir: z.string().default('.ai-review-cache/vectors'),
      topK: z.number().int().min(1).max(20).default(5),
    })
    .prefault({}),
  staticAnalysis: z
    .object({
      enabledTools: z
        .array(z.string())
        .default([
          'ast_parse',
          'complexity_check',
          'secret_scan',
          'dependency_scan',
          'custom_rule_check',
        ]),
      complexityThreshold: z.number().int().min(1).default(15),
    })
    .prefault({}),
  /** 用户自定义审查规则；未配置任何规则时 custom_rule_check 工具为空操作 */
  customRules: z.array(CustomRuleSchema).default([]),
  report: z
    .object({
      format: z.enum(['markdown', 'html', 'json']).default('markdown'),
      /** 导出默认目录提示（Web 端导出走浏览器下载，服务端不再写盘） */
      outputDir: z.string().default('.ai-review-reports'),
      /** 报告中是否保留 PRAISE（正向提示）级发现 */
      includePraise: z.boolean().default(true),
    })
    .prefault({}),
  /**
   * 审计日志配置（登录日志 + 操作日志）。
   * 日志同时写 SQLite（后台页面查询）与按日滚动的 JSON Lines 文件（运维归档），并输出到控制台。
   */
  logging: z
    .object({
      /** 总开关；关闭后不再写入新日志（存量日志仍可查询） */
      enabled: z.boolean().default(true),
      /** 是否输出到控制台（stdout） */
      console: z.boolean().default(true),
      /** 是否写文件归档 */
      file: z.boolean().default(true),
      /** 日志文件目录（按日滚动：<dir>/ai-review-YYYY-MM-DD.log） */
      dir: z.string().default('logs'),
      /** 日志文件保留天数；超过自动清理 */
      maxDays: z.number().int().min(1).max(3650).default(30),
    })
    .prefault({}),
  /**
   * 服务端运行参数（原 AI_REVIEW_* 环境变量，现可在管理后台配置）。
   * 生效优先级：环境变量 > 此处配置 > 默认值（部署层环境变量仍可覆盖 web 保存的值）。
   * 属基础设施配置，服务启动时读取一次，保存后需重启服务生效。
   */
  server: z
    .object({
      /** 允许发起审查的仓库根目录白名单；空数组表示仅当前工作目录（等价 AI_REVIEW_ALLOWED_ROOTS） */
      allowedRoots: z.array(z.string()).default([]),
      /** 并行审查任务上限（信号量排队，防压垮 LLM 配额；等价 AI_REVIEW_MAX_CONCURRENT） */
      maxConcurrent: z.number().int().min(1).max(64).default(3),
      /** 强制会话 Cookie 携带 Secure（NODE_ENV=production 下自动开启，此处可显式开启；等价 AI_REVIEW_COOKIE_SECURE） */
      cookieSecure: z.boolean().default(false),
      /** 放开开放注册（缺省仅在无任何用户时允许；等价 AI_REVIEW_ALLOW_REGISTER） */
      allowRegister: z.boolean().default(false),
      /** 反向代理部署时开启：限流/审计改用 X-Forwarded-For 识别真实客户端 IP（等价 AI_REVIEW_TRUST_PROXY） */
      trustProxy: z.boolean().default(false),
      /** Ollama 回退模型（云端 provider 不可用时的本地兜底；等价 AI_REVIEW_OLLAMA_MODEL） */
      ollamaModel: z.string().default('qwen3-coder:30b'),
      /** Hook/CI 同步审查的超时（毫秒）；超时返回退出码 3 且不阻断提交 */
      hookTimeoutMs: z.number().int().min(10_000).max(600_000).default(120_000),
      /** 是否暴露 /api/mcp（MCP over Streamable HTTP）；默认关闭 */
      mcpEnabled: z.boolean().default(false),
    })
    .prefault({}),
});

export type AiReviewConfig = z.infer<typeof AiReviewConfigSchema>;
