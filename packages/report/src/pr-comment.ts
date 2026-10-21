import { describeLlmStatus, severityMeetsThreshold } from '@ai-review/shared';
import type { Finding, ReviewReport } from '@ai-review/shared';

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function renderFinding(finding: Finding): string {
  return `| ${finding.severity} | \`${finding.filePath}:${finding.lineStart}\` | ${escapeCell(finding.title)} | ${Math.round(finding.confidence * 100)}% |`;
}

/**
 * PR 评论用的紧凑 Markdown（与完整五段式报告同源，便于 CI 直接回帖）。
 * 只保留结论、阻断项与最多 10 条问题，完整内容仍由导出接口提供。
 * @param report 报告数据（ReviewReportDetail 可直接传入）
 * @returns Markdown 文本
 */
export function renderPrComment(report: ReviewReport): string {
  const blockOn = report.meta.blockOn ?? 'BLOCKER';
  const findings = report.findings.filter((finding) => !finding.isFalsePositive);
  const blocking = findings.some((finding) => severityMeetsThreshold(finding.severity, blockOn));
  const counts = { BLOCKER: 0, WARNING: 0, NIT: 0, PRAISE: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  const issues = findings.filter((finding) => finding.severity !== 'PRAISE');
  const shown = issues.slice(0, 10);
  const lines = [
    '## AI Code Review',
    '',
    `- 审查 ID：\`${report.meta.reviewId}\``,
    `- 仓库/分支：\`${report.meta.repoPath}\` · \`${report.meta.branch}\``,
    `- 结论：${blocking ? `❌ 达到阻断阈值（${blockOn}）` : '✅ 未达阻断阈值'}`,
    `- 风险：**${report.meta.reviewScore ?? report.meta.riskScore}/100** · BLOCKER ${counts.BLOCKER} · WARNING ${counts.WARNING} · NIT ${counts.NIT}`,
    `- 模型：${report.meta.model}${report.meta.llmStatus === undefined ? '' : `（${describeLlmStatus(report.meta.llmStatus)}）`}`,
    '',
  ];
  if (shown.length === 0) {
    lines.push('未发现需要处理的问题。');
  } else {
    lines.push('| 严重度 | 位置 | 问题 | 置信度 |', '| --- | --- | --- | --- |');
    for (const finding of shown) lines.push(renderFinding(finding));
    if (issues.length > shown.length) {
      lines.push('', `其余 ${issues.length - shown.length} 条见完整报告。`);
    }
  }
  lines.push('', `<sub>ReviewFlow · token ${report.meta.tokenUsed} · ${report.meta.durationMs}ms</sub>`);
  return lines.join('\n');
}
