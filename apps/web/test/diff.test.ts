import { describe, expect, it } from 'vitest';
import { diffStats, isLineInRanges, normalizeDiffPath, parseUnifiedDiff } from '../src/lib/diff';

const MULTI_FILE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' export { a };',
  'diff --git a/src/b.ts b/src/b.ts',
  '--- a/src/b.ts',
  '+++ b/src/b.ts',
  '@@ -10,2 +10,2 @@ function x() {',
  '-  return 1;',
  '+  return 2;',
  ' }',
].join('\n');

describe('parseUnifiedDiff', () => {
  it('parses multiple files with correct hunk line numbers', () => {
    const files = parseUnifiedDiff(MULTI_FILE_DIFF);
    expect(files).toHaveLength(2);

    const [first, second] = files;
    expect(first?.path).toBe('src/a.ts');
    expect(first?.additions).toBe(2);
    expect(first?.deletions).toBe(1);
    expect(first?.hunks).toHaveLength(1);

    const lines = first?.hunks[0]?.lines ?? [];
    expect(lines.map((line) => line.kind)).toEqual(['context', 'remove', 'add', 'add', 'context']);
    expect(lines[0]).toMatchObject({ oldLine: 1, newLine: 1 });
    expect(lines[1]).toMatchObject({ oldLine: 2, newLine: null });
    expect(lines[2]).toMatchObject({ oldLine: null, newLine: 2 });
    expect(lines[3]).toMatchObject({ oldLine: null, newLine: 3 });
    expect(lines[4]).toMatchObject({ oldLine: 3, newLine: 4 });

    expect(second?.path).toBe('src/b.ts');
    expect(second?.hunks[0]?.oldStart).toBe(10);
    expect(second?.hunks[0]?.newStart).toBe(10);
  });

  it('marks new and deleted files from /dev/null', () => {
    const diff = [
      'diff --git a/new.ts b/new.ts',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,1 @@',
      '+const x = 1;',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file?.isNew).toBe(true);
    expect(file?.path).toBe('new.ts');
    expect(file?.additions).toBe(1);
  });

  it('flags binary diffs', () => {
    const diff = [
      'diff --git a/logo.png b/logo.png',
      '--- a/logo.png',
      '+++ b/logo.png',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    expect(file?.isBinary).toBe(true);
    expect(file?.hunks).toHaveLength(0);
  });

  it('returns an empty array for empty or null input', () => {
    expect(parseUnifiedDiff('')).toEqual([]);
    expect(parseUnifiedDiff(null)).toEqual([]);
    expect(parseUnifiedDiff(undefined)).toEqual([]);
    expect(parseUnifiedDiff('   \n ')).toEqual([]);
  });

  it('ignores the no-newline marker without breaking line tracking', () => {
    const diff = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,1 +1,1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    ].join('\n');
    const [file] = parseUnifiedDiff(diff);
    const lines = file?.hunks[0]?.lines ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ kind: 'add', newLine: 1 });
  });

  it('normalizes a/ b/ prefixes and windows separators', () => {
    expect(normalizeDiffPath('b/src/app.ts')).toBe('src/app.ts');
    expect(normalizeDiffPath('"a/src/app.ts"')).toBe('src/app.ts');
    expect(normalizeDiffPath('src\\app.ts')).toBe('src/app.ts');
  });

  it('aggregates additions and deletions', () => {
    expect(diffStats(parseUnifiedDiff(MULTI_FILE_DIFF))).toEqual({ additions: 3, deletions: 2 });
  });
});

describe('isLineInRanges', () => {
  const ranges = [
    { start: 3, end: 5 },
    { start: 10, end: 10 },
  ];

  it('matches inclusive ranges', () => {
    expect(isLineInRanges(3, ranges)).toBe(true);
    expect(isLineInRanges(5, ranges)).toBe(true);
    expect(isLineInRanges(10, ranges)).toBe(true);
  });

  it('rejects lines outside ranges', () => {
    expect(isLineInRanges(2, ranges)).toBe(false);
    expect(isLineInRanges(6, ranges)).toBe(false);
    expect(isLineInRanges(9, ranges)).toBe(false);
    expect(isLineInRanges(4, [])).toBe(false);
  });
});
