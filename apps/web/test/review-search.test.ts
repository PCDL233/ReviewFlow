import { describe, expect, it } from 'vitest';
import {
  hasActiveFilters,
  pageOf,
  pageSizeOf,
  parseReviewSearch,
  serializeReviewSearch,
  withFilters,
} from '../src/lib/search-params';

describe('parseReviewSearch', () => {
  it('keeps valid filters and drops defaults from the URL shape', () => {
    const parsed = parseReviewSearch({
      q: '  fix login  ',
      status: 'failed',
      mode: 'full',
      severity: 'BLOCKER',
      repo: 'git_review',
      branch: 'main',
    });
    expect(parsed).toEqual({
      q: 'fix login',
      status: 'failed',
      mode: 'full',
      severity: 'BLOCKER',
      repo: 'git_review',
      branch: 'main',
    });
    expect(parsed.page).toBeUndefined();
    expect(parsed.pageSize).toBeUndefined();
    expect(pageOf(parsed)).toBe(1);
    expect(pageSizeOf(parsed)).toBe(20);
  });

  it('ignores invalid enum values and blank strings', () => {
    const parsed = parseReviewSearch({
      q: '   ',
      status: 'unknown',
      mode: 42,
      severity: 'CRITICAL',
      repo: '',
    });
    expect(parsed).toEqual({});
    expect(hasActiveFilters(parsed)).toBe(false);
  });

  it('falls back to defaults for invalid paging', () => {
    expect(pageOf(parseReviewSearch({ page: '0' }))).toBe(1);
    expect(pageOf(parseReviewSearch({ page: '-3' }))).toBe(1);
    expect(pageOf(parseReviewSearch({ page: 'abc' }))).toBe(1);
    expect(pageSizeOf(parseReviewSearch({ pageSize: '999' }))).toBe(20);
    expect(pageOf(parseReviewSearch({ page: '3' }))).toBe(3);
    expect(pageSizeOf(parseReviewSearch({ pageSize: '50' }))).toBe(50);
  });
});

describe('serializeReviewSearch', () => {
  it('omits defaults so URLs stay short', () => {
    expect(serializeReviewSearch({ page: 1, pageSize: 20 })).toEqual({});
  });

  it('round-trips non-default values', () => {
    const search = {
      q: 'security',
      status: 'completed' as const,
      page: 2,
      pageSize: 50,
    };
    const serialized = serializeReviewSearch(search);
    expect(serialized).toEqual(search);
    expect(parseReviewSearch(serialized)).toEqual(search);
  });
});

describe('withFilters', () => {
  it('resets paging when filters change', () => {
    const next = withFilters({ q: 'a', page: 3, pageSize: 50 }, { status: 'failed' });
    expect(next.q).toBe('a');
    expect(next.status).toBe('failed');
    expect(next.page).toBeUndefined();
    expect(next.pageSize).toBe(50);
  });

  it('clears a filter when the patch value is undefined', () => {
    const next = withFilters({ q: 'a', repo: 'r', status: 'failed' }, { q: undefined });
    expect(next.q).toBeUndefined();
    expect(next.repo).toBe('r');
    expect(next.status).toBe('failed');
  });

  it('trims text filters and drops whitespace-only values', () => {
    const next = withFilters({}, { repo: '  repo-a  ', branch: '   ' });
    expect(next.repo).toBe('repo-a');
    expect(next.branch).toBeUndefined();
  });
});

describe('hasActiveFilters', () => {
  it('detects every filter dimension', () => {
    expect(hasActiveFilters({})).toBe(false);
    expect(hasActiveFilters({ q: 'x' })).toBe(true);
    expect(hasActiveFilters({ status: 'failed' })).toBe(true);
    expect(hasActiveFilters({ mode: 'fast' })).toBe(true);
    expect(hasActiveFilters({ severity: 'NIT' })).toBe(true);
    expect(hasActiveFilters({ repo: 'r' })).toBe(true);
    expect(hasActiveFilters({ branch: 'b' })).toBe(true);
  });
});
