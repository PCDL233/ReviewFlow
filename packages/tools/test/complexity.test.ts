import type { CodeContext, FileContext } from '@ai-review/shared';
import { describe, expect, it } from 'vitest';
import { analyzeComplexity, complexityFindings } from '../src/index.js';

/** 构造最小 FileContext：stagedContent 供复杂度解析，changedLines 供密钥扫描 */
function makeFileContext(options: {
  path: string;
  stagedContent: string;
  addedLines?: { content: string; line: number }[];
}): FileContext {
  const added = options.addedLines ?? [];
  return {
    diff: {
      path: options.path,
      oldPath: null,
      binary: false,
      additions: added.length,
      deletions: 0,
      hunks: [],
      changedLines: added.map((line) => ({
        type: 'added',
        oldLineNo: null,
        newLineNo: line.line,
        content: line.content,
      })),
      removedLines: [],
      summary: added.map((line) => line.content).join('\n'),
    },
    stagedContent: options.stagedContent,
    snippet: options.stagedContent,
    signature: null,
    ragHits: [],
    changeType: 'feature',
  };
}

function makeContext(files: FileContext[]): CodeContext {
  return {
    files,
    metadata: {
      totalFiles: files.length,
      totalAdditions: files.reduce((total, file) => total + file.diff.additions, 0),
      totalDeletions: 0,
      languages: [],
      generatedAt: new Date().toISOString(),
    },
  };
}

const COMPLEX_SOURCE = `
export function tangled(input: number): number {
  let total = 0;
  for (let i = 0; i < input; i++) {
    if (i > 2 && i < 10) {
      total += i;
    } else if (i % 3 === 0 || i % 5 === 0) {
      while (total > 100) {
        total -= 100;
      }
    }
  }
  switch (input) {
    case 1:
      total += 1;
      break;
    case 2:
      total += 2;
      break;
    case 3:
      total += 3;
      break;
    case 4:
      total += 4;
      break;
    case 5:
      total += 5;
      break;
    case 6:
      total += 6;
      break;
    case 7:
      total += 7;
      break;
    case 8:
      total += 8;
      break;
    case 9:
      total += 9;
      break;
    case 10:
      total += 10;
      break;
  }
  return total ?? 0;
}
`;

describe('analyzeComplexity', () => {
  it('flags functions above the threshold and reports metrics', () => {
    const metrics = analyzeComplexity(COMPLEX_SOURCE, 15);
    expect(metrics).toHaveLength(1);
    const [fn] = metrics;
    expect(fn?.name).toBe('tangled');
    expect(fn?.complexity).toBeGreaterThanOrEqual(15);
    expect(fn?.isAsync).toBe(false);
  });

  it('returns nothing below the threshold', () => {
    expect(analyzeComplexity('const add = (a: number, b: number) => a + b;', 15)).toEqual([]);
  });

  it('tolerates syntax errors without throwing', () => {
    expect(() => analyzeComplexity('function broken( {', 15)).not.toThrow();
  });
});

describe('complexityFindings', () => {
  it('maps metrics to static findings on the function range', () => {
    const context = makeContext([
      makeFileContext({
        path: 'src/tangled.ts',
        stagedContent: COMPLEX_SOURCE,
        addedLines: [{ content: '  if (i % 2 === 0) {', line: 2 }],
      }),
    ]);
    const findings = complexityFindings(context.files, 15);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      agent: 'static',
      severity: 'WARNING',
      filePath: 'src/tangled.ts',
    });
    expect(findings[0]?.confidence).toBeGreaterThan(0.8);
  });

  it('ignores pre-existing complexity outside the changed lines', () => {
    const context = makeContext([
      makeFileContext({
        path: 'src/legacy.ts',
        stagedContent: COMPLEX_SOURCE,
        addedLines: [{ content: 'const untouched = 1;', line: 200 }],
      }),
    ]);
    expect(complexityFindings(context.files, 15)).toEqual([]);
  });

  it('skips deleted files with empty staged content', () => {
    const context = makeContext([makeFileContext({ path: 'src/deleted.ts', stagedContent: '' })]);
    expect(complexityFindings(context.files, 1)).toEqual([]);
  });

  it('detects high-complexity Python/Go/Java functions (approximate)', () => {
    const branches = Array.from({ length: 15 }, (_value, index) => index);
    const python = [
      'def risky(x):',
      ...branches.map((index) => `    if x > ${index}: return ${index}`),
      '    return 0',
    ].join('\n');
    const go = [
      'func risky(x int) int {',
      ...branches.map((index) => `  if x > ${index} { return ${index} }`),
      '  return 0',
      '}',
    ].join('\n');
    const java = [
      'class A {',
      '  int risky(int x) {',
      ...branches.map((index) => `    if (x > ${index}) { return ${index}; }`),
      '    return 0;',
      '  }',
      '}',
    ].join('\n');
    const allLines = (source: string): { content: string; line: number }[] =>
      source.split('\n').map((content, index) => ({ content, line: index + 1 }));
    const findings = complexityFindings(
      [
        makeFileContext({ path: 'src/risky.py', stagedContent: python, addedLines: allLines(python) }),
        makeFileContext({ path: 'src/risky.go', stagedContent: go, addedLines: allLines(go) }),
        makeFileContext({ path: 'src/Risky.java', stagedContent: java, addedLines: allLines(java) }),
      ],
      15,
    );
    expect(findings.map((finding) => finding.filePath).sort()).toEqual([
      'src/Risky.java',
      'src/risky.go',
      'src/risky.py',
    ]);
    for (const finding of findings) {
      expect(finding.title).toContain('cyclomatic complexity 16');
    }
  });
});
