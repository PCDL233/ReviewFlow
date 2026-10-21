import type { CodeContext, CustomRule, Finding } from '@ai-review/shared';
import { describe, expect, it } from 'vitest';
import { buildDefaultRegistry, resolveEnabledTools, ToolRegistry } from '../src/index.js';

function makeContext(paths: string[]): CodeContext {
  return {
    files: paths.map((path) => ({
      diff: {
        path,
        oldPath: null,
        binary: false,
        additions: 1,
        deletions: 0,
        hunks: [],
        changedLines: [{ type: 'added', oldLineNo: null, newLineNo: 1, content: 'x' }],
        removedLines: [],
        summary: 'x',
      },
      stagedContent: 'x',
      snippet: 'x',
      signature: null,
      ragHits: [],
      changeType: 'feature',
    })),
    metadata: {
      totalFiles: paths.length,
      totalAdditions: paths.length,
      totalDeletions: 0,
      languages: [],
      generatedAt: new Date().toISOString(),
    },
  };
}

const noopTool = {
  name: 'noop',
  description: 'does nothing',
  run: (): Finding[] => [],
};

describe('ToolRegistry', () => {
  it('runs all registered tools and merges findings', () => {
    const registry = new ToolRegistry();
    registry.register(noopTool);
    registry.register({
      name: 'flag-all',
      description: 'flags one finding',
      run: (context) =>
        context.files.map((file): Finding => ({
          agent: 'static',
          severity: 'NIT',
          confidence: 0.9,
          filePath: file.diff.path,
          lineStart: 1,
          lineEnd: 1,
          title: 'flagged',
          description: 'flagged by tool',
          isFalsePositive: false,
        })),
    });
    const context = makeContext(['a.ts']);
    expect(registry.runAll(context)).toHaveLength(1);
  });

  it('honors the enabled tool list and ignores unknown names', () => {
    const registry = buildDefaultRegistry();
    const context = makeContext(['a.ts']);
    expect(registry.runAll(context, ['secret_scan', 'dependency_scan'])).toEqual([]);
    expect(registry.list()).toEqual([
      'ast_parse',
      'complexity_check',
      'dependency_scan',
      'secret_scan',
    ]);
  });

  it('registers custom_rule_check when enabled rules exist and runs them', () => {
    const rule: CustomRule = {
      name: 'no-todo',
      description: '',
      pattern: 'TODO',
      flags: '',
      severity: 'WARNING',
      message: '',
      suggestion: '',
      filePatterns: [],
      matchScope: ['added'],
      enabled: true,
    };
    const registry = buildDefaultRegistry({ customRules: [rule] });
    expect(registry.list()).toContain('custom_rule_check');
    const context = makeContext(['a.ts']);
    // stagedContent 与 added 行均为 'x'，不命中 TODO
    expect(registry.runAll(context, ['custom_rule_check'])).toEqual([]);
  });
});

describe('resolveEnabledTools', () => {
  const enabledRule: CustomRule = {
    name: 'r',
    description: '',
    pattern: 'x',
    flags: '',
    severity: 'NIT',
    message: '',
    suggestion: '',
    filePatterns: [],
    matchScope: ['added'],
    enabled: true,
  };
  const disabledRule = { ...enabledRule, enabled: false };

  it('auto-appends custom_rule_check when enabled rules exist', () => {
    expect(resolveEnabledTools(['ast_parse'], [enabledRule])).toEqual([
      'ast_parse',
      'custom_rule_check',
    ]);
  });

  it('does not duplicate custom_rule_check when already listed', () => {
    expect(resolveEnabledTools(['custom_rule_check'], [enabledRule])).toEqual([
      'custom_rule_check',
    ]);
  });

  it('does not append when all rules are disabled or none exist', () => {
    expect(resolveEnabledTools(['ast_parse'], [disabledRule])).toEqual(['ast_parse']);
    expect(resolveEnabledTools(['ast_parse'], [])).toEqual(['ast_parse']);
  });
});

describe('ToolRegistry isolation', () => {
  const finding: Finding = {
    agent: 'static',
    severity: 'NIT',
    confidence: 0.9,
    filePath: 'a.ts',
    lineStart: 1,
    lineEnd: 1,
    title: 'good tool finding',
    description: 'from the healthy tool',
    isFalsePositive: false,
  };

  it('keeps other tools running when one tool throws', () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'broken',
      description: 'always throws',
      run: () => {
        throw new Error('boom');
      },
    });
    registry.register({ name: 'good', description: 'healthy', run: () => [finding] });

    const findings = registry.runAll(makeContext(['a.ts']), ['broken', 'good']);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.title).toBe('good tool finding');
    expect(registry.getFailures()).toEqual([{ tool: 'broken', message: 'boom' }]);
  });
});
