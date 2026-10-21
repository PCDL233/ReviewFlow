import { describeLlmStatus } from '@ai-review/shared';
import type { Finding, ReviewReport } from '@ai-review/shared';

function renderFinding(finding: Finding): string {
  const suggestion = finding.suggestion === undefined ? '' : `\n建议：${finding.suggestion}`;
  return `| ${finding.severity} | ${finding.filePath}:${finding.lineStart} | ${finding.title} | ${finding.confidence.toFixed(2)} | ${finding.description}${suggestion} |`;
}

/**
 * 将类型化报告渲染为五段式 Markdown。
 * @param report 报告数据源
 * @returns Markdown 报告文本
 */
export function renderMarkdown(report: ReviewReport): string {
  const findings =
    report.findings.length === 0
      ? '| - | - | No findings | - | The reviewed changes passed the configured checks. |'
      : report.findings.map(renderFinding).join('\n');
  const degraded =
    report.degradedToStatic.length === 0
      ? ''
      : `\n\n预算受限，以下文件降级为静态分析：${report.degradedToStatic.join(', ')}`;
  return [
    '# 代码审查报告',
    '',
    '## 元信息',
    `- 审查 ID: ${report.meta.reviewId}`,
    `- 模型: ${report.meta.model}`,
    `- 模式: ${report.meta.mode}`,
    `- 风险评分: ${report.meta.riskScore}/100`,
    ...(report.meta.reviewScore === undefined
      ? []
      : [`- 审查结论分: ${report.meta.reviewScore}/100`]),
    ...(report.meta.changeRiskScore === undefined
      ? []
      : [`- 变更风险分: ${report.meta.changeRiskScore}/100`]),
    ...(report.meta.llmStatus === undefined
      ? []
      : [`- 模型状态: ${describeLlmStatus(report.meta.llmStatus)}`]),
    ...(report.meta.dimensions === undefined
      ? []
      : [`- 审查维度: ${report.meta.dimensions.join('、') || '未启用'}`]),
    ...(report.meta.cacheHits === undefined ? [] : [`- 缓存命中: ${report.meta.cacheHits} 个文件`]),
    `- Token: ${report.meta.tokenUsed}`,
    '',
    '## 1. 变更概述',
    report.summary,
    '',
    '## 2. 发现的问题',
    '| 严重度 | 文件:行号 | 标题 | 置信度 | 描述 |',
    '|--------|-----------|------|--------|------|',
    findings,
    '',
    '## 3. 代码质量考量',
    ...report.qualityNotes.map((note) => `- ${note}`),
    '',
    '## 4. 改进建议',
    ...report.suggestions.map((suggestion) => `- ${suggestion}`),
    '',
    '## 5. 总体评估',
    report.assessment,
    degraded,
  ].join('\n');
}

/**
 * 将类型化报告序列化为稳定 JSON。
 * @param report 报告数据源
 * @returns JSON 报告文本
 */
export function renderJson(report: ReviewReport): string {
  return JSON.stringify(report, null, 2);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}

/** 将类型化报告渲染为可离线打开的单文件 HTML，供 Dashboard 导出。 */
export function renderHtml(report: ReviewReport): string {
  const findings =
    report.findings.length === 0
      ? '<tr><td colspan="5" class="empty">未发现需要处理的问题</td></tr>'
      : report.findings
          .map(
            (finding) =>
              `<tr><td><span class="severity severity-${finding.severity.toLowerCase()}">${escapeHtml(finding.severity)}</span></td><td><code>${escapeHtml(`${finding.filePath}:${finding.lineStart}`)}</code></td><td><strong>${escapeHtml(finding.title)}</strong><br><span class="muted">${escapeHtml(finding.description)}</span>${finding.suggestion === undefined ? '' : `<br><span class="suggestion">建议：${escapeHtml(finding.suggestion)}</span>`}</td><td>${Math.round(finding.confidence * 100)}%</td><td>${escapeHtml(finding.agent)}</td></tr>`,
          )
          .join('');
  const list = (items: readonly string[]): string =>
    items.length === 0
      ? '<p class="muted">暂无</p>'
      : `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>代码审查报告 ${escapeHtml(report.meta.reviewId)}</title><style>body{margin:0;background:#f5f5f5;color:#1f1f1f;font:14px/-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}.wrap{max-width:1100px;margin:0 auto;padding:36px 24px}.panel{background:#fff;border:1px solid #f0f0f0;border-radius:8px;padding:22px;margin:16px 0}h1{margin:0 0 8px;font-size:28px}h2{font-size:18px;margin:0 0 14px}.muted{color:#8c8c8c}.meta{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}.meta div{padding:10px;background:#fafafa;border-radius:4px}.meta b{display:block;margin-bottom:5px;color:#8c8c8c;font-size:12px}table{width:100%;border-collapse:collapse}th,td{padding:11px 10px;border-bottom:1px solid #f0f0f0;text-align:left;vertical-align:top}th{background:#fafafa;color:#595959;font-weight:600}.severity{display:inline-block;padding:2px 7px;border-radius:4px;font-size:12px}.severity-blocker{color:#cf1322;background:#fff1f0}.severity-warning{color:#d46b08;background:#fff7e6}.severity-nit{color:#0958d9;background:#e6f4ff}.severity-praise{color:#389e0d;background:#f6ffed}.suggestion{color:#d48806}.empty{text-align:center;color:#8c8c8c;padding:24px}li{margin:7px 0;line-height:1.6}@media(max-width:700px){.meta{grid-template-columns:1fr}table{display:block;overflow:auto;white-space:nowrap}}</style></head><body><main class="wrap"><h1>代码审查报告</h1><p class="muted">${escapeHtml(report.meta.reviewId)} · ${escapeHtml(report.meta.repoPath)}</p><section class="panel"><h2>元信息</h2><div class="meta"><div><b>分支</b>${escapeHtml(report.meta.branch)}</div><div><b>模式</b>${escapeHtml(report.meta.mode.toUpperCase())}</div><div><b>模型</b>${escapeHtml(report.meta.model)}</div><div><b>风险评分</b>${report.meta.riskScore}/100</div>${report.meta.llmStatus === undefined ? '' : `<div><b>模型状态</b>${escapeHtml(describeLlmStatus(report.meta.llmStatus))}</div>`}<div><b>耗时</b>${(report.meta.durationMs / 1000).toFixed(1)}s</div><div><b>Token</b>${report.meta.tokenUsed}</div></div></section><section class="panel"><h2>1. 变更概述</h2><p>${escapeHtml(report.summary)}</p></section><section class="panel"><h2>2. 发现的问题</h2><table><thead><tr><th>严重度</th><th>位置</th><th>问题与建议</th><th>置信度</th><th>来源</th></tr></thead><tbody>${findings}</tbody></table></section><section class="panel"><h2>3. 代码质量考量</h2>${list(report.qualityNotes)}</section><section class="panel"><h2>4. 改进建议</h2>${list(report.suggestions)}</section><section class="panel"><h2>5. 总体评估</h2><p>${escapeHtml(report.assessment)}</p></section></main></body></html>`;
}
