import { describe, expect, it } from 'vitest';
import { buildPrintHtml } from '../src/lib/report-export';

const SAMPLE = '<!doctype html><html><head><title>报告</title></head><body><main>x</main></body></html>';

describe('buildPrintHtml', () => {
  it('把打印样式注入到 </head> 之前', () => {
    const result = buildPrintHtml(SAMPLE);
    expect(result.indexOf('@media print')).toBeGreaterThan(-1);
    expect(result.indexOf('@media print')).toBeLessThan(result.indexOf('</head>'));
  });

  it('保留原始报告正文不变', () => {
    const result = buildPrintHtml(SAMPLE);
    expect(result).toContain('<title>报告</title>');
    expect(result).toContain('<main>x</main>');
  });

  it('缺少 </head> 时退化为前置样式，不丢正文', () => {
    const html = '<body>only body</body>';
    const result = buildPrintHtml(html);
    expect(result.startsWith('<style>')).toBe(true);
    expect(result).toContain(html);
  });

  it('只注入一次打印样式', () => {
    const result = buildPrintHtml(SAMPLE);
    expect(result.match(/@media print/g)?.length).toBe(1);
  });
});
