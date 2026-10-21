import { z } from 'zod';
import { AGENT_DIMENSIONS, SEVERITIES } from './severity.js';

/**
 * 发现来源：决定置信度基线与报告中的证据标签。
 * - llm：模型语义审查
 * - static：确定性工具/规则
 * - heal：自愈轮次重审
 * - cross-file：跨文件/测试影响的确定性核对
 * - cache：内容哈希缓存命中（仍会重新做行号校验）
 */
export const FINDING_ORIGINS = ['llm', 'static', 'heal', 'cross-file', 'cache'] as const;
export type FindingOrigin = (typeof FINDING_ORIGINS)[number];

/** 行号语义：changed = 落在变更行；context = 落在本次未修改的上文/下文（不能直接阻断） */
export const FINDING_LINE_SCOPES = ['changed', 'context'] as const;
export type FindingLineScope = (typeof FINDING_LINE_SCOPES)[number];

/** 人工处置状态（Dashboard 闭环；流水线产出恒为 open） */
export const FINDING_STATUSES = [
  'open',
  'acknowledged',
  'fixed',
  'ignored',
  'false_positive',
] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/**
 * 审查发现——LLM 输出与静态分析产出的统一结构（对齐方案六、findings 表）。
 * 该 schema 是"LLM 输出经 zod 解析"链路的契约：解析失败的发现整条丢弃并计入自愈触发条件（方案 3.6）。
 * 新增字段一律 optional 并提供默认语义，保证旧 DB 行与旧客户端契约可读。
 */
export const FindingSchema = z.object({
  agent: z.enum(AGENT_DIMENSIONS),
  severity: z.enum(SEVERITIES),
  /** 0-1，交叉验证阶段 2 会重算（方案 3.6 阶段 2） */
  confidence: z.number().min(0).max(1),
  filePath: z.string().min(1),
  lineStart: z.number().int().min(1),
  lineEnd: z.number().int().min(1),
  title: z.string().min(1),
  description: z.string(),
  suggestion: z.string().optional(),
  codeSnippet: z.string().optional(),
  /** CWE-89 等编号；无法通过外部校验的 CVE/CWE 引用在交叉验证中移除 */
  cweId: z.string().optional(),
  /** LLM 自标记 LOW_CONFIDENCE（System Prompt 约束：不确定时标记而非编造） */
  lowConfidence: z.boolean().optional(),
  /** Dashboard 误报标记（落库字段，流水线内恒为 false） */
  isFalsePositive: z.boolean().default(false),
  /** 发现来源（缺省按 agent 推断：static → static，其余 → llm） */
  origin: z.enum(FINDING_ORIGINS).optional(),
  /** 行号语义（缺省按是否落在变更行推断） */
  lineScope: z.enum(FINDING_LINE_SCOPES).optional(),
  /** 问题指纹：跨维度/跨轮次/缓存复用的稳定身份 */
  fingerprint: z.string().min(1).max(64).optional(),
  /** 命中的自定义规则 ID（规则命中溯源） */
  ruleId: z.string().min(1).optional(),
  /** 人工处置状态（详情接口返回，流水线不写） */
  status: z.enum(FINDING_STATUSES).optional(),
  /** 同一问题被哪些维度命中（跨维度合并后保留） */
  agents: z.array(z.enum(AGENT_DIMENSIONS)).min(1).optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

/**
 * 结构化输出契约：模型只提供“问题本身”，agent/origin/误报/指纹等由平台侧补齐。
 * 与 FindingSchema 分开，避免模型被要求填写它无法可靠决定的平台字段。
 */
export const FindingOutputSchema = z.object({
  severity: z.enum(SEVERITIES),
  confidence: z.number().min(0).max(1).default(0.6),
  filePath: z.string().min(1),
  lineStart: z.number().int().min(1),
  lineEnd: z.number().int().min(1),
  title: z.string().min(1),
  description: z.string(),
  suggestion: z.string().optional(),
  cweId: z.string().optional(),
  lowConfidence: z.boolean().optional(),
});
export type FindingOutput = z.infer<typeof FindingOutputSchema>;

/** 结构化输出的根对象（AI SDK generateObject 需要 object 根） */
export const FindingsOutputSchema = z.object({
  findings: z.array(FindingOutputSchema).max(50),
});
export type FindingsOutput = z.infer<typeof FindingsOutputSchema>;

/**
 * 发现来源的缺省推断：静态工具的产物即使 agent 被外部篡改，也按 agent 字段判定；
 * 其余一律视为语义审查。
 * @param finding 发现
 * @returns 来源
 */
export function resolveFindingOrigin(finding: Finding): FindingOrigin {
  if (finding.origin !== undefined) return finding.origin;
  return finding.agent === 'static' ? 'static' : 'llm';
}
