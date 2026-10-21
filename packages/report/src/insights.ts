import { describeLlmStatus } from '@ai-review/shared';
import type { Finding, LlmRuntimeStatus } from '@ai-review/shared';

/** 质量说明的数据来源：全部来自流水线指标，不写“看起来专业”的空话 */
export type QualityNoteOptions = {
  degradedToStatic?: readonly string[];
  truncatedFiles?: readonly string[];
  skippedFiles?: readonly string[];
  llmStatus?: LlmRuntimeStatus | undefined;
  cacheHits?: number | undefined;
  healRounds?: number | undefined;
  healIneffective?: boolean | undefined;
  dimensions?: readonly string[] | undefined;
  filesReviewed?: number | undefined;
};

/**
 * 根据流水线结果生成报告中的代码质量摘要（CLI 与服务端输出一致）。
 * 关键点：未覆盖范围、LLM 状态、缓存命中、自愈无效都必须显式写出，
 * 否则“审查通过”会被误读为“全部文件都被模型审过”。
 */
export function deriveQualityNotes(
  totalFiles: number,
  findings: readonly Finding[],
  options: QualityNoteOptions = {},
): string[] {
  const counts = { BLOCKER: 0, WARNING: 0, NIT: 0, PRAISE: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  const contextFindings = findings.filter((finding) => finding.lineScope === 'context').length;
  const notes = [
    `本次变更涉及 ${totalFiles} 个文件；LLM 实际审查 ${options.filesReviewed ?? 0} 个文件，启用维度：${
      options.dimensions === undefined || options.dimensions.length === 0
        ? '未启用'
        : options.dimensions.join('、')
    }。`,
    findings.length === 0
      ? '未发现配置规则覆盖范围内的问题。'
      : `共识别 ${findings.length} 个问题（BLOCKER ${counts.BLOCKER} / WARNING ${counts.WARNING} / NIT ${counts.NIT} / PRAISE ${counts.PRAISE}），已按严重度与置信度排序。`,
  ];

  if (options.llmStatus !== undefined) {
    notes.push(`模型状态：${describeLlmStatus(options.llmStatus)}。`);
  }
  if (contextFindings > 0) {
    notes.push(
      `其中 ${contextFindings} 条问题位于本次未修改的上下文行，标记为 context，不参与阻断判定。`,
    );
  }
  if ((options.cacheHits ?? 0) > 0) {
    notes.push(`${options.cacheHits} 个文件命中内容哈希缓存，复用历史结论并重新校验了行号。`);
  }
  if ((options.healRounds ?? 0) > 0) {
    notes.push(
      options.healIneffective === true
        ? `自愈复核执行 ${options.healRounds} 轮后置信度仍未提升，相关结论保留为低置信度。`
        : `自愈复核执行 ${options.healRounds} 轮，低置信度结论已按复核结果更新。`,
    );
  }
  if (options.degradedToStatic !== undefined && options.degradedToStatic.length > 0) {
    notes.push(`预算受限，以下文件降级为仅静态分析：${options.degradedToStatic.join('、')}。`);
  }
  if (options.truncatedFiles !== undefined && options.truncatedFiles.length > 0) {
    notes.push(
      `超出单次审查规模上限（review.maxFiles / maxChangedLines），以下文件未做 LLM 审查：${options.truncatedFiles.join('、')}。`,
    );
  }
  if (options.skippedFiles !== undefined && options.skippedFiles.length > 0) {
    notes.push(
      `因忽略规则、二进制或无实质变更被跳过：${options.skippedFiles.slice(0, 20).join('、')}${
        options.skippedFiles.length > 20 ? ' 等' : ''
      }。`,
    );
  }
  return notes;
}

/** 从发现中提取去重后的改进建议，避免报告只展示问题而没有行动项。 */
export function deriveSuggestions(findings: readonly Finding[]): string[] {
  return [
    ...new Set(
      findings
        .map((finding) => finding.suggestion)
        .filter((value): value is string => value !== undefined && value.trim() !== ''),
    ),
  ];
}
