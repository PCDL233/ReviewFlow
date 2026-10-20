import { describe, expect, it } from 'vitest';
import { parseMetrics, summarizeMetrics } from '../src/lib/metrics';

const SAMPLE = [
  '# HELP ai_review_reviews_total Total number of reviews',
  '# TYPE ai_review_reviews_total counter',
  'ai_review_reviews_total 12',
  '',
  '# HELP ai_review_findings_total Total findings by severity',
  '# TYPE ai_review_findings_total counter',
  'ai_review_findings_total{severity="BLOCKER"} 3',
  'ai_review_findings_total{severity="WARNING"} 5',
  '# TYPE ai_review_risk_score gauge',
  'ai_review_risk_score{repo="a b"} 42.5',
  'not a valid metric line',
  '# random comment',
  '',
].join('\n');

describe('parseMetrics', () => {
  it('parses samples with type and help metadata', () => {
    const rows = parseMetrics(SAMPLE);
    expect(rows).toHaveLength(4);

    expect(rows[0]).toMatchObject({
      name: 'ai_review_reviews_total',
      type: 'counter',
      value: '12',
      help: 'Total number of reviews',
      labels: {},
    });
    expect(rows[1]).toMatchObject({
      name: 'ai_review_findings_total',
      labels: { severity: 'BLOCKER' },
      value: '3',
    });
    expect(rows[2]).toMatchObject({
      labels: { severity: 'WARNING' },
      value: '5',
    });
    expect(rows[3]).toMatchObject({
      name: 'ai_review_risk_score',
      type: 'gauge',
      labels: { repo: 'a b' },
      value: '42.5',
    });
  });

  it('skips comments, blank lines and unparsable content', () => {
    const rows = parseMetrics(SAMPLE);
    expect(rows.some((row) => row.name === 'not')).toBe(false);
    expect(rows.every((row) => row.name !== '')).toBe(true);
  });

  it('returns an empty array for empty input', () => {
    expect(parseMetrics('')).toEqual([]);
    expect(parseMetrics('\n\n')).toEqual([]);
  });

  it('handles multiple labels and escaped quotes', () => {
    const rows = parseMetrics('metric{a="1",b="x\\"y"} 7');
    expect(rows[0]?.labels).toEqual({ a: '1', b: 'x"y' });
    expect(rows[0]?.value).toBe('7');
  });
});

describe('summarizeMetrics', () => {
  it('counts samples per type', () => {
    const summary = summarizeMetrics(parseMetrics(SAMPLE));
    expect(summary.get('counter')).toBe(3);
    expect(summary.get('gauge')).toBe(1);
  });

  it('buckets samples without a type', () => {
    const summary = summarizeMetrics(parseMetrics('unknown_metric 1'));
    expect(summary.get('未标注类型')).toBe(1);
  });
});
