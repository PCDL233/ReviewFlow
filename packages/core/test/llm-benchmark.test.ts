import { validateFindings } from '@ai-review/agents';
import { parseFindings } from '@ai-review/llm';
import type { ReviewDimension } from '@ai-review/llm';
import type { CodeContext } from '@ai-review/shared';
import { describe, expect, it } from 'vitest';
import { crossValidate } from '../src/index.js';

/**
 * LLM 输出契约基准（录制回放，零 token）。
 * 断言的是“模型输出 → 解析 → 行号/归属校验 → 跨维归一”这一层的召回与精度，
 * 不度量真实模型能力；真实模型评估应使用录制 fixture 或线上标注数据。
 */

type BenchmarkCase = {
  id: string;
  dimension: ReviewDimension;
  title: string;
  line: number;
  severity: 'BLOCKER' | 'WARNING' | 'NIT';
};

const CASES: readonly BenchmarkCase[] = [
  {
    id: 'security-eval',
    dimension: 'security',
    title: 'Unsafe eval of user input',
    line: 1,
    severity: 'BLOCKER',
  },
  {
    id: 'correctness-off-by-one',
    dimension: 'correctness',
    title: 'Off-by-one in loop bound',
    line: 2,
    severity: 'WARNING',
  },
  {
    id: 'performance-n-plus-one',
    dimension: 'performance',
    title: 'N+1 query inside loop',
    line: 3,
    severity: 'WARNING',
  },
  {
    id: 'security-secret',
    dimension: 'security',
    title: 'Hardcoded credential',
    line: 4,
    severity: 'BLOCKER',
  },
];

const CONTENT = [
  'eval(userInput);',
  'for (let i = 0; i <= items.length; i += 1) {',
  '  await db.query(items[i]);',
  "} const apiKey = 'AKIAIOSFODNN7EXAMPLE';",
].join('\n');

const context: CodeContext = {
  files: [
    {
      diff: {
        path: 'src/bench.ts',
        oldPath: null,
        binary: false,
        additions: 4,
        deletions: 0,
        hunks: [],
        removedLines: [],
        changedLines: CONTENT.split('\n').map((line, index) => ({
          type: 'added' as const,
          oldLineNo: null,
          newLineNo: index + 1,
          content: line,
        })),
        summary: 'benchmark fixture',
      },
      stagedContent: CONTENT,
      snippet: CONTENT,
      signature: null,
      ragHits: [],
      changeType: 'feature',
    },
  ],
  metadata: {
    totalFiles: 1,
    totalAdditions: 4,
    totalDeletions: 0,
    languages: ['typescript'],
    generatedAt: '2026-01-01T00:00:00.000Z',
  },
};

function recordedOutput(benchmarkCase: BenchmarkCase): string {
  return JSON.stringify([
    {
      // 模型自报 static 必须被解析层强制改回维度，避免骗取静态置信度
      agent: 'static',
      severity: benchmarkCase.severity,
      confidence: 0.8,
      filePath: 'src/bench.ts',
      lineStart: benchmarkCase.line,
      lineEnd: benchmarkCase.line,
      title: benchmarkCase.title,
      description: `${benchmarkCase.title} detected in changed code.`,
      suggestion: 'Fix the issue.',
      isFalsePositive: false,
    },
  ]);
}

describe('LLM output contract benchmark (recorded)', () => {
  const merged = CASES.flatMap((benchmarkCase) => {
    const parsed = parseFindings(recordedOutput(benchmarkCase), benchmarkCase.dimension);
    const validated = validateFindings(parsed, context, benchmarkCase.dimension).findings;
    return crossValidate(validated, context);
  });

  it('keeps every recorded defect after line/ownership validation (recall = 1)', () => {
    expect(new Set(merged.map((finding) => finding.title))).toEqual(
      new Set(CASES.map((benchmarkCase) => benchmarkCase.title)),
    );
  });

  it('does not let the model claim the static agent', () => {
    for (const finding of merged) {
      expect(finding.agent).not.toBe('static');
      expect(finding.origin).toBe('llm');
    }
  });

  it('has no duplicate fingerprints after cross-dimension normalization', () => {
    const fingerprints = merged.map((finding) => finding.fingerprint);
    expect(new Set(fingerprints).size).toBe(merged.length);
  });
});
