import type { CodeContext, CustomRule, FileContext } from '@ai-review/shared';
import { describe, expect, it } from 'vitest';
import { compileCustomRulePattern, runCustomRules, testCustomRuleOnSamples } from '../src/index.js';

/** 构造最小 FileContext：changedLines / stagedContent / snippet / signature 供规则引擎 */
function makeFileContext(options: {
  path: string;
  stagedContent?: string;
  snippet?: string;
  signatureStartLine?: number;
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
    stagedContent: options.stagedContent ?? '',
    snippet: options.snippet ?? '',
    signature:
      options.signatureStartLine === undefined
        ? null
        : {
            name: 'example',
            params: [],
            isAsync: false,
            range: {
              startLine: options.signatureStartLine,
              endLine: options.signatureStartLine + 5,
            },
          },
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

function makeRule(overrides: Partial<CustomRule> = {}): CustomRule {
  return {
    name: 'no-todo',
    description: 'Forbid leftover TODO markers.',
    pattern: '\\bTODO\\b',
    flags: '',
    severity: 'WARNING',
    message: '',
    suggestion: '',
    cweId: 'CWE-1177',
    filePatterns: [],
    matchScope: ['added'],
    enabled: true,
    ...overrides,
  };
}

describe('runCustomRules', () => {
  it('matches changed added lines with newLineNo and finding fields', () => {
    const context = makeContext([
      makeFileContext({
        path: 'src/worker.ts',
        addedLines: [
          { content: '// TODO: implement retry', line: 3 },
          { content: 'return result;', line: 4 },
        ],
      }),
    ]);
    const findings = runCustomRules(context.files, [makeRule()]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      agent: 'static',
      severity: 'WARNING',
      confidence: 0.9,
      filePath: 'src/worker.ts',
      lineStart: 3,
      lineEnd: 3,
      title: 'Custom rule matched: no-todo',
      codeSnippet: '// TODO: implement retry',
      cweId: 'CWE-1177',
      isFalsePositive: false,
    });
  });

  it('uses rule message, description and suggestion when provided', () => {
    const rule = makeRule({
      message: '遗留 TODO 标记',
      description: '禁止提交遗留的 TODO。',
      suggestion: '清理 TODO 或创建跟踪任务。',
      severity: 'BLOCKER',
    });
    const context = makeContext([
      makeFileContext({ path: 'src/a.ts', addedLines: [{ content: '// TODO', line: 1 }] }),
    ]);
    const finding = runCustomRules(context.files, [rule])[0];
    expect(finding).toMatchObject({
      title: '遗留 TODO 标记',
      description: '禁止提交遗留的 TODO。',
      suggestion: '清理 TODO 或创建跟踪任务。',
      severity: 'BLOCKER',
    });
  });

  it('matches staged file content with absolute line numbers', () => {
    const rule = makeRule({ matchScope: ['staged'] });
    const context = makeContext([
      makeFileContext({
        path: 'src/config.ts',
        stagedContent: 'export const base = 1;\n// TODO: rotate key\nconsole.log("x");',
      }),
    ]);
    const findings = runCustomRules(context.files, [rule]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ filePath: 'src/config.ts', lineStart: 2, lineEnd: 2 });
  });

  it('matches function snippet with signature startLine offset', () => {
    const rule = makeRule({ matchScope: ['snippet'] });
    const context = makeContext([
      makeFileContext({
        path: 'src/worker.ts',
        signatureStartLine: 10,
        snippet: 'export function work() {\n  // TODO: cleanup\n  return 1;\n}',
      }),
    ]);
    const findings = runCustomRules(context.files, [rule]);
    expect(findings).toHaveLength(1);
    // 片段首行对应文件第 10 行 → TODO 位于第 11 行
    expect(findings[0]).toMatchObject({ lineStart: 11, lineEnd: 11 });
  });

  it('dedupes the same line matched by multiple scopes', () => {
    const rule = makeRule({ matchScope: ['added', 'staged'] });
    const context = makeContext([
      makeFileContext({
        path: 'src/a.ts',
        stagedContent: '// TODO: same line',
        addedLines: [{ content: '// TODO: same line', line: 1 }],
      }),
    ]);
    expect(runCustomRules(context.files, [rule])).toHaveLength(1);
  });

  it('filters files by glob patterns', () => {
    const rule = makeRule({ filePatterns: ['src/**', '*.ts'] });
    const context = makeContext([
      makeFileContext({ path: 'docs/guide.md', addedLines: [{ content: '// TODO', line: 1 }] }),
      makeFileContext({ path: 'src/app.ts', addedLines: [{ content: '// TODO', line: 2 }] }),
    ]);
    const findings = runCustomRules(context.files, [rule]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ filePath: 'src/app.ts' });
  });

  it('skips disabled rules and invalid regex rules without breaking the pipeline', () => {
    const context = makeContext([
      makeFileContext({ path: 'src/a.ts', addedLines: [{ content: '// TODO', line: 1 }] }),
    ]);
    const disabled = makeRule({ name: 'disabled', enabled: false });
    const invalid = makeRule({ name: 'invalid', pattern: '[' });
    const findings = runCustomRules(context.files, [disabled, invalid]);
    expect(findings).toEqual([]);
  });

  it('reports multiple matches on different lines', () => {
    const rule = makeRule({});
    const context = makeContext([
      makeFileContext({
        path: 'src/a.ts',
        addedLines: [
          { content: '// TODO: one', line: 2 },
          { content: '// TODO: two', line: 5 },
        ],
      }),
    ]);
    const findings = runCustomRules(context.files, [rule]);
    expect(findings.map((finding) => finding.lineStart)).toEqual([2, 5]);
  });
});

