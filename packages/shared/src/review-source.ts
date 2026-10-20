import { z } from 'zod';

/**
 * 审查目标（方案 3.0 触发环节的 Web 化扩展）。
 * 审查对象不再只有暂存区：Web 端与 Hook 均可指定提交或区间。
 */
export const REVIEW_TARGETS = ['staged', 'worktree', 'commit', 'range'] as const;
export type ReviewTarget = (typeof REVIEW_TARGETS)[number];

/** 审查目标的中文标签（服务端报告、前端选择器与审计日志共用） */
export const REVIEW_TARGET_LABELS: Readonly<Record<ReviewTarget, string>> = {
  staged: '暂存区',
  worktree: '工作区',
  commit: '单个提交',
  range: '提交区间',
};

/**
 * git 引用（分支/SHA/相对引用）的白名单校验。
 * 拒绝以 `-` 开头的值：git 会把 `--upload-pack=...` 之类参数当作选项执行，
 * 这是参数注入的最短路径。同时拒绝空白与控制字符。
 */
export const GitRefSchema = z
  .string()
  .trim()
  .min(1, '引用不能为空')
  .max(255)
  // 首字符排除 `-`：git 会把 `--output=...` 之类当作选项，是参数注入的最短路径
  .regex(/^[A-Za-z0-9._/@{}^~:][A-Za-z0-9._/@{}^~:-]*$/, '引用包含非法字符');

/**
 * 审查范围。判别式结构保证"目标与参数"不会错配：
 * - staged：暂存区（index）与 HEAD 的差异
 * - worktree：HEAD 与工作区磁盘的差异（含未暂存改动，未跟踪文件不计入）
 * - commit：单个提交相对其父提交的差异
 * - range：`base...head` 区间（head 缺省为 HEAD）
 */
export const ReviewSourceSchema = z.discriminatedUnion('target', [
  z.object({ target: z.literal('staged') }),
  z.object({ target: z.literal('worktree') }),
  z.object({ target: z.literal('commit'), commit: GitRefSchema }),
  z.object({
    target: z.literal('range'),
    base: GitRefSchema,
    head: GitRefSchema.optional(),
  }),
]);
export type ReviewSource = z.infer<typeof ReviewSourceSchema>;

/** 默认审查目标：提交前把关（与既有行为一致） */
export const DEFAULT_REVIEW_SOURCE: ReviewSource = { target: 'staged' };

/**
 * 归一化审查来源：缺省字段补默认值。
 * 供服务端在未显式传 target 的旧请求上保持"审查暂存区"的既有语义。
 * @param source 可省略的部分审查来源
 * @returns 完整审查来源
 */
export function normalizeReviewSource(source?: Partial<ReviewSource>): ReviewSource {
  if (source === undefined || source.target === undefined) return DEFAULT_REVIEW_SOURCE;
  return ReviewSourceSchema.parse(source);
}

/**
 * 审查来源的稳定字符串表示（审计日志、缓存键与报告展示共用）。
 * @param source 审查来源
 * @returns 如 `staged`、`range:main...HEAD`、`commit:abc1234`
 */
export function describeReviewSource(source: ReviewSource): string {
  switch (source.target) {
    case 'staged':
      return 'staged';
    case 'worktree':
      return 'worktree';
    case 'commit':
      return `commit:${source.commit}`;
    case 'range':
      return `range:${source.base}...${source.head ?? 'HEAD'}`;
  }
}
