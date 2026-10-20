import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { HookTokenStore, openSqlite, ReviewStore, UserStore } from '@ai-review/db';
import { GitReader } from '@ai-review/diff';
import { createMockProvider } from '@ai-review/llm';
import type { PipelineDeps, PipelineRunner, ReviewState } from '@ai-review/core';
import { buildDefaultRegistry } from '@ai-review/tools';
import { EXIT_CODES } from '@ai-review/shared';
import { buildApp, assertRepoPathAllowed } from '../src/app.js';
import { createReviewMetrics } from '../src/metrics.js';
import { ReviewService } from '../src/review-service.js';

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeDeps(mode: 'fast' | 'full'): PipelineDeps {
  const mock = createMockProvider();
  return {
    gitReader: new GitReader(async () => 'main'),
    rag: { query: async () => [] },
    ignores: { allows: () => true },
    history: { changeFrequency: async () => 0 },
    providers: { correctness: mock, security: mock, performance: mock },
    registry: buildDefaultRegistry(),
    mode,
  };
}

function makeState(blocker: boolean): ReviewState {
  return {
    context: {
      files: [],
      metadata: {
        totalFiles: 0,
        totalAdditions: 0,
        totalDeletions: 0,
        languages: [],
        generatedAt: new Date().toISOString(),
      },
    },
    rawDiff: '',
    plan: { deep: [], quick: [], staticOnly: [] },
    findings: blocker
      ? [
          {
            agent: 'static',
            severity: 'BLOCKER',
            confidence: 0.9,
            filePath: 'config.ts',
            lineStart: 1,
            lineEnd: 1,
            title: 'Possible AWS access key id in changed code',
            description: 'Hardcoded credential detected.',
            isFalsePositive: false,
          },
        ]
      : [],
    healRounds: 0,
    metrics: {
      totalTokens: 0,
      durationMs: 1,
      filesDeep: 0,
      filesQuick: 0,
      filesStaticOnly: 0,
      degradedToStatic: [],
      healRounds: 0,
      cacheHits: 0,
      truncatedFiles: [],
      dimensions: ['correctness', 'security', 'performance'],
    },
  };
}

type Harness = {
  app: ReturnType<typeof buildApp>;
  tokens: HookTokenStore;
  store: ReviewStore;
  users: UserStore;
};

function makeHarness(
  runner: PipelineRunner,
  options: { hookTimeoutMs?: number; mcpEnabled?: boolean; roots?: string[] } = {},
): Harness {
  const sqlite = openSqlite(':memory:');
  const store = new ReviewStore(sqlite);
  const users = new UserStore(sqlite);
  const tokens = new HookTokenStore(sqlite);
  const metrics = createReviewMetrics();
  const service = new ReviewService(store, makeDeps, runner, metrics);
  const app = buildApp({
    store,
    users,
    service,
    metrics,
    hookTokens: tokens,
    registrationOpen: true,
    allowedRoots: options.roots ?? [process.cwd()],
    ...(options.hookTimeoutMs === undefined ? {} : { hookTimeoutMs: options.hookTimeoutMs }),
    ...(options.mcpEnabled === undefined ? {} : { mcpEnabled: options.mcpEnabled }),
  });
  return { app, tokens, store, users };
}

async function registerAdmin(app: Harness['app'], username = 'boss'): Promise<string> {
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'password123' }),
  });
  expect(res.status).toBe(201);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