describe('testCustomRuleOnSamples', () => {
  it('matches added lines from a unified diff text', () => {
    const rule = makeRule({ matchScope: ['added'] });
    const hits = testCustomRuleOnSamples(rule, {
      diffText: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n- old\n+// TODO: new line\n',
      source: '',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ scope: 'added', text: '// TODO: new line' });
  });

  it('matches source text for staged/snippet scopes with 1-based line numbers', () => {
    const rule = makeRule({ matchScope: ['staged'] });
    const hits = testCustomRuleOnSamples(rule, {
      diffText: '',
      source: 'const a = 1;\n// TODO\n',
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ scope: 'staged', line: 2, text: '// TODO' });
  });

  it('returns no hits for an invalid pattern', () => {
    const rule = makeRule({ pattern: '(' });
    expect(compileCustomRulePattern(rule)).toBeNull();
    expect(testCustomRuleOnSamples(rule, { diffText: '// TODO', source: '' })).toEqual([]);
  });

  it('dedupes the same text hit across added and staged scopes (keeps real line)', () => {
    const rule = makeRule({ matchScope: ['added', 'staged'] });
    const hits = testCustomRuleOnSamples(rule, {
      diffText: '+// TODO: shared line\n',
      source: 'const a = 1;\n// TODO: shared line\n',
    });
    expect(hits).toHaveLength(1);
    // 保留 staged 的真实行号而非 added 的占位 0
    expect(hits[0]).toMatchObject({ scope: 'staged', line: 2, text: '// TODO: shared line' });
  });
});

describe('runCustomRules edge cases', () => {
  it('resets lastIndex between files with a global-flag pattern', () => {
    const rule = makeRule({ flags: 'g' });
    const context = makeContext([
      makeFileContext({ path: 'src/a.ts', addedLines: [{ content: '// TODO: a', line: 1 }] }),
      makeFileContext({ path: 'src/b.ts', addedLines: [{ content: '// TODO: b', line: 4 }] }),
    ]);
    const findings = runCustomRules(context.files, [rule]);
    expect(findings.map((finding) => finding.filePath)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(findings.map((finding) => finding.lineStart)).toEqual([1, 4]);
  });

  it('handles CRLF line endings in staged content', () => {
    const rule = makeRule({ matchScope: ['staged'] });
    const context = makeContext([
      makeFileContext({
        path: 'src/win.ts',
        stagedContent: 'const a = 1;\r\n// TODO: crlf\r\n',
      }),
    ]);
    const findings = runCustomRules(context.files, [rule]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ lineStart: 2, lineEnd: 2 });
    expect(findings[0]?.codeSnippet).toBe('// TODO: crlf');
  });

  it('ignores an empty matchScope without crashing', () => {
    const rule = makeRule({ matchScope: [] });
    const context = makeContext([
      makeFileContext({ path: 'src/a.ts', addedLines: [{ content: '// TODO', line: 1 }] }),
    ]);
    expect(runCustomRules(context.files, [rule])).toEqual([]);
  });

  it('does not match removed lines in the added scope', () => {
    const rule = makeRule({ matchScope: ['added'] });
    const context = makeContext([
      makeFileContext({ path: 'src/a.ts', addedLines: [{ content: 'keep me', line: 1 }] }),
    ]);
    context.files[0]?.diff.changedLines.push({
      type: 'removed',
      oldLineNo: 9,
      newLineNo: null,
      content: '// TODO: removed line',
    });
    expect(runCustomRules(context.files, [rule])).toEqual([]);
  });

  it('reports relative line numbers when snippet has no AST signature', () => {
    const rule = makeRule({ matchScope: ['snippet'] });
    const context = makeContext([
      makeFileContext({
        path: 'src/legacy.ts',
        snippet: 'function legacy() {\n  // TODO: relative\n}',
      }),
    ]);
    const findings = runCustomRules(context.files, [rule]);
    expect(findings).toHaveLength(1);
    // 无签名时以片段起始为第 1 行：TODO 位于片段第 2 行
    expect(findings[0]).toMatchObject({ lineStart: 2, lineEnd: 2 });
  });
});

describe('custom rule safety', () => {
  it('rejects catastrophic backtracking patterns instead of blocking the process', () => {
    expect(compileCustomRulePattern(makeRule({ pattern: '(a+)+$' }))).toBeNull();
    expect(compileCustomRulePattern(makeRule({ pattern: '(.*)*' }))).toBeNull();
    // 正常分组量词不受影响
    expect(compileCustomRulePattern(makeRule({ pattern: '(TODO|FIXME)' }))).not.toBeNull();
  });
});
