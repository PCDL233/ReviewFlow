import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, resolveEnvRefs } from '../src/index';

describe('resolveEnvRefs', () => {
  it('resolves nested env references', () => {
    process.env.AI_REVIEW_TEST_KEY = 'sk-test';
    const input = { llm: { apiKey: '${AI_REVIEW_TEST_KEY}' }, list: ['${AI_REVIEW_TEST_KEY}', 1] };
    expect(resolveEnvRefs(input)).toEqual({
      llm: { apiKey: 'sk-test' },
      list: ['sk-test', 1],
    });
  });

  it('keeps placeholder when env is missing', () => {
    delete process.env.AI_REVIEW_TEST_MISSING;
    expect(resolveEnvRefs('${AI_REVIEW_TEST_MISSING}')).toBe('${AI_REVIEW_TEST_MISSING}');
  });
});

describe('loadConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ai-review-config-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies defaults to a minimal config', () => {
    const path = join(dir, '.ai-review.yml');
    writeFileSync(path, 'llm:\n  provider: mock\n');
    const cfg = loadConfig(path);
    expect(cfg.llm.provider).toBe('mock');
    expect(cfg.llm.temperature).toBe(0.1);
    expect(cfg.review.blockOn).toBe('BLOCKER');
    expect(cfg.staticAnalysis.complexityThreshold).toBe(15);
    expect(cfg.report.format).toBe('markdown');
  });

  it('rejects unknown provider with a field-level error (exit code 2 path)', () => {
    const path = join(dir, '.ai-review.yml');
    writeFileSync(path, 'llm:\n  provider: gemini\n');
    expect(() => loadConfig(path)).toThrow(ConfigError);
    expect(() => loadConfig(path)).toThrow(/llm\.provider/);
  });

  it('accepts domestic providers in the llm provider enum', () => {
    const path = join(dir, '.ai-review.yml');
    writeFileSync(path, 'llm:\n  provider: deepseek\n');
    expect(loadConfig(path).llm.provider).toBe('deepseek');
  });

  it('throws ConfigError for missing file', () => {
    expect(() => loadConfig(join(dir, 'nope.yml'))).toThrow(ConfigError);
  });

  it('resolves ${ENV} refs in apiKey', () => {
    process.env.AI_REVIEW_TEST_KEY = 'sk-live';
    const path = join(dir, '.ai-review.yml');
    writeFileSync(path, 'llm:\n  provider: anthropic\n  apiKey: ${AI_REVIEW_TEST_KEY}\n');
    expect(loadConfig(path).llm.apiKey).toBe('sk-live');
  });

  it('parses custom review rules with defaults', () => {
    const path = join(dir, '.ai-review.yml');
    writeFileSync(
      path,
      [
        'customRules:',
        '  - name: no-todo',
        '    description: Forbid leftover TODO markers.',
        '    pattern: \\bTODO\\b',
        '    flags: i',
        '    severity: WARNING',
        '    filePatterns:',
        '      - src/**',
        '    matchScope:',
        '      - added',
        '      - snippet',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(path);
    expect(cfg.customRules).toHaveLength(1);
    const rule = cfg.customRules[0];
    expect(rule).toMatchObject({
      name: 'no-todo',
      pattern: '\\bTODO\\b',
      flags: 'i',
      severity: 'WARNING',
      message: '',
      enabled: true,
      matchScope: ['added', 'snippet'],
    });
    expect(rule.cweId).toBeUndefined();
    // 默认启用工具集应包含 custom_rule_check
    expect(cfg.staticAnalysis.enabledTools).toContain('custom_rule_check');
  });

  it('rejects custom rules with invalid regex flags', () => {
    const path = join(dir, '.ai-review.yml');
    writeFileSync(path, 'customRules:\n  - name: bad\n    pattern: x\n    flags: z\n');
    expect(() => loadConfig(path)).toThrow(ConfigError);
    expect(() => loadConfig(path)).toThrow(/customRules\.0\.flags/);
  });

  it('parses the server section with defaults', () => {
    const path = join(dir, '.ai-review.yml');
    writeFileSync(path, 'llm:\n  provider: mock\n');
    const cfg = loadConfig(path);
    expect(cfg.server).toEqual({
      allowedRoots: [],
      maxConcurrent: 3,
      cookieSecure: false,
      allowRegister: false,
      trustProxy: false,
      ollamaModel: 'qwen3-coder:30b',
      hookTimeoutMs: 120_000,
      mcpEnabled: false,
    });
  });

  it('parses explicit server settings from yaml', () => {
    const path = join(dir, '.ai-review.yml');
    writeFileSync(
      path,
      [
        'llm:',
        '  provider: mock',
        'server:',
        '  allowedRoots:',
        '    - D:/repos/a',
        '    - D:/repos/b',
        '  maxConcurrent: 5',
        '  cookieSecure: true',
        '  allowRegister: true',
        '  trustProxy: true',
        '  ollamaModel: qwen3-coder:14b',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(path);
    expect(cfg.server).toEqual({
      allowedRoots: ['D:/repos/a', 'D:/repos/b'],
      maxConcurrent: 5,
      cookieSecure: true,
      allowRegister: true,
      trustProxy: true,
      ollamaModel: 'qwen3-coder:14b',
      hookTimeoutMs: 120_000,
      mcpEnabled: false,
    });
  });

  it('rejects invalid server settings (maxConcurrent out of range)', () => {
    const path = join(dir, '.ai-review.yml');
    writeFileSync(path, 'server:\n  maxConcurrent: 999\n');
    expect(() => loadConfig(path)).toThrow(ConfigError);
    expect(() => loadConfig(path)).toThrow(/server\.maxConcurrent/);
  });
});
