/**
 * 格式化 ISO 时间字符串为 `yyyy-MM-dd HH:mm`（本地时区）。
 * @returns 非法/空输入返回 '—'
 */
export function formatDateTime(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const MM = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const HH = pad(date.getHours());
  const mm = pad(date.getMinutes());
  return `${yyyy}-${MM}-${dd} ${HH}:${mm}`;
}

/** 千分位数字，用于 Token、发现数等大数值。 */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('zh-CN').format(value);
}

/** 审查耗时：<1s 用毫秒，<1min 用秒，更长用分秒。 */
export function formatDuration(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  if (milliseconds < 1000) return `${Math.max(1, Math.round(milliseconds))}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  const minutes = Math.floor(milliseconds / 60_000);
  const seconds = Math.round((milliseconds % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** 本地时区的 `YYYY-MM-DD`（不要用 toISOString，东八区会偏移一天）。 */
export function formatLocalDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export type DateRangeKey = '7d' | '30d' | 'all';

/**
 * 统计页的时间范围：按本地日历日回溯，返回闭区间起止日期。
 * `all` 不传日期；始终保证 from <= to。
 */
export function getDateRange(
  key: DateRangeKey,
  now: Date = new Date(),
): { from?: string; to?: string } {
  if (key === 'all') return {};
  const days = key === '7d' ? 6 : 29;
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const fromText = formatLocalDate(from);
  const toText = formatLocalDate(to);
  return fromText <= toText ? { from: fromText, to: toText } : { from: toText, to: fromText };
}

/** 相对时间：用于最近审查、最后登录与索引时间。 */
export function formatRelativeTime(value: string | null | undefined, now = Date.now()): string {
  if (value === null || value === undefined || value === '') return '—';
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return '—';
  const diff = now - timestamp;
  if (diff < 0) return formatDateTime(value);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDateTime(value);
}