describe('POST /api/hooks/review', () => {
  it('rejects requests without a token', async () => {
    const { app, tokens } = makeHarness(async () => makeState(false));
    void tokens;
    const res = await app.request('/api/hooks/review', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repoPath: process.cwd(), target: 'staged' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects an unknown or revoked token', async () => {
    const { app, tokens } = makeHarness(async () => makeState(false));
    const created = tokens.create({ label: 'test', expiresInDays: 1 });
    tokens.revoke(created.token.id);
    const res = await app.request('/api/hooks/review', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${created.plainText}`,
      },
      body: JSON.stringify({ repoPath: process.cwd(), target: 'staged' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns exit code 0 when nothing reaches the blocking threshold', async () => {
    const { app, tokens } = makeHarness(async () => makeState(false));
    const created = tokens.create({ label: 'test', expiresInDays: 1 });
    const res = await app.request('/api/hooks/review', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${created.plainText}`,
      },
      body: JSON.stringify({ repoPath: process.cwd(), target: 'staged', blockOn: 'BLOCKER' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exitCode: number; blocking: boolean };
    expect(body.exitCode).toBe(EXIT_CODES.ok);
    expect(body.blocking).toBe(false);
  });

  it('returns exit code 1 for a blocking finding', async () => {
    const { app, tokens } = makeHarness(async () => makeState(true));
    const created = tokens.create({ label: 'test', expiresInDays: 1 });
    const res = await app.request('/api/hooks/review', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${created.plainText}`,
      },
      body: JSON.stringify({ repoPath: process.cwd(), target: 'staged' }),
    });
    const body = (await res.json()) as { exitCode: number; blocking: boolean; blockerCount: number };
    expect(body.exitCode).toBe(EXIT_CODES.blocked);
    expect(body.blocking).toBe(true);
    expect(body.blockerCount).toBe(1);
  });

  it('returns exit code 2 when the pipeline fails', async () => {
    const { app, tokens } = makeHarness(async () => {
      throw new Error('boom');
    });
    const created = tokens.create({ label: 'test', expiresInDays: 1 });
    const res = await app.request('/api/hooks/review', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${created.plainText}`,
      },
      body: JSON.stringify({ repoPath: process.cwd(), target: 'staged' }),
    });
    const body = (await res.json()) as { exitCode: number; status: string };
    expect(body.exitCode).toBe(EXIT_CODES.configError);
    expect(body.status).toBe('failed');
  });

  it('returns exit code 3 (non-blocking) when the review times out', async () => {
    const { app, tokens } = makeHarness(() => new Promise<ReviewState>(() => undefined), {
      hookTimeoutMs: 10_000,
    });
    const created = tokens.create({ label: 'test', expiresInDays: 1 });
    const res = await app.request('/api/hooks/review', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${created.plainText}`,
      },
      body: JSON.stringify({ repoPath: process.cwd(), target: 'staged' }),
    });
    const body = (await res.json()) as { exitCode: number; status: string };
    expect(body.exitCode).toBe(EXIT_CODES.cancelled);
    expect(body.status).toBe('cancelled');
  }, 20_000);

  it('rejects a repoPath outside the allowed roots', async () => {
    const { app, tokens } = makeHarness(async () => makeState(false), {
      roots: ['D:/allowed-only'],
    });
    const created = tokens.create({ label: 'test', expiresInDays: 1 });
    const res = await app.request('/api/hooks/review', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${created.plainText}`,
      },
      body: JSON.stringify({ repoPath: '/etc/passwd', target: 'staged' }),
    });
    expect(res.status).toBe(400);
  });

  it('requires base for the range target', async () => {
    const { app, tokens } = makeHarness(async () => makeState(false));
    const created = tokens.create({ label: 'test', expiresInDays: 1 });
    const res = await app.request('/api/hooks/review', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${created.plainText}`,
      },
      body: JSON.stringify({ repoPath: process.cwd(), target: 'range' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('hook token administration', () => {
  it('issues a token and returns the plaintext only once', async () => {
    const { app } = makeHarness(async () => makeState(false));
    const cookie = await registerAdmin(app);
    const created = await app.request('/api/admin/hooks/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ label: 'laptop', expiresInDays: 30 }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as { plainText: string; token: { prefix: string } };
    expect(body.plainText.startsWith('air_')).toBe(true);
    expect(body.token.prefix).toBe(body.plainText.slice(0, 8));

    const list = await app.request('/api/admin/hooks/tokens', { headers: { cookie } });
    const listBody = (await list.text()).toString();
    expect(listBody).not.toContain(body.plainText);
    expect(listBody).toContain(body.token.prefix);
  });

  it('refuses to list tokens without the hook permission', async () => {
    const { app } = makeHarness(async () => makeState(false));
    await registerAdmin(app);
    const res = await app.request('/api/admin/hooks/tokens');
    // 无 Cookie：全局鉴权中间件先返回 401
    expect(res.status).toBe(401);
  });
});

describe('hook installation', () => {
  it('writes both scripts and the token file inside the repo', async () => {
    const repo = makeTempDir('ai-review-hook-');
    const { app } = makeHarness(async () => makeState(false), { roots: [repo] });
    const cookie = await registerAdmin(app);
    const res = await app.request('/api/admin/hooks/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ repoPath: repo, tokenLabel: 'installed' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { installed: boolean; files: string[]; plainText: string };
    expect(body.installed).toBe(true);
    expect(body.files).toHaveLength(3);
    const runner = readFileSync(join(repo, '.ai-review/hooks/pre-commit.mjs'), 'utf8');
    expect(runner).toContain('/api/hooks/review');
    expect(runner).toContain('exitWith(3');
    const token = readFileSync(join(repo, '.ai-review-cache/hook-token'), 'utf8').trim();
    expect(token).toBe(body.plainText);
    // 令牌落盘后必须被 .gitignore 覆盖，否则 git add -A 会把凭据提交上去
    const gitignore = readFileSync(join(repo, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.ai-review-cache/');
  });

  it('keeps existing .gitignore entries and only appends missing ones', async () => {
    const repo = makeTempDir('ai-review-hook-');
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
    const { app } = makeHarness(async () => makeState(false), { roots: [repo] });
    const cookie = await registerAdmin(app);
    await app.request('/api/admin/hooks/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ repoPath: repo, tokenLabel: 'installed' }),
    });
    const gitignore = readFileSync(join(repo, '.gitignore'), 'utf8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('.ai-review-cache/');
    // 幂等：重复安装不应重复追加
    await app.request('/api/admin/hooks/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ repoPath: repo, tokenLabel: 'installed', overwrite: true }),
    });
    const again = readFileSync(join(repo, '.gitignore'), 'utf8');
    expect(again.split('.ai-review-cache/').length - 1).toBe(1);
  });

  it('skips existing files unless overwrite is requested', async () => {
    const repo = makeTempDir('ai-review-hook-');
    const { app } = makeHarness(async () => makeState(false), { roots: [repo] });
    const cookie = await registerAdmin(app);
    const send = (overwrite: boolean): Promise<Response> =>
      app.request('/api/admin/hooks/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ repoPath: repo, tokenLabel: 'installed', overwrite }),
      });
    await send(false);
    const second = (await (await send(false)).json()) as { skipped: string[]; files: string[] };
    expect(second.skipped.length).toBeGreaterThan(0);
    expect(second.files).toHaveLength(0);
    const third = (await (await send(true)).json()) as { skipped: string[]; files: string[] };
    expect(third.skipped).toHaveLength(0);
    expect(third.files.length).toBeGreaterThan(0);
  });

  it('refuses to install outside the allowed roots', async () => {
    const { app } = makeHarness(async () => makeState(false), { roots: ['D:/allowed-only'] });
    const cookie = await registerAdmin(app);
    const res = await app.request('/api/admin/hooks/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ repoPath: '/etc', tokenLabel: 'x' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('repository discovery', () => {
  it('lists git repositories under the allowed roots', async () => {
    const root = makeTempDir('ai-review-repos-');
    const repo = join(root, 'project-a');
    writeFileSync(join(root, 'placeholder.txt'), '');
    // 手工构造 .git 目录：RepoService 只判断该目录是否存在（不做 git 调用）
    const { mkdirSync } = await import('node:fs');
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(repo, '.git'), { recursive: true });

    const { app } = makeHarness(async () => makeState(false), { roots: [root] });
    const cookie = await registerAdmin(app, 'boss');
    const res = await app.request('/api/repos', { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repositories: Array<{ path: string; name: string; isGitRepo: boolean }>;
    };
    expect(body.repositories.some((item) => item.name === 'project-a' && item.isGitRepo)).toBe(
      true,
    );
  });

  it('rejects status queries outside the allowed roots', async () => {
    const { app } = makeHarness(async () => makeState(false), { roots: ['D:/allowed-only'] });
    const cookie = await registerAdmin(app);
    const res = await app.request('/api/repos/status?repoPath=/etc/passwd', {
      headers: { cookie },
    });
    expect(res.status).toBe(400);
  });
});

describe('MCP endpoint', () => {
  it('is disabled by default', async () => {
    const { app } = makeHarness(async () => makeState(false));
    const res = await app.request('/api/mcp', { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('requires a valid token when enabled', async () => {
    const { app } = makeHarness(async () => makeState(false), { mcpEnabled: true });
    const res = await app.request('/api/mcp', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('assertRepoPathAllowed', () => {
  it('accepts the root itself and its descendants', () => {
    const root = makeTempDir('ai-review-roots-');
    expect(() => assertRepoPathAllowed(root, [root])).not.toThrow();
    expect(() => assertRepoPathAllowed(join(root, 'nested'), [root])).not.toThrow();
  });

  it('rejects traversal outside the root', () => {
    const root = makeTempDir('ai-review-roots-');
    expect(() => assertRepoPathAllowed(join(root, '..'), [root])).toThrow();
  });
});
