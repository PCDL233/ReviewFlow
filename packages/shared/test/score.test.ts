import { describe, expect, it } from 'vitest';
import {
  computeReviewScore,
  ensureFindingFingerprint,
  fingerprintFinding,
  normalizeFindingTitle,
} from '../src/index.js';
import type { Finding } from '../src/index.js';

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    agent: 'security',
    severity: 'WARNING',
    confidence: 0.8,
    filePath: 'src/auth/login.ts',
    lineStart: 10,
    lineEnd: 10,
    title: 'Missing authorization check',
    description: 'detail',
    isFalsePositive: false,
    ...overrides,
  };
}

describe('computeReviewScore', () => {
  it('returns 0 when there is nothing to report', () => {
    expect(computeReviewScore([])).toBe(0);
  });

  it('grows with severity and confidence', () => {
    const nit = computeReviewScore([makeFinding({ severity: 'NIT', confidence: 0.4 })]);
    const warning = computeReviewScore([makeFinding({ severity: 'WARNING', confidence: 0.9 })]);
    expect(warning).toBeGreaterThan(nit);
  });

  it('floors the score at 70 when there is a changed-line BLOCKER', () => {
    const score = computeReviewScore([
      makeFinding({ severity: 'BLOCKER', confidence: 0.3, lineScope: 'changed' }),
    ]);
    expect(score).toBeGreaterThanOrEqual(70);
  });

  it('does not treat context-only blockers as blocking and applies a discount', () => {
    const changed = computeReviewScore([
      makeFinding({ severity: 'WARNING', confidence: 0.8, lineStart: 10 }),
    ]);
    const context = computeReviewScore([
      makeFinding({
        severity: 'WARNING',
        confidence: 0.8,
        lineStart: 10,
        lineScope: 'context',
      }),
    ]);
    const contextBlocker = computeReviewScore([
      makeFinding({ severity: 'BLOCKER', confidence: 0.8, lineScope: 'context' }),
    ]);
    expect(context).toBeLessThan(changed);
    expect(contextBlocker).toBeLessThan(70);
  });

  it('ignores false positives and ignored findings', () => {
    expect(computeReviewScore([makeFinding({ isFalsePositive: true })])).toBe(0);
    expect(computeReviewScore([makeFinding({ status: 'ignored' })])).toBe(0);
  });
});

describe('fingerprintFinding', () => {
  it('is stable across agents and title punctuation/case', () => {
    const base = fingerprintFinding({
      filePath: 'src/auth/login.ts',
      title: 'Missing Authorization Check!',
      lineStart: 10,
      lineEnd: 10,
      agent: 'security',
    });
    const otherAgent = fingerprintFinding({
      filePath: 'src\\auth\\login.ts',
      title: 'missing authorization check',
      lineStart: 10,
      lineEnd: 10,
      agent: 'correctness',
    });
    expect(otherAgent).toBe(base);
    expect(normalizeFindingTitle('Missing Authorization Check!')).toBe(
      'missing authorization check',
    );
  });

  it('changes when the location changes', () => {
    const first = fingerprintFinding({
      filePath: 'src/auth/login.ts',
      title: 'missing check',
      lineStart: 10,
      lineEnd: 10,
      agent: 'security',
    });
    const second = fingerprintFinding({
      filePath: 'src/auth/login.ts',
      title: 'missing check',
      lineStart: 11,
      lineEnd: 11,
      agent: 'security',
    });
    expect(second).not.toBe(first);
  });

  it('fills a missing fingerprint exactly once', () => {
    const finding = makeFinding();
    const withPrint = ensureFindingFingerprint(finding);
    expect(withPrint.fingerprint).toHaveLength(32);
    expect(ensureFindingFingerprint(withPrint)).toBe(withPrint);
  });
});
