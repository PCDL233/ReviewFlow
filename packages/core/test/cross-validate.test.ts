import type { CodeContext, Finding, FileContext } from '@ai-review/shared';
import { describe, expect, it } from 'vitest';
import {
  crossValidate,
  dedupeFindings,
  reclassifySeverity,
  scoreConfidence,
  sortFindings,
} from '../src/index.js';

function makeFinding(overrides: Partial<Finding> & { title: string }): Finding {
  return {
    agent: 'security',
    severity: 'WARNING',
    confidence: 0.8,
    filePath: 'src/login.ts',
    lineStart: 3,
    lineEnd: 3,
    title: overrides.title,
    description: 'problem',
    isFalsePositive: false,
    ...overrides,
  };
}

const featureContext: CodeContext = {
  files: [],
  metadata: { totalFiles: 0, totalAdditions: 0, totalDeletions: 0, languages: [], generatedAt: '' },
};

const testFileContext: FileContext = {
  diff: {
    path: 'test/login.test.ts',
    oldPath: null,
    binary: false,
    additions: 1,
    deletions: 0,
    hunks: [],
    changedLines: [],
    removedLines: [],
    summary: '',
  },
  stagedContent: '',
  snippet: '',
  signature: null,
  ragHits: [],
  changeType: 'test',
};

const testContext: CodeContext = { files: [testFileContext], metadata: featureContext.metadata };

describe('reclassifySeverity', () => {
  it('downgrades high severities inside test or docs files', () => {
    const findings = [
      makeFinding({
        title: 'hardcoded value',
        severity: 'BLOCKER',
        filePath: 'test/login.test.ts',
      }),
    ];
    const reclassified = reclassifySeverity(findings, testContext);
    expect(reclassified[0]?.severity).toBe('NIT');
    expect(reclassified[0]?.title).toBe('hardcoded value');
  });

  it('leaves findings in regular files untouched', () => {
    const findings = [makeFinding({ title: 'sql injection', severity: 'BLOCKER' })];
    expect(reclassifySeverity(findings, featureContext)[0]?.severity).toBe('BLOCKER');
  });
});

describe('scoreConfidence', () => {
  it('caps LLM findings at 0.6 and keeps lower provider confidence', () => {
    const findings = [
      makeFinding({ title: 'a', confidence: 0.9 }),
      makeFinding({ title: 'b', confidence: 0.4 }),
    ];
    const scored = scoreConfidence(findings);
    expect(scored[0]?.confidence).toBe(0.6);
    expect(scored[1]?.confidence).toBe(0.4);
  });

  it('gives static findings 0.9 and raises cross-confirmed findings by 0.2', () => {
    // 两发现同文件且行区间重叠 → 互为交叉确认
    const staticFinding = makeFinding({ title: 'secret', agent: 'static', confidence: 0.9 });
    const llmFinding = makeFinding({ title: 'suspicious token', agent: 'security' });
    const scored = scoreConfidence([staticFinding, llmFinding]);
    expect(scored[0]?.confidence).toBe(1);
    expect(scored[1]?.confidence).toBe(0.8);
  });
});

describe('dedupeFindings', () => {
  it('keeps the higher-confidence version of an overlapping duplicate', () => {
    const raw = makeFinding({ title: 'unsafe eval', severity: 'BLOCKER', confidence: 0.4 });
    const corrected = makeFinding({ title: 'unsafe eval', severity: 'NIT', confidence: 0.6 });
    const deduped = dedupeFindings([raw, corrected]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]).toMatchObject({ title: 'unsafe eval', severity: 'NIT', confidence: 0.6 });
    expect(deduped[0]?.fingerprint).toHaveLength(32);
  });

  it('keeps disjoint findings with the same title on different lines', () => {
    const first = makeFinding({ title: 'hardcoded credential', lineStart: 2, lineEnd: 2 });
    const second = makeFinding({ title: 'hardcoded credential', lineStart: 30, lineEnd: 30 });
    expect(dedupeFindings([first, second])).toHaveLength(2);
  });

  it('merges the same defect found by different agent dimensions and records all agents', () => {
    const llm = makeFinding({ title: 'injection', agent: 'security', confidence: 0.7 });
    const staticFinding = makeFinding({ title: 'injection', agent: 'static', confidence: 0.9 });
    const deduped = dedupeFindings([llm, staticFinding]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.agents?.sort()).toEqual(['security', 'static']);
    expect(deduped[0]?.confidence).toBe(0.9);
  });
});

describe('sortFindings', () => {
  it('orders by severity then confidence deterministically', () => {
    const sorted = sortFindings([
      makeFinding({ title: 'nit', severity: 'NIT', filePath: 'a.ts' }),
      makeFinding({ title: 'warning-low', confidence: 0.5, filePath: 'b.ts' }),
      makeFinding({ title: 'warning-high', confidence: 0.9, filePath: 'c.ts' }),
      makeFinding({ title: 'blocker', severity: 'BLOCKER', filePath: 'd.ts' }),
    ]);
    expect(sorted.map((f) => f.title)).toEqual(['blocker', 'warning-high', 'warning-low', 'nit']);
  });
});

describe('crossValidate', () => {
  it('composes reclassification, confidence scoring, dedupe, and sorting', () => {
    const findings = [
      makeFinding({
        title: 'test blocker',
        severity: 'BLOCKER',
        confidence: 0.4,
        filePath: 'test/login.test.ts',
      }),
      makeFinding({ title: 'dup', agent: 'security', confidence: 0.8 }),
      makeFinding({ title: 'dup', agent: 'security', confidence: 0.6 }),
    ];
    const validated = crossValidate(findings, testContext);
    expect(validated).toHaveLength(2);
    expect(validated[0]).toMatchObject({ title: 'dup', confidence: 0.6 });
    expect(validated[1]).toMatchObject({ title: 'test blocker', severity: 'NIT' });
  });
});
