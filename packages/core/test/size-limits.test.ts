import { describe, expect, it } from 'vitest';
import type { ReviewPlan, ScoredFile } from '@ai-review/shared';
import { applySizeLimits, resolveReviewDimensions } from '../src/index.js';

function makeFile(path: string, score: number, changed: number): ScoredFile {
  return {
    score,
    diff: {
      path,
      oldPath: null,
      binary: false,
      additions: changed,
      deletions: 0,
      hunks: [],
      changedLines: [],
      removedLines: [],
      summary: '',
    },
  };
}

function makePlan(deep: ScoredFile[], quick: ScoredFile[], staticOnly: ScoredFile[] = []): ReviewPlan {
  return { deep, quick, staticOnly };
}

describe('applySizeLimits', () => {
  it('keeps everything when no limits are configured', () => {
    const plan = makePlan([makeFile('a.ts', 80, 10)], [makeFile('b.ts', 50, 5)]);
    const result = applySizeLimits(plan, undefined, undefined);
    expect(result.truncated).toEqual([]);
    expect(result.plan.deep).toHaveLength(1);
    expect(result.plan.quick).toHaveLength(1);
  });

  it('truncates by file count and demotes the remainder to staticOnly', () => {
    const plan = makePlan(
      [makeFile('a.ts', 90, 10), makeFile('b.ts', 80, 10)],
      [makeFile('c.ts', 50, 10)],
    );
    const result = applySizeLimits(plan, 2, undefined);
    expect(result.truncated).toEqual(['c.ts']);
    expect(result.plan.staticOnly.map((file) => file.diff.path)).toEqual(['c.ts']);
    expect([...result.plan.deep, ...result.plan.quick]).toHaveLength(2);
  });

  it('truncates by changed-line budget', () => {
    const plan = makePlan([makeFile('big.ts', 90, 900)], [makeFile('small.ts', 50, 50)]);
    const result = applySizeLimits(plan, undefined, 500);
    expect(result.truncated).toEqual(['big.ts']);
    expect(result.plan.quick.map((file) => file.diff.path)).toEqual(['small.ts']);
  });

  it('never drops pre-existing staticOnly files', () => {
    const plan = makePlan([makeFile('a.ts', 90, 10)], [], [makeFile('s.ts', 10, 1)]);
    const result = applySizeLimits(plan, 1, undefined);
    expect(result.plan.staticOnly.map((file) => file.diff.path)).toEqual(['s.ts']);
  });
});

describe('resolveReviewDimensions', () => {
  it('falls back to all LLM dimensions when unset', () => {
    expect(resolveReviewDimensions(undefined)).toEqual(['correctness', 'security', 'performance']);
  });

  it('filters out maintainability, which has no LLM agent', () => {
    expect(resolveReviewDimensions(['correctness', 'maintainability'])).toEqual(['correctness']);
  });

  it('falls back to all dimensions when only unsupported ones are configured', () => {
    expect(resolveReviewDimensions(['maintainability'])).toEqual([
      'correctness',
      'security',
      'performance',
    ]);
  });

  it('deduplicates configured dimensions', () => {
    expect(resolveReviewDimensions(['security', 'security'])).toEqual(['security']);
  });
});
