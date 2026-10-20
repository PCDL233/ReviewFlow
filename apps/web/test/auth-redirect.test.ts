import { describe, expect, it } from 'vitest';
import { safeRedirectTarget } from '../src/lib/redirect';

describe('safeRedirectTarget', () => {
  it('accepts same-site absolute paths', () => {
    expect(safeRedirectTarget('/reviews')).toBe('/reviews');
    expect(safeRedirectTarget('/reviews?status=failed&page=2')).toBe(
      '/reviews?status=failed&page=2',
    );
    expect(safeRedirectTarget('/admin/users')).toBe('/admin/users');
  });

  it('rejects protocol-relative and backslash escapes', () => {
    expect(safeRedirectTarget('//evil.com')).toBe('/');
    expect(safeRedirectTarget('/\\evil.com')).toBe('/');
    expect(safeRedirectTarget('\\\\evil.com')).toBe('/');
    expect(safeRedirectTarget('/path\\with\\backslash')).toBe('/');
  });

  it('rejects absolute URLs and non-path values', () => {
    expect(safeRedirectTarget('http://evil.com')).toBe('/');
    expect(safeRedirectTarget('https://evil.com/reviews')).toBe('/');
    expect(safeRedirectTarget('javascript:alert(1)')).toBe('/');
    expect(safeRedirectTarget('reviews')).toBe('/');
  });

  it('uses the provided fallback for empty input', () => {
    expect(safeRedirectTarget(undefined, '/run')).toBe('/run');
    expect(safeRedirectTarget('', '/run')).toBe('/run');
    expect(safeRedirectTarget('//evil.com', '/run')).toBe('/run');
  });
});
