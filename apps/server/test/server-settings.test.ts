import { delimiter } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiReviewConfigSchema } from '@ai-review/shared';
import { loadServerSettings } from '../src/server-settings.js';

function makeConfig(): ReturnType<typeof AiReviewConfigSchema.parse> {
  return AiReviewConfigSchema.parse({});
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('loadServerSettings', () => {
  it('applies config values when env is unset (config > default)', () => {
    const config = AiReviewConfigSchema.parse({
      server: {
        allowedRoots: ['D:/repos/a'],
        maxConcurrent: 5,
        cookieSecure: true,
        allowRegister: true,
        trustProxy: true,
        ollamaModel: 'qwen3-coder:14b',
      },
    });
    const settings = loadServerSettings(config);
    expect(settings.allowedRoots).toEqual(['D:/repos/a']);
    expect(settings.maxConcurrent).toBe(5);
    expect(settings.cookieSecure).toBe(true);
    expect(settings.allowRegister).toBe(true);
    expect(settings.trustProxy).toBe(true);
    expect(settings.ollamaModel).toBe('qwen3-coder:14b');
  });

  it('env wins over config (env > config)', () => {
    vi.stubEnv('AI_REVIEW_MAX_CONCURRENT', '8');
    vi.stubEnv('AI_REVIEW_COOKIE_SECURE', 'true');
    vi.stubEnv('AI_REVIEW_ALLOW_REGISTER', 'false');
    vi.stubEnv('AI_REVIEW_TRUST_PROXY', 'true');
    vi.stubEnv('AI_REVIEW_OLLAMA_MODEL', 'qwen3-coder:32b');
    // 多路径分隔符随平台变化（Windows ';' / POSIX ':'）；POSIX 的 ':' 与 Windows 盘符
    // 冲突，因此取值也按平台区分，否则 Linux CI 会把 'D:/a' 拆成 'D' 和 '/a'。
    const roots = process.platform === 'win32' ? ['D:/a', 'D:/b'] : ['/repos/a', '/repos/b'];
    vi.stubEnv('AI_REVIEW_ALLOWED_ROOTS', roots.join(delimiter));
    const config = AiReviewConfigSchema.parse({
      server: { maxConcurrent: 2, allowRegister: true, ollamaModel: 'from-config' },
    });
    const settings = loadServerSettings(config);
    expect(settings.allowedRoots).toEqual(roots);
    expect(settings.maxConcurrent).toBe(8);
    expect(settings.cookieSecure).toBe(true);
    // env 显式 false 覆盖 config true
    expect(settings.allowRegister).toBe(false);
    expect(settings.trustProxy).toBe(true);
    expect(settings.ollamaModel).toBe('qwen3-coder:32b');
  });

  it('falls back to defaults when neither env nor config is set', () => {
    const settings = loadServerSettings(makeConfig());
    expect(settings.maxConcurrent).toBe(3);
    expect(settings.cookieSecure).toBe(false);
    expect(settings.allowRegister).toBe(false);
    expect(settings.trustProxy).toBe(false);
    expect(settings.ollamaModel).toBe('qwen3-coder:30b');
    expect(settings.allowedRoots).toEqual([process.cwd()]);
  });

  it('keeps NODE_ENV=production auto-secure unless env explicitly disables', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(loadServerSettings(makeConfig()).cookieSecure).toBe(true);
    vi.stubEnv('AI_REVIEW_COOKIE_SECURE', 'false');
    expect(loadServerSettings(makeConfig()).cookieSecure).toBe(false);
  });

  it('sanitizes invalid maxConcurrent to the default', () => {
    vi.stubEnv('AI_REVIEW_MAX_CONCURRENT', 'abc');
    expect(loadServerSettings(makeConfig()).maxConcurrent).toBe(3);
    vi.stubEnv('AI_REVIEW_MAX_CONCURRENT', '0');
    expect(loadServerSettings(makeConfig()).maxConcurrent).toBe(3);
  });

  it('uses the configured allowedRoots when env is unset', () => {
    const config = AiReviewConfigSchema.parse({ server: { allowedRoots: ['D:/repos/a'] } });
    expect(loadServerSettings(config).allowedRoots).toEqual(['D:/repos/a']);
  });
});
