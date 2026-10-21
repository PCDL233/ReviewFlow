import { FindingSchema, ensureFindingFingerprint } from '@ai-review/shared';
import type { CodeContext, FileContext, Finding } from '@ai-review/shared';
import type { ReviewDimension } from '@ai-review/llm';

/**
 * 发现校验（方案 3.6“结构化输出校验”）。
 * 与旧实现的区别：
 * - agent 强制为当前维度，模型自报的 agent 一律忽略（防止伪造静态基线）；
 * - 落在上下文行的发现不再静默丢弃，而是标记 lineScope=context 并降级（BLOCKER→WARNING）；
 * - 文件不存在/行号越界/schema 不合法分别计数，进入报告的可观测指标。
 */

export type RejectedFindingReason =
  'unknown-file' | 'invalid-range' | 'out-of-range' | 'schema' | 'duplicate';

export type FindingValidationResult = {
  findings: Finding[];
  rejected: number;
  contextFindings: number;
  reasons: Partial<Record<RejectedFindingReason, number>>;
};

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function contentLineCount(file: FileContext): number {
  if (file.stagedContent === '') return 0;
  return file.stagedContent.split(/\r?\n/).length;
}

function changedLineNumbers(file: FileContext): Set<number> {
  return new Set(
    file.diff.changedLines.flatMap((line) => (line.newLineNo === null ? [] : [line.newLineNo])),
  );
}

function intersectsChangedLines(
  lineStart: number,
  lineEnd: number,
  changed: ReadonlySet<number>,
): boolean {
  for (let line = lineStart; line <= lineEnd; line += 1) {
    if (changed.has(line)) return true;
  }
  return false;
}

/**
 * 校验并归一化模型发现。
 * @param findings 模型输出（已经过 schema 的初步解析）
 * @param context 当前审查上下文
 * @param dimension 当前维度（强制写入 agent）
 * @returns 可用发现与拒绝统计
 */
export function validateFindings(
  findings: readonly Finding[],
  context: CodeContext,
  dimension: ReviewDimension,
): FindingValidationResult {
  const files = new Map<string, FileContext>();
  for (const file of context.files) files.set(normalizePath(file.diff.path), file);

  const reasons: Partial<Record<RejectedFindingReason, number>> = {};
  const reject = (reason: RejectedFindingReason): void => {
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  };

  const accepted = new Map<string, Finding>();
  let contextFindings = 0;

  for (const finding of findings) {
    const file = files.get(normalizePath(finding.filePath));
    if (file === undefined) {
      reject('unknown-file');
      continue;
    }
    if (finding.lineEnd < finding.lineStart || finding.lineStart < 1) {
      reject('invalid-range');
      continue;
    }
    const lineCount = contentLineCount(file);
    if (lineCount === 0 || finding.lineEnd > lineCount) {
      reject('out-of-range');
      continue;
    }

    const changed = intersectsChangedLines(
      finding.lineStart,
      finding.lineEnd,
      changedLineNumbers(file),
    );
    const lineScope = changed ? 'changed' : 'context';
    if (!changed) contextFindings += 1;

    const parsed = FindingSchema.safeParse({
      ...finding,
      // 模型无权决定归属：agent 是维度，origin 只允许 llm（缓存/自愈由流水线改写）
      agent: dimension,
      origin: finding.origin ?? 'llm',
      lineScope,
      // 上下文行的问题不能直接阻断提交；BLOCKER 降级为 WARNING
      severity: !changed && finding.severity === 'BLOCKER' ? 'WARNING' : finding.severity,
      ...(changed ? {} : { lowConfidence: true }),
      isFalsePositive: false,
      filePath: file.diff.path,
    });
    if (!parsed.success) {
      reject('schema');
      continue;
    }
    const normalized = ensureFindingFingerprint(parsed.data);
    const key = normalized.fingerprint ?? '';
    const existing = accepted.get(key);
    if (existing !== undefined) {
      reject('duplicate');
      if (normalized.confidence > existing.confidence) accepted.set(key, normalized);
      continue;
    }
    accepted.set(key, normalized);
  }

  return {
    findings: [...accepted.values()],
    rejected: Object.values(reasons).reduce((sum, value) => sum + (value ?? 0), 0),
    contextFindings,
    reasons,
  };
}
