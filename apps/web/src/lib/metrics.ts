/** Prometheus 文本格式解析：只提取指标名、类型、标签、数值与 HELP 说明。 */

export type MetricRow = {
  name: string;
  type: string;
  labels: Record<string, string>;
  value: string;
  help: string;
};

const SAMPLE_PATTERN = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)(?:\s+\S+)?$/;
const VALUE_PATTERN = /^[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|NaN|Inf)$/;
const LABEL_PATTERN = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

function parseLabels(text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const match of text.matchAll(LABEL_PATTERN)) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) labels[key] = value.replace(/\\"/g, '"');
  }
  return labels;
}

/**
 * 解析 Prometheus 暴露的文本指标。
 * 空行、注释行与无法识别的行（如 exemplar）忽略；HELP/TYPE 作用于后续同名指标。
 */
export function parseMetrics(text: string): MetricRow[] {
  const rows: MetricRow[] = [];
  const helpByName = new Map<string, string>();
  const typeByName = new Map<string, string>();

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed.startsWith('# HELP ')) {
      const [name = '', ...rest] = trimmed.slice('# HELP '.length).split(' ');
      helpByName.set(name, rest.join(' '));
      continue;
    }
    if (trimmed.startsWith('# TYPE ')) {
      const [name = '', type = ''] = trimmed.slice('# TYPE '.length).split(' ');
      typeByName.set(name, type);
      continue;
    }
    if (trimmed.startsWith('#')) continue;

    const match = SAMPLE_PATTERN.exec(trimmed);
    if (match === null) continue;
    const value = match[3] ?? '';
    // 数值不合法时视为无法识别的行（例如错误信息被写进了 metrics 输出）
    if (!VALUE_PATTERN.test(value)) continue;
    const name = match[1] ?? '';
    const labels = parseLabels(match[2] ?? '');
    rows.push({
      name,
      type: typeByName.get(name) ?? '',
      labels,
      value,
      help: helpByName.get(name) ?? '',
    });
  }
  return rows;
}

/** 按指标名去重，用于「类型计数摘要」等概览展示。 */
export function summarizeMetrics(rows: readonly MetricRow[]): Map<string, number> {
  const summary = new Map<string, number>();
  for (const row of rows) {
    const key = row.type === '' ? '未标注类型' : row.type;
    summary.set(key, (summary.get(key) ?? 0) + 1);
  }
  return summary;
}
