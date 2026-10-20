import { describe, expect, it } from 'vitest';
import {
  formatDateTime,
  formatDuration,
  formatLocalDate,
  formatNumber,
  formatRelativeTime,
  getDateRange,
} from '../src/format';

describe('formatLocalDate', () => {
  it('uses local calendar parts instead of UTC', () => {
    // 2024-03-05T23:30:00+08:00 的 UTC 日期是 03-05，但仍需以本地日期为准
    const date = new Date(2024, 2, 5, 23, 30);
    expect(formatLocalDate(date)).toBe('2024-03-05');
  });

  it('pads month and day', () => {
    expect(formatLocalDate(new Date(2024, 0, 1))).toBe('2024-01-01');
  });
});

describe('getDateRange', () => {
  const now = new Date(2024, 2, 15, 9, 0);

  it('returns an inclusive 7-day window ending today', () => {
    expect(getDateRange('7d', now)).toEqual({ from: '2024-03-09', to: '2024-03-15' });
  });

  it('returns an inclusive 30-day window', () => {
    expect(getDateRange('30d', now)).toEqual({ from: '2024-02-15', to: '2024-03-15' });
  });

  it('returns no bounds for the all range', () => {
    expect(getDateRange('all', now)).toEqual({});
  });

  it('keeps from <= to across month boundaries', () => {
    const range = getDateRange('7d', new Date(2024, 0, 3));
    expect(range.from).toBe('2023-12-28');
    expect(range.to).toBe('2024-01-03');
    expect((range.from ?? '') <= (range.to ?? '')).toBe(true);
  });
});

describe('formatDuration', () => {
  it('formats sub-second durations in milliseconds', () => {
    expect(formatDuration(0)).toBe('1ms');
    expect(formatDuration(320)).toBe('320ms');
  });

  it('formats seconds and minutes', () => {
    expect(formatDuration(1520)).toBe('1.5s');
    expect(formatDuration(72_000)).toBe('1m 12s');
  });

  it('returns a dash for invalid values', () => {
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
});

describe('formatNumber', () => {
  it('adds thousand separators', () => {
    expect(formatNumber(1234567)).toBe('1,234,567');
  });

  it('handles non-finite input', () => {
    expect(formatNumber(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatDateTime', () => {
  it('formats local time with minutes', () => {
    expect(formatDateTime(new Date(2024, 4, 6, 7, 8).toISOString())).toBe('2024-05-06 07:08');
  });

  it('returns a dash for empty or invalid values', () => {
    expect(formatDateTime(null)).toBe('—');
    expect(formatDateTime('')).toBe('—');
    expect(formatDateTime('not-a-date')).toBe('—');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date(2024, 4, 6, 12, 0).getTime();

  it('describes recent timestamps', () => {
    expect(formatRelativeTime(new Date(now - 30_000).toISOString(), now)).toBe('刚刚');
    expect(formatRelativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe('5 分钟前');
    expect(formatRelativeTime(new Date(now - 3 * 3_600_000).toISOString(), now)).toBe('3 小时前');
    expect(formatRelativeTime(new Date(now - 2 * 86_400_000).toISOString(), now)).toBe('2 天前');
  });

  it('falls back to absolute time for older timestamps and future values', () => {
    const old = new Date(now - 30 * 86_400_000).toISOString();
    expect(formatRelativeTime(old, now)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatRelativeTime(new Date(now + 60_000).toISOString(), now)).toMatch(/^\d{4}-/);
  });

  it('returns a dash for invalid input', () => {
    expect(formatRelativeTime(undefined, now)).toBe('—');
    expect(formatRelativeTime('bad', now)).toBe('—');
  });
});
