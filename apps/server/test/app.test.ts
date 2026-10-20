import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stringify as stringifyYaml } from 'yaml';
import { runReviewPipeline } from '@ai-review/core';
import type { GitRunner, PipelineDeps, PipelineRunner, ReviewState } from '@ai-review/core';
import { openSqlite, LogStore, ReviewStore, UserStore } from '@ai-review/db';
import { GitReader } from '@ai-review/diff';
import { createMockProvider } from '@ai-review/llm';
import { buildDefaultRegistry } from '@ai-review/tools';
import type { Finding } from '@ai-review/shared';
import { buildApp } from '../src/app.js';
import { AuditService } from '../src/audit.js';
import { AvatarStore } from '../src/avatar.js';
import { createStoreReviewCache } from '../src/cache.js';
import { Logger } from '../src/logger.js';
import { createReviewMetrics } from '../src/metrics.js';
import { ReviewService } from '../src/review-service.js';

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

const BLOCKER_FINDING: Finding = {
  agent: 'static',
  severity: 'BLOCKER',
  confidence: 0.9,
  filePath: 'config.ts',
  lineStart: 1,
  lineEnd: 1,
  title: 'Possible AWS access key id in changed code',
  description: 'Hardcoded credential detected.',
  isFalsePositive: false,
};

function makeState(): ReviewState {
  return {
    context: {
      files: [],
      metadata: {
        totalFiles: 1,
        totalAdditions: 10,
        totalDeletions: 2,
        languages: ['ts'],
        generatedAt: new Date().toISOString(),
      },
    },
    plan: { deep: [], quick: [], staticOnly: [] },
    findings: [BLOCKER_FINDING],
    healRounds: 0,
    metrics: {
      totalTokens: 0,
      durationMs: 5,
      filesDeep: 0,
      filesQuick: 0,
      filesStaticOnly: 1,
      degradedToStatic: [],
      healRounds: 0,
      cacheHits: 0,
    },
  };
}

/** 节点事件 → 等 gate → 完成，供 SSE 订阅时序测试 */
function makeGatedRunner(gate: { promise: Promise<void>; resolve: () => void }): PipelineRunner {
  return async (_deps, options) => {
    options.onNodeUpdate?.('parse', {});
    await gate.promise;
    options.onNodeUpdate?.('report', {});
    return makeState();
  };
}

type Harness = ReturnType<typeof buildApp>;

/** 装配审计日志（SQLite 落库，Logger 静默）；返回 app 与 AuditService 供断言 */
function makeAuditedHarness(
  runner: PipelineRunner,
  configPath?: string,
): { app: Harness; audit: AuditService } {
  const sqlite = openSqlite(':memory:');
  const store = new ReviewStore(sqlite);
  const users = new UserStore(sqlite);
  const metrics = createReviewMetrics();
  const service = new ReviewService(store, makeDeps, runner, metrics);
  const audit = new AuditService(
    new LogStore(sqlite),
    new Logger({ console: false, file: false }),
    true,
  );
  const app = buildApp({
    store,
    users,
    service,
    metrics,
    audit,
    ...(configPath === undefined ? {} : { configPath }),
    registrationOpen: true,
    allowedRoots: ['D:/'],
  });
  return { app, audit };
}

function makeHarness(runner: PipelineRunner, avatars?: AvatarStore, configPath?: string): Harness {
  const sqlite = openSqlite(':memory:');
  const store = new ReviewStore(sqlite);
  const users = new UserStore(sqlite);
  const metrics = createReviewMetrics();
  const service = new ReviewService(store, makeDeps, runner, metrics);
  return buildApp({
    store,
    users,
    service,
    metrics,
    ...(avatars === undefined ? {} : { avatars }),
    ...(configPath === undefined ? {} : { configPath }),
    // 测试需要多用户注册与任意本地仓库路径；显式放开开放注册与仓库根白名单（生产默认收紧）
    registrationOpen: true,
    allowedRoots: ['D:/'],
  });
}

const gates: Array<{ promise: Promise<void>; resolve: () => void }> = [];
function newGate(): { promise: Promise<void>; resolve: () => void } {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  const gate = { promise, resolve: resolve as () => void };
  gates.push(gate);
  return gate;
}

afterEach(() => {
  for (const gate of gates.splice(0)) gate.resolve();
});

/** 注册并返回会话 Cookie（首个注册用户自动成为 admin） */
async function registerUser(
  app: Harness,
  username: string,
  password = 'password123',
): Promise<{ cookie: string; role: string }> {
  const res = await app.request('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  expect(res.status).toBe(201);
  const { user } = (await res.json()) as { user: { role: string } };
  const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  expect(cookie).toContain('ai_review_session=');
  return { cookie, role: user.role };
}

function auth(cookie: string): { cookie: string } {
  return { cookie };
}

async function startReview(app: Harness, cookie: string): Promise<string> {
  const started = await app.request('/api/reviews', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth(cookie) },
    body: JSON.stringify({ repoPath: 'D:/tmp/repo', mode: 'fast' }),
  });
  expect(started.status).toBe(202);
  const { reviewId }: { reviewId: string } = await started.json();
  return reviewId;
}

describe('auth API', () => {
  it('makes the first registered user admin and the rest regular users', async () => {
    const app = makeHarness(async () => makeState());
    const first = await registerUser(app, 'boss');
    expect(first.role).toBe('admin');
    const second = await registerUser(app, 'alice');
    expect(second.role).toBe('user');
  });

  it('rejects duplicate usernames and weak payloads', async () => {
    const app = makeHarness(async () => makeState());
    await registerUser(app, 'boss');
    const dup = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'password123' }),
    });
    expect(dup.status).toBe(409);
    const weak = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'x', password: 'short' }),
    });
    expect(weak.status).toBe(400);
  });

  it('logs in with valid credentials, rejects bad ones, and serves /me', async () => {
    const app = makeHarness(async () => makeState());
    await registerUser(app, 'boss', 's3cret-password');

    const bad = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'wrong-password' }),
    });
    expect(bad.status).toBe(401);
    const unknown = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'whatever-pass' }),
    });
    expect(unknown.status).toBe(401);

    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 's3cret-password' }),
    });
    expect(login.status).toBe(200);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const me = await app.request('/api/auth/me', { headers: auth(cookie) });
    expect(me.status).toBe(200);
    const { user } = (await me.json()) as { user: { username: string; role: string } };
    expect(user).toMatchObject({ username: 'boss', role: 'admin' });
  });

  it('revokes all sessions after a password change', async () => {
    const app = makeHarness(async () => makeState());
    const { cookie } = await registerUser(app, 'boss');

    const changed = await app.request('/api/auth/change-password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({ oldPassword: 'password123', newPassword: 'brand-new-pass' }),
    });
    expect(changed.status).toBe(200);

    const revoked = await app.request('/api/auth/me', { headers: auth(cookie) });
    expect(revoked.status).toBe(401);

    const relogin = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'brand-new-pass' }),
    });
    expect(relogin.status).toBe(200);
  });

  it('rejects unauthenticated API access', async () => {
    const app = makeHarness(async () => makeState());
    expect((await app.request('/api/reviews')).status).toBe(401);
    expect((await app.request('/api/stats')).status).toBe(401);
    expect((await app.request('/api/reviews/review-x')).status).toBe(401);
  });
});

describe('avatar upload API', () => {
  // 1x1 PNG（真实魔数，非仅 Content-Type 伪造）
  const PNG_1PX = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x8b, 0x29, 0x8d, 0x00, 0x00, 0x00,
    0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);

  function avatarHarness(): ReturnType<typeof buildApp> {
    const avatars = new AvatarStore(mkdtempSync(join(tmpdir(), 'ai-review-avatar-')));
    return makeHarness(async () => makeState(), avatars);
  }

  function multipart(file: Uint8Array, type: string): { body: FormData } {
    const fd = new FormData();
    fd.append('avatar', new Blob([file], { type }), 'avatar.png');
    return { body: fd };
  }

  it('uploads a valid PNG and serves it back with image/png', async () => {
    const app = avatarHarness();
    const { cookie } = await registerUser(app, 'carol');
    const upload = await app.request('/api/auth/avatar', {
      method: 'POST',
      headers: { ...auth(cookie) },
      ...multipart(PNG_1PX, 'image/png'),
    });
    expect(upload.status).toBe(200);
    const { user } = (await upload.json()) as { user: { avatarUrl: string | null; id: string } };
    expect(user.avatarUrl).toContain('/api/users/');
    expect(user.avatarUrl).toContain('/avatar');

    const read = await app.request(user.avatarUrl, { headers: { ...auth(cookie) } });
    expect(read.status).toBe(200);
    expect(read.headers.get('content-type')).toBe('image/png');
    expect(read.headers.get('cache-control')).toBe('no-store');
    const served = new Uint8Array(await read.arrayBuffer());
    expect(served.length).toBe(PNG_1PX.length);
    expect(served).toEqual(PNG_1PX);
  });

  it('rejects non-image upload (SVG 魔数) with 400', async () => {
    const app = avatarHarness();
    const { cookie } = await registerUser(app, 'dave');
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const res = await app.request('/api/auth/avatar', {
      method: 'POST',
      headers: { ...auth(cookie) },
      ...multipart(svg, 'image/svg+xml'),
    });
    expect(res.status).toBe(400);
  });

  it('rejects oversized upload with 413', async () => {
    const app = avatarHarness();
    const { cookie } = await registerUser(app, 'erin');
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    // 头部仍是合法 PNG 魔数，仅验证体积上限
    big.set(PNG_1PX.subarray(0, 8), 0);
    const res = await app.request('/api/auth/avatar', {
      method: 'POST',
      headers: { ...auth(cookie) },
      ...multipart(big, 'image/png'),
    });
    expect(res.status).toBe(413);
  });

  it('accepts avatars in the 1MB-2MB range (must not be caught by the generic 1MB api cap)', async () => {
    const app = avatarHarness();
    const { cookie } = await registerUser(app, 'grace');
    // 1.5MB 头像：前后端规则均允许（≤2MB），若被 limitBody(1MB) 误拒则回归（修复前返回 413）
    const file = new Uint8Array(1536 * 1024);
    file.set(PNG_1PX.subarray(0, 8), 0);
    const res = await app.request('/api/auth/avatar', {
      method: 'POST',
      headers: { ...auth(cookie) },
      ...multipart(file, 'image/png'),
    });
    expect(res.status).toBe(200);
  });

  it('requires authentication to upload and returns 404 for users without avatar', async () => {
    const app = avatarHarness();
    const { cookie } = await registerUser(app, 'frank');
    expect((await app.request('/api/auth/avatar', { method: 'POST' })).status).toBe(401);
    // 未上传头像时读取返回 404
    const me = (await app.request('/api/auth/me', { headers: { ...auth(cookie) } })) as {
      status: number;
      json(): Promise<{ user: { id: string } }>;
    };
    const { user } = await me.json();
    expect(
      (await app.request(`/api/users/${user.id}/avatar`, { headers: { ...auth(cookie) } })).status,
    ).toBe(404);
  });
});

describe('admin user creation & RBAC roles', () => {
  it('allows admin to create a regular user', async () => {
    const app = makeHarness(async () => makeState());
    const { cookie } = await registerUser(app, 'boss');
    const res = await app.request('/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({ username: 'newbie', password: 'password123' }),
    });
    expect(res.status).toBe(201);
    const { user } = (await res.json()) as { user: { role: string; username: string } };
    expect(user.username).toBe('newbie');
    expect(user.role).toBe('user');
  });

  it('seeds built-in admin/user roles', async () => {
    const app = makeHarness(async () => makeState());
    const { cookie } = await registerUser(app, 'boss');
    const res = await app.request('/api/admin/roles', { headers: { ...auth(cookie) } });
    expect(res.status).toBe(200);
    const { roles } = (await res.json()) as {
      roles: Array<{ name: string; isSystem: boolean; permissions: string[] }>;
    };
    const names = roles.map((r) => r.name);
    expect(names).toContain('admin');
    expect(names).toContain('user');
    const adminRole = roles.find((r) => r.name === 'admin');
    expect(adminRole?.permissions).toEqual(['*']);
    expect(adminRole?.isSystem).toBe(true);
  });

  it('creates, assigns and deletes a custom role', async () => {
    const app = makeHarness(async () => makeState());
    const { cookie } = await registerUser(app, 'boss');
    const createRes = await app.request('/api/admin/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({
        name: 'reviewer',
        description: 'can review',
        priority: 50,
        permissions: ['/', '/run'],
      }),
    });
    expect(createRes.status).toBe(201);
    const { role } = (await createRes.json()) as {
      role: { id: string; isSystem: boolean };
    };
    expect(role.isSystem).toBe(false);

    // 管理员不能删除内置角色
    const delSystem = await app.request('/api/admin/roles/role-admin', {
      method: 'DELETE',
      headers: { ...auth(cookie) },
    });
    expect(delSystem.status).toBe(400);

    // 分配角色给新用户
    const created = await app.request('/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({ username: 'junior', password: 'password123' }),
    });
    const { user } = (await created.json()) as { user: { id: string } };
    const assign = await app.request(`/api/admin/users/${user.id}/roles`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({ roleIds: [role.id, 'role-user'] }),
    });
    expect(assign.status).toBe(200);
    const assigned = (await assign.json()) as {
      user: { roleIds: string[]; permissions: string[] };
    };
    expect(assigned.user.roleIds).toContain(role.id);
    expect(assigned.user.permissions).toContain('/run');

    const delCustom = await app.request(`/api/admin/roles/${role.id}`, {
      method: 'DELETE',
      headers: { ...auth(cookie) },
    });
    expect(delCustom.status).toBe(200);
  });

  it('promotes/demotes admin purely via role assignment (role column derived)', async () => {
    const app = makeHarness(async () => makeState());
    const { cookie } = await registerUser(app, 'boss');
    const created = await app.request('/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({ username: 'junior2', password: 'password123' }),
    });
    const { user } = (await created.json()) as { user: { id: string; role: string } };
    expect(user.role).toBe('user');

    // 分配内置 admin 角色（含 '*'）→ 自动升级为管理员
    const promote = await app.request(`/api/admin/users/${user.id}/roles`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({ roleIds: ['role-admin'] }),
    });
    expect(promote.status).toBe(200);
    const promoted = (await promote.json()) as {
      user: { role: string; permissions: string[] };
    };
    expect(promoted.user.role).toBe('admin');
    expect(promoted.user.permissions).toEqual(['*']);

    // 降回普通用户角色 → role 字段自动回到 user
    const demote = await app.request(`/api/admin/users/${user.id}/roles`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({ roleIds: ['role-user'] }),
    });
    const demoted = (await demote.json()) as { user: { role: string } };
    expect(demoted.user.role).toBe('user');
  });

  it('backfills built-in roles for legacy accounts without any role assignment', () => {
    const sqlite = openSqlite(':memory:');
    new ReviewStore(sqlite); // 建表 + 种子角色
    const users = new UserStore(sqlite);
    const now = new Date().toISOString();
    // 模拟 RBAC 引入前创建的存量账号：仅写 users 表，不分配任何角色
    sqlite
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('legacy-admin', 'oldadmin', 'x', 'admin', 'active', now);
    sqlite
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('legacy-user', 'olduser', 'x', 'user', 'active', now);

    // 迁移前：无任何角色 → permissions 为空（正是“管理员可访问页面过少”的根因）
    expect(users.getById('legacy-admin')?.permissions).toEqual([]);
    expect(users.getById('legacy-user')?.permissions).toEqual([]);

    const count = users.backfillDefaultRoles();
    expect(count).toBe(2);

    // 迁移后：admin→role-admin（全权限），user→role-user（常规页面）
    const admin = users.getById('legacy-admin');
    expect(admin?.role).toBe('admin');
    expect(admin?.permissions).toEqual(['*']);
    const user = users.getById('legacy-user');
    expect(user?.role).toBe('user');
    expect(user?.permissions).toContain('/reviews');

    // 幂等：再次调用不再补发
    expect(users.backfillDefaultRoles()).toBe(0);
  });

  it('grants access only to admin pages a role was explicitly permitted', async () => {
    const app = makeHarness(async () => makeState());
    const { cookie } = await registerUser(app, 'boss');

    // 建一个仅含用户管理权限的角色
    const roleRes = await app.request('/api/admin/roles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({ name: 'usermgr', priority: 60, permissions: ['/', '/admin/users'] }),
    });
    const { role } = (await roleRes.json()) as { role: { id: string } };

    const created = await app.request('/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({ username: 'staff', password: 'password123' }),
    });
    const { user } = (await created.json()) as { user: { id: string } };
    await app.request(`/api/admin/users/${user.id}/roles`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({ roleIds: [role.id] }),
    });

    // 以该用户登录，验证按页面权限放行/拒绝
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'staff', password: 'password123' }),
    });
    expect(login.status).toBe(200);
    const staffCookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    expect((await app.request('/api/admin/users', { headers: auth(staffCookie) })).status).toBe(
      200,
    );
    expect((await app.request('/api/admin/roles', { headers: auth(staffCookie) })).status).toBe(
      403,
    );
    expect((await app.request('/metrics', { headers: auth(staffCookie) })).status).toBe(403);
  });
});

describe('review REST API', () => {
  it('runs a review to completion and serves its report', async () => {
    const app = makeHarness(async () => makeState());
    const { cookie } = await registerUser(app, 'boss');
    const reviewId = await startReview(app, cookie);

    await vi.waitFor(async () => {
      const listResponse = await app.request('/api/reviews', { headers: auth(cookie) });
      const list = await listResponse.json();
      expect(list).toEqual({
        reviews: [expect.objectContaining({ reviewId, blockerCount: 1, branch: 'main' })],
      });
    });

    const detail = await app.request(`/api/reviews/${reviewId}`, { headers: auth(cookie) });
    expect(detail.status).toBe(200);
    const report = await detail.json();
    expect(report.meta).toMatchObject({ reviewId, repoPath: 'D:/tmp/repo', branch: 'main' });
    expect(report.findings[0]).toMatchObject({
      severity: 'BLOCKER',
      title: 'Possible AWS access key id in changed code',
    });
    expect(report.assessment).toContain('should not be committed');
  });

  it('returns 404 for unknown reviews', async () => {
    const app = makeHarness(async () => makeState());
    const { cookie } = await registerUser(app, 'boss');
    const detail = await app.request('/api/reviews/review-missing', { headers: auth(cookie) });
    expect(detail.status).toBe(404);
  });

  it('rejects invalid start payloads', async () => {
    const app = makeHarness(async () => makeState());
    const { cookie } = await registerUser(app, 'boss');
    const bad = await app.request('/api/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({ mode: 'ultra' }),
    });
    expect(bad.status).toBe(400);

    const invalidQuery = await app.request('/api/reviews?page=0', { headers: auth(cookie) });
    expect(invalidQuery.status).toBe(400);
  });
});

describe('per-user data isolation', () => {
  it('hides user B reviews from user A but shows everything to admin', async () => {
    const app = makeHarness(async () => makeState());
    const admin = await registerUser(app, 'boss');
    const alice = await registerUser(app, 'alice');
    const bob = await registerUser(app, 'bob');

    const aliceReview = await startReview(app, alice.cookie);
    const bobReview = await startReview(app, bob.cookie);

    // alice 看不到 bob 的报告详情 / 列表 / 统计
    expect(
      (await app.request(`/api/reviews/${bobReview}`, { headers: auth(alice.cookie) })).status,
    ).toBe(404);
    const aliceList = (await (
      await app.request('/api/reviews', { headers: auth(alice.cookie) })
    ).json()) as {
      reviews: Array<{ reviewId: string }>;
    };
    expect(aliceList.reviews.map((r) => r.reviewId)).toEqual([aliceReview]);
    const aliceStats = (await (
      await app.request('/api/stats', { headers: auth(alice.cookie) })
    ).json()) as {
      stats: { totalReviews: number };
    };
    expect(aliceStats.stats.totalReviews).toBe(1);

    // SSE 订阅同样按归属隔离
    expect(
      (await app.request(`/api/reviews/${bobReview}/events`, { headers: auth(alice.cookie) }))
        .status,
    ).toBe(404);

    // admin 全量可见
    const adminList = (await (
      await app.request('/api/reviews', { headers: auth(admin.cookie) })
    ).json()) as {
      reviews: Array<{ reviewId: string }>;
    };
    expect(adminList.reviews.map((r) => r.reviewId).sort()).toEqual(
      [aliceReview, bobReview].sort(),
    );
    expect(
      (await app.request(`/api/reviews/${bobReview}`, { headers: auth(admin.cookie) })).status,
    ).toBe(200);
  });

  it('rejects false-positive marking across users', async () => {
    const app = makeHarness(async () => makeState());
    const admin = await registerUser(app, 'boss');
    const alice = await registerUser(app, 'alice');
    const bob = await registerUser(app, 'bob');
    const bobReview = await startReview(app, bob.cookie);
    const detail = (await (
      await app.request(`/api/reviews/${bobReview}`, { headers: auth(bob.cookie) })
    ).json()) as { findings: Array<{ id: number }> };
    const findingId = detail.findings[0]?.id;
    if (findingId === undefined) throw new Error('expected a finding row');

    expect(
      (
        await app.request(`/api/findings/${findingId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...auth(alice.cookie) },
          body: JSON.stringify({ isFalsePositive: true }),
        })
      ).status,
    ).toBe(404);
    // admin 跨用户可标记
    expect(
      (
        await app.request(`/api/findings/${findingId}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...auth(admin.cookie) },
          body: JSON.stringify({ isFalsePositive: true }),
        })
      ).status,
    ).toBe(200);
  });
});

describe('admin privilege isolation', () => {
  it('forbids admin endpoints and /metrics for regular users', async () => {
    const app = makeHarness(async () => makeState());
    const admin = await registerUser(app, 'boss');
    const alice = await registerUser(app, 'alice');

    expect((await app.request('/api/admin/users', { headers: auth(alice.cookie) })).status).toBe(
      403,
    );
    expect((await app.request('/metrics', { headers: auth(alice.cookie) })).status).toBe(403);
    expect((await app.request('/api/admin/users', { headers: auth(admin.cookie) })).status).toBe(
      200,
    );
    expect((await app.request('/metrics', { headers: auth(admin.cookie) })).status).toBe(200);
  });

  it('manages users: role change, disable, reset password, delete, self-lockout guards', async () => {
    const app = makeHarness(async () => makeState());
    const admin = await registerUser(app, 'boss');
    const alice = await registerUser(app, 'alice');

    // 自锁防护
    const me = (await (
      await app.request('/api/auth/me', { headers: auth(admin.cookie) })
    ).json()) as {
      user: { id: string };
    };
    const aliceMe = (await (
      await app.request('/api/auth/me', { headers: auth(alice.cookie) })
    ).json()) as {
      user: { id: string };
    };
    expect(
      (
        await app.request(`/api/admin/users/${me.user.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...auth(admin.cookie) },
          body: JSON.stringify({ role: 'user' }),
        })
      ).status,
    ).toBe(400);

    // 提升 alice 为 admin
    const promoted = await app.request(`/api/admin/users/${aliceMe.user.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...auth(admin.cookie) },
      body: JSON.stringify({ role: 'admin' }),
    });
    expect(promoted.status).toBe(200);

    // 重置密码后旧会话失效、新密码可登录
    const reset = await app.request(`/api/admin/users/${aliceMe.user.id}/reset-password`, {
      method: 'POST',
      headers: { ...auth(admin.cookie) },
    });
    expect(reset.status).toBe(200);
    const { newPassword } = (await reset.json()) as { newPassword: string };
    expect((await app.request('/api/auth/me', { headers: auth(alice.cookie) })).status).toBe(401);
    expect(
      (
        await app.request('/api/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'alice', password: newPassword }),
        })
      ).status,
    ).toBe(200);

    // 禁用后登录被拒
    await app.request(`/api/admin/users/${aliceMe.user.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...auth(admin.cookie) },
      body: JSON.stringify({ status: 'disabled' }),
    });
    const disabledLogin = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: newPassword }),
    });
    expect(disabledLogin.status).toBe(403);

    // 删除
    expect(
      (
        await app.request(`/api/admin/users/${aliceMe.user.id}`, {
          method: 'DELETE',
          headers: { ...auth(admin.cookie) },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(`/api/admin/users/${aliceMe.user.id}`, {
          method: 'DELETE',
          headers: { ...auth(admin.cookie) },
        })
      ).status,
    ).toBe(404);
  });

  it('returns a client error for invalid admin configuration payloads', async () => {
    const app = makeHarness(async () => makeState());
    const admin = await registerUser(app, 'boss');
    const response = await app.request('/api/admin/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth(admin.cookie) },
      body: JSON.stringify({ llm: { provider: 'not-a-provider' } }),
    });
    expect(response.status).toBe(400);
  });

  it('persists server settings and review fields, and reports read-only runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-review-srvcfg-'));
    const configPath = join(dir, '.ai-review.yml');
    const app = makeHarness(async () => makeState(), undefined, configPath);
    const admin = await registerUser(app, 'boss');

    const response = await app.request('/api/admin/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth(admin.cookie) },
      body: JSON.stringify({
        llm: { provider: 'mock' },
        review: {
          mode: 'fast',
          dimensions: ['correctness', 'security'],
          ignorePatterns: ['*.lock', 'custom-pattern/**'],
          blockOn: 'BLOCKER',
        },
        server: {
          allowedRoots: ['D:/repos/a'],
          maxConcurrent: 4,
          cookieSecure: true,
          allowRegister: true,
          trustProxy: true,
          ollamaModel: 'qwen3-coder:14b',
        },
      }),
    });
    expect(response.status).toBe(200);
    const saved = (await response.json()) as {
      config: {
        review: { dimensions: string[]; ignorePatterns: string[] };
        server: { maxConcurrent: number; allowRegister: boolean };
      };
    };
    expect(saved.config.review.dimensions).toEqual(['correctness', 'security']);
    expect(saved.config.review.ignorePatterns).toEqual(['*.lock', 'custom-pattern/**']);
    expect(saved.config.server.maxConcurrent).toBe(4);
    expect(saved.config.server.allowRegister).toBe(true);

    // 回读：GET 返回持久化的 server 段与只读 runtime（含默认端口/DB 路径兜底）
    const getRes = await app.request('/api/admin/config', { headers: auth(admin.cookie) });
    expect(getRes.status).toBe(200);
    const body = (await getRes.json()) as {
      config: {
        review: { dimensions: string[] };
        server: { maxConcurrent: number; ollamaModel: string };
      };
      runtime: { port: number; dbPath: string; webDistDir: string | null; configPath: string; allowedRoots: string[] };
    };
    expect(body.config.server.maxConcurrent).toBe(4);
    expect(body.config.server.ollamaModel).toBe('qwen3-coder:14b');
    expect(body.config.review.dimensions).toEqual(['correctness', 'security']);
    expect(body.runtime.configPath).toBe(configPath);
    expect(body.runtime.port).toBe(8080);
    expect(body.runtime.webDistDir).toBeNull();
  });

  it('applies configured review mode/blockOn as defaults for web reviews', async () => {
    // WARNING 发现（无 BLOCKER）：配置 blockOn=WARNING 时判定为阻断
    const warningState = (): ReviewState => {
      const state = makeState();
      state.findings = [
        {
          agent: 'static',
          severity: 'WARNING',
          confidence: 0.8,
          filePath: 'a.ts',
          lineStart: 1,
          lineEnd: 1,
          title: 'unused variable',
          description: 'desc',
          isFalsePositive: false,
        },
      ];
      return state;
    };
    const dir = mkdtempSync(join(tmpdir(), 'ai-review-modecfg-'));
    const configPath = join(dir, '.ai-review.yml');
    writeFileSync(
      configPath,
      stringifyYaml({ llm: { provider: 'mock' }, review: { mode: 'full', blockOn: 'WARNING' } }),
      'utf8',
    );
    const app = makeHarness(async () => warningState(), undefined, configPath);
    const { cookie } = await registerUser(app, 'boss');

    // 未传 mode/blockOn → 回退系统配置默认值（full + WARNING）
    const started = await app.request('/api/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({ repoPath: 'D:/tmp/repo' }),
    });
    expect(started.status).toBe(202);
    const { reviewId }: { reviewId: string } = await started.json();

    await vi.waitFor(async () => {
      const detail = await app.request(`/api/reviews/${reviewId}`, { headers: auth(cookie) });
      expect(detail.status).toBe(200);
      const review = (await detail.json()) as { meta: { mode: string } };
      expect(review.meta.mode).toBe('full');
    });
    // blockOn 回退：WARNING 发现 + 配置 WARNING → completed blocking=true
    const body = await (
      await app.request(`/api/reviews/${reviewId}/events`, { headers: auth(cookie) })
    ).text();
    expect(body).toContain('event: completed');
    expect(body).toContain('"blocking":true');
  });

  it('explicit mode/blockOn override the configured defaults', async () => {
    const warningState = (): ReviewState => {
      const state = makeState();
      state.findings = [
        {
          agent: 'static',
          severity: 'WARNING',
          confidence: 0.8,
          filePath: 'a.ts',
          lineStart: 1,
          lineEnd: 1,
          title: 'unused variable',
          description: 'desc',
          isFalsePositive: false,
        },
      ];
      return state;
    };
    const dir = mkdtempSync(join(tmpdir(), 'ai-review-modecfg-'));
    const configPath = join(dir, '.ai-review.yml');
    writeFileSync(
      configPath,
      stringifyYaml({ llm: { provider: 'mock' }, review: { mode: 'full', blockOn: 'WARNING' } }),
      'utf8',
    );
    const app = makeHarness(async () => warningState(), undefined, configPath);
    const { cookie } = await registerUser(app, 'boss');

    const started = await app.request('/api/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({ repoPath: 'D:/tmp/repo', mode: 'fast', blockOn: 'BLOCKER' }),
    });
    expect(started.status).toBe(202);
    const { reviewId }: { reviewId: string } = await started.json();

    await vi.waitFor(async () => {
      const detail = await app.request(`/api/reviews/${reviewId}`, { headers: auth(cookie) });
      expect(detail.status).toBe(200);
      const review = (await detail.json()) as { meta: { mode: string } };
      expect(review.meta.mode).toBe('fast');
    });
    // 显式 BLOCKER 覆盖配置 WARNING：仅 WARNING 发现 → blocking=false
    const body = await (
      await app.request(`/api/reviews/${reviewId}/events`, { headers: auth(cookie) })
    ).text();
    expect(body).toContain('"blocking":false');
  });

  it('serves the admin overview aggregation', async () => {
    const app = makeHarness(async () => makeState());
    const admin = await registerUser(app, 'boss');
    await registerUser(app, 'alice');
    await startReview(app, admin.cookie);

    await vi.waitFor(async () => {
      const res = await app.request('/api/admin/overview', { headers: auth(admin.cookie) });
      const { overview } = (await res.json()) as {
        overview: { userCount: number; adminCount: number; totalReviews: number };
      };
      expect(overview).toMatchObject({ userCount: 2, adminCount: 1, totalReviews: 1 });
    });
  });
});

describe('custom review rules API', () => {
  const rule = {
    name: 'no-todo',
    description: 'Forbid leftover TODO markers.',
    pattern: '\\bTODO\\b',
    flags: '',
    severity: 'WARNING',
    message: '',
    suggestion: '',
    filePatterns: [] as string[],
    matchScope: ['added'],
    enabled: true,
  };

  it('lists, saves and tests custom rules', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-review-rules-'));
    const configPath = join(dir, '.ai-review.yml');
    const app = makeHarness(async () => makeState(), undefined, configPath);
    const admin = await registerUser(app, 'boss');

    // 未配置时为空列表
    const empty = await app.request('/api/admin/rules', { headers: auth(admin.cookie) });
    expect(empty.status).toBe(200);
    expect((await empty.json()) as { rules: unknown[] }).toEqual({ rules: [] });

    // 保存一条规则并回读（持久化到配置文件）
    const saved = await app.request('/api/admin/rules', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth(admin.cookie) },
      body: JSON.stringify({ rules: [rule] }),
    });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as { rules: Array<{ name: string }> }).rules[0]?.name).toBe(
      'no-todo',
    );
    const listed = await app.request('/api/admin/rules', { headers: auth(admin.cookie) });
    expect(((await listed.json()) as { rules: Array<{ name: string }> }).rules).toHaveLength(1);

    // 试跑：新增行命中
    const tested = await app.request('/api/admin/rules/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.cookie) },
      body: JSON.stringify({
        rule,
        sampleDiffText: '+// TODO: fix me\n+const ok = 1;\n',
        sampleSource: '',
      }),
    });
    expect(tested.status).toBe(200);
    const { matches } = (await tested.json()) as {
      matches: Array<{ scope: string; line: number; text: string }>;
    };
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ scope: 'added', text: '// TODO: fix me' });

    // 非法正则返回 400
    const bad = await app.request('/api/admin/rules/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.cookie) },
      body: JSON.stringify({ rule: { ...rule, pattern: '(' }, sampleSource: '' }),
    });
    expect(bad.status).toBe(400);
  });

  it('rejects saving rules with an uncompilable regex', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-review-rules-'));
    const app = makeHarness(async () => makeState(), undefined, join(dir, '.ai-review.yml'));
    const admin = await registerUser(app, 'boss');
    const response = await app.request('/api/admin/rules', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...auth(admin.cookie) },
      body: JSON.stringify({ rules: [{ ...rule, name: 'broken', pattern: '(' }] }),
    });
    expect(response.status).toBe(400);
  });

  it('dedupes overlapping added/staged hits in the test endpoint', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-review-rules-'));
    const app = makeHarness(async () => makeState(), undefined, join(dir, '.ai-review.yml'));
    const admin = await registerUser(app, 'boss');
    const tested = await app.request('/api/admin/rules/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.cookie) },
      body: JSON.stringify({
        rule: { ...rule, matchScope: ['added', 'staged'] },
        sampleDiffText: '+// TODO: shared\n',
        sampleSource: 'const a = 1;\n// TODO: shared\n',
      }),
    });
    expect(tested.status).toBe(200);
    const { matches } = (await tested.json()) as {
      matches: Array<{ scope: string; line: number; text: string }>;
    };
    // 同文本跨范围命中只保留一条，且行号取 staged 的真实行号
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ scope: 'staged', line: 2, text: '// TODO: shared' });
  });

  it('rejects rule management for non-admin users', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-review-rules-'));
    const app = makeHarness(async () => makeState(), undefined, join(dir, '.ai-review.yml'));
    await registerUser(app, 'boss');
    const staff = await registerUser(app, 'staff');
    const response = await app.request('/api/admin/rules', { headers: auth(staff.cookie) });
    expect(response.status).toBe(403);
  });
});

describe('false-positive marking API', () => {
  it('persists the flag and reports 404 for unknown ids', async () => {
    const app = makeHarness(async () => makeState());
    const { cookie } = await registerUser(app, 'boss');
    const reviewId = await startReview(app, cookie);
    const detail: { findings: Array<{ id: number }> } = await (
      await app.request(`/api/reviews/${reviewId}`, { headers: auth(cookie) })
    ).json();
    const findingId = detail.findings[0]?.id;
    if (findingId === undefined) throw new Error('expected a finding row');

    const marked = await app.request(`/api/findings/${findingId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({ isFalsePositive: true }),
    });
    expect(marked.status).toBe(200);

    const report = await (
      await app.request(`/api/reviews/${reviewId}`, { headers: auth(cookie) })
    ).json();
    expect(report.findings[0].isFalsePositive).toBe(true);

    expect(
      (
        await app.request('/api/findings/999', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...auth(cookie) },
          body: JSON.stringify({ isFalsePositive: true }),
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await app.request('/api/findings/abc', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json', ...auth(cookie) },
          body: JSON.stringify({ isFalsePositive: true }),
        })
      ).status,
    ).toBe(400);
  });
});

describe('stats and metrics endpoints', () => {
  it('aggregates store statistics after a completed review', async () => {
    const app = makeHarness(async () => makeState());
    const { cookie } = await registerUser(app, 'boss');
    await startReview(app, cookie);

    await vi.waitFor(async () => {
      const response = await app.request('/api/stats', { headers: auth(cookie) });
      const { stats } = (await response.json()) as {
        stats: {
          totalReviews: number;
          totalFindings: number;
          severityDistribution: Array<{ severity: string; count: number }>;
        };
      };
      expect(stats.totalReviews).toBe(1);
      expect(stats.totalFindings).toBe(1);
      expect(stats.severityDistribution).toEqual([
        { severity: 'BLOCKER', count: 1 },
        { severity: 'WARNING', count: 0 },
        { severity: 'NIT', count: 0 },
        { severity: 'PRAISE', count: 0 },
      ]);
    });
  });

  it('serves prometheus metrics after completion and failure', async () => {
    const app = makeHarness(async () => {
      throw new Error('pipeline boom');
    });
    const { cookie } = await registerUser(app, 'boss');
    await startReview(app, cookie);

    await vi.waitFor(async () => {
      const body = await (await app.request('/metrics', { headers: auth(cookie) })).text();
      expect(body).toContain('ai_review_reviews_total{status="failed"} 1');
    });
  });
});

describe('review cache integration (方案 3.0 内容哈希去重)', () => {
  /** deep 分流 diff：敏感路径 30 + 大改动 25 + 删除守卫 20 = 75 分 */
  function makeDeepDiff(): string {
    return [
      'diff --git a/src/auth/login.ts b/src/auth/login.ts',
      'index 1111111..2222222 100644',
      '--- a/src/auth/login.ts',
      '+++ b/src/auth/login.ts',
      '@@ -1,2 +1,103 @@',
      ' const config = loadConfig();',
      '-  } catch (error) {',
      '+const cmd = exec(userInput);',
      ...Array.from({ length: 100 }, (_, i) => `+const value${i} = ${i};`),
      ' export function login() {}',
    ].join('\n');
  }

  function makeFakeGit(): GitRunner {
    return async (...args: string[]) => {
      const [command, second] = args;
      if (command === 'diff' && second === '--cached') return makeDeepDiff();
      if (command === 'show' && second !== undefined) {
        return 'const config = loadConfig();\nexport function login() {}\n';
      }
      if (command === 'branch') return 'main\n';
      throw new Error(`unexpected git invocation: ${args.join(' ')}`);
    };
  }

  function makeCacheHarness(): Harness {
    const sqlite = openSqlite(':memory:');
    const store = new ReviewStore(sqlite);
    const users = new UserStore(sqlite);
    const metrics = createReviewMetrics();
    const reviewCache = createStoreReviewCache(store);
    const service = new ReviewService(
      store,
      (repoPath, mode): PipelineDeps => ({
        gitReader: new GitReader(makeFakeGit()),
        rag: { query: async () => [] },
        ignores: { allows: () => true },
        history: { changeFrequency: async () => 0 },
        providers: {
          correctness: makeDeps(mode).providers.correctness,
          security: makeDeps(mode).providers.security,
          performance: makeDeps(mode).providers.performance,
        },
        registry: makeDeps(mode).registry,
        mode,
        reviewCache,
      }),
      runReviewPipeline,
      metrics,
    );
    return buildApp({
      store,
      users,
      service,
      metrics,
      registrationOpen: true,
      allowedRoots: ['D:/'],
    });
  }

  it('persists cache entries through the real pipeline across reviews', async () => {
    const app = makeCacheHarness();
    const { cookie } = await registerUser(app, 'boss');
    const post = (): Promise<Response> =>
      app.request('/api/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(cookie) },
        body: JSON.stringify({ repoPath: 'D:/tmp/repo', mode: 'full' }),
      });

    const first = (await (await post()).json()) as { reviewId: string };
    const second = (await (await post()).json()) as { reviewId: string };

    await vi.waitFor(async () => {
      const list = (await (
        await app.request('/api/reviews', { headers: auth(cookie) })
      ).json()) as {
        reviews: Array<{ reviewId: string }>;
      };
      expect(list.reviews).toHaveLength(2);
    });

    const firstReport = (await (
      await app.request(`/api/reviews/${first.reviewId}`, { headers: auth(cookie) })
    ).json()) as {
      findings: Array<{ title: string }>;
    };
    const secondReport = (await (
      await app.request(`/api/reviews/${second.reviewId}`, { headers: auth(cookie) })
    ).json()) as {
      findings: Array<{ title: string }>;
    };
    // 第二次审查对相同内容命中缓存，发现口径与首轮一致
    expect(secondReport.findings.map((f) => f.title)).toEqual(
      firstReport.findings.map((f) => f.title),
    );
  });
});

describe('SSE progress stream', () => {
  it('streams stage events and the terminal completed event', async () => {
    const gate = newGate();
    const app = makeHarness(makeGatedRunner(gate));
    const { cookie } = await registerUser(app, 'boss');
    const reviewId = await startReview(app, cookie);

    const streamResponse = app.request(`/api/reviews/${reviewId}/events`, {
      headers: auth(cookie),
    });
    // 等订阅建立后再放行流水线，保证事件落在订阅窗口内
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate.resolve();

    const body = await (await streamResponse).text();
    expect(body).toContain('event: stage');
    expect(body).toContain('"type":"stage"');
    expect(body).toContain('event: completed');
    expect(body).toContain('"blocking":true');
  });

  it('replays a terminal event when the client connects after completion', async () => {
    const app = makeHarness(async () => makeState());
    const { cookie } = await registerUser(app, 'boss');
    const reviewId = await startReview(app, cookie);

    await vi.waitFor(async () => {
      const detail = await app.request(`/api/reviews/${reviewId}`, { headers: auth(cookie) });
      expect(detail.status).toBe(200);
    });

    const body = await (
      await app.request(`/api/reviews/${reviewId}/events`, { headers: auth(cookie) })
    ).text();
    expect(body).toContain('event: completed');
    expect(body).toContain(`"reviewId":"${reviewId}"`);
  });

  it('streams the failed event when the pipeline throws', async () => {
    const gate = newGate();
    const app = makeHarness(async (_deps, options) => {
      await gate.promise;
      options.onNodeUpdate?.('parse', {});
      throw new Error('git repo invalid');
    });
    const { cookie } = await registerUser(app, 'boss');
    const reviewId = await startReview(app, cookie);

    const streamResponse = app.request(`/api/reviews/${reviewId}/events`, {
      headers: auth(cookie),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate.resolve();

    const body = await (await streamResponse).text();
    expect(body).toContain('event: failed');
    expect(body).toContain('git repo invalid');
  });
});

describe('hardening: rate limits, registration gating, repoPath, constant-time login, body caps', () => {
  /** 无 registrationOpen / allowedRoots 的默认配置 app（模拟生产默认行为） */
  function defaultHarness(runner: PipelineRunner = async () => makeState()): Harness {
    const sqlite = openSqlite(':memory:');
    const store = new ReviewStore(sqlite);
    const users = new UserStore(sqlite);
    const metrics = createReviewMetrics();
    const service = new ReviewService(store, makeDeps, runner, metrics);
    return buildApp({ store, users, service, metrics });
  }

  it('rate limits auth registration per IP+path (11th request in a minute -> 429)', async () => {
    const app = makeHarness(async () => makeState());
    // 无 socket 地址时 getClientIp 回退 x-forwarded-for；同 IP 独立计数
    const xff = { 'x-forwarded-for': '198.51.100.10' };
    for (let i = 0; i < 10; i += 1) {
      const res = await app.request('/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...xff },
        body: JSON.stringify({ username: `ratelimit-${i}`, password: 'password123' }),
      });
      expect(res.status).toBe(201);
    }
    const blocked = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...xff },
      body: JSON.stringify({ username: 'ratelimit-over', password: 'password123' }),
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).not.toBeNull();
  });

  it('throttles the generic /api/* surface (301st request -> 429)', async () => {
    const app = defaultHarness();
    const { cookie } = await registerUser(app, 'boss');
    // 用独立 IP 触发泛化限流，避免与注册共用计数
    const xff = { 'x-forwarded-for': '203.0.113.77' };
    const statuses: number[] = [];
    for (let i = 0; i < 301; i += 1) {
      const res = await app.request('/api/reviews', { headers: { ...auth(cookie), ...xff } });
      statuses.push(res.status);
    }
    expect(statuses[299]).toBe(200);
    expect(statuses[300]).toBe(429);
  });

  it('gates open registration after the first admin exists (production default)', async () => {
    const app = defaultHarness();
    const first = await registerUser(app, 'founder');
    expect(first.role).toBe('admin');
    // 第二个自注册：默认已关闭 → 403
    const second = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'sneaker', password: 'password123' }),
    });
    expect(second.status).toBe(403);
  });

  it('forbids registration when registrationOpen is explicitly false', async () => {
    const sqlite = openSqlite(':memory:');
    const store = new ReviewStore(sqlite);
    const users = new UserStore(sqlite);
    const metrics = createReviewMetrics();
    const service = new ReviewService(store, makeDeps, async () => makeState(), metrics);
    const app = buildApp({ store, users, service, metrics, registrationOpen: false });
    const res = await app.request('/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: 'password123' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects repoPath outside the allowed workspace roots', async () => {
    // 默认根 = cwd；绝对逃逸路径（两平台均绝对）应被拒绝
    const app = defaultHarness();
    const { cookie } = await registerUser(app, 'boss');
    for (const repoPath of ['/etc/passwd', '../..']) {
      const res = await app.request('/api/reviews', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(cookie) },
        body: JSON.stringify({ repoPath, mode: 'fast' }),
      });
      expect(res.status).toBe(400);
    }
    // 白名单根之外的路径同样拒绝。注意：Windows 上 `resolve('/etc/passwd')` 会得到
    // `<当前盘符>:\etc\passwd`，落在 `D:/` 之内，因此这里用一个明确不在白名单内的根。
    const sqlite = openSqlite(':memory:');
    const store = new ReviewStore(sqlite);
    const users = new UserStore(sqlite);
    const metrics = createReviewMetrics();
    const service = new ReviewService(store, makeDeps, async () => makeState(), metrics);
    const app2 = buildApp({
      store,
      users,
      service,
      metrics,
      registrationOpen: true,
      allowedRoots: ['D:/allowed-only'],
    });
    const { cookie: cookie2 } = await registerUser(app2, 'boss');
    const res2 = await app2.request('/api/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(cookie2) },
      body: JSON.stringify({ repoPath: '/etc/passwd', mode: 'fast' }),
    });
    expect(res2.status).toBe(400);
  });

  it('keeps login timing constant for unknown usernames (dummy scrypt verify runs)', async () => {
    const app = makeHarness(async () => makeState());
    await registerUser(app, 'timinguser');
    // 预热：首次未知用户登录会一次性计算哑哈希，随后缓存
    const warm = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
      body: JSON.stringify({ username: 'warmup-user', password: 'wrong-password-123' }),
    });
    expect(warm.status).toBe(401);

    const sampleMedian = async (username: string, base: number): Promise<number> => {
      const times: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const start = performance.now();
        const res = await app.request('/api/auth/login', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-forwarded-for': `10.0.0.${base + i}`,
          },
          body: JSON.stringify({ username, password: 'wrong-password-123' }),
        });
        times.push(performance.now() - start);
        expect(res.status).toBe(401);
      }
      return times.sort((a, b) => a - b)[2];
    };

    const unknownMedian = await sampleMedian('no-such-user-xyz', 100);
    const wrongMedian = await sampleMedian('timinguser', 200);
    // 恒时化：未知用户名与错误密码耗时同量级（宽松 4x 上限防 CI 抖动）；
    // 修复前未知用户短路跳过 scrypt（耗时 <1ms），该断言必失败
    expect(unknownMedian).toBeGreaterThan(wrongMedian / 4);
    // scrypt 至少 ~30ms：防哑校验被跳过或短路回归
    expect(unknownMedian).toBeGreaterThan(15);
  });

  it('rejects chunked bodies without Content-Length via streaming byte counting', async () => {
    const app = defaultHarness();
    // 无 Content-Length 的流式请求体（chunked 语义）：旧实现直接放行，现在按实际字节封顶
    const payload = new TextEncoder().encode('x'.repeat(1536 * 1024));
    const req = new Request('http://local/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(payload);
          controller.close();
        },
      }),
      duplex: 'half',
    });
    const res = await app.request(req);
    expect(res.status).toBe(413);
    expect(await res.text()).toContain('请求体过大');
  });

  it('replays completed blocking per the original blockOn threshold', async () => {
    // WARNING 发现（无 BLOCKER）：blockOn=NIT 时实时与重放都应判为阻断
    const warningState = (): ReviewState => {
      const state = makeState();
      state.findings = [
        {
          agent: 'static',
          severity: 'WARNING',
          confidence: 0.8,
          filePath: 'a.ts',
          lineStart: 1,
          lineEnd: 1,
          title: 'unused variable',
          description: 'desc',
          isFalsePositive: false,
        },
      ];
      return state;
    };
    const app = makeHarness(async () => warningState());
    const { cookie } = await registerUser(app, 'boss');
    const started = await app.request('/api/reviews', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(cookie) },
      body: JSON.stringify({ repoPath: 'D:/tmp/repo', mode: 'fast', blockOn: 'NIT' }),
    });
    expect(started.status).toBe(202);
    const { reviewId }: { reviewId: string } = await started.json();
    await vi.waitFor(async () => {
      const detail = await app.request(`/api/reviews/${reviewId}`, { headers: auth(cookie) });
      expect(detail.status).toBe(200);
    });
    // 晚连接重放：blocking 按发起时阈值（NIT）重算 → true（修复前 blockerCount=0 → false）
    const body = await (
      await app.request(`/api/reviews/${reviewId}/events`, { headers: auth(cookie) })
    ).text();
    expect(body).toContain('event: completed');
    expect(body).toContain('"blocking":true');
  });
});

describe('hardening: queued review cancellation', () => {
  it('finalizes a queued review as cancelled immediately (no slot wait)', async () => {
    const previous = process.env.AI_REVIEW_MAX_CONCURRENT;
    process.env.AI_REVIEW_MAX_CONCURRENT = '1';
    const gate = newGate();
    const app = makeHarness(makeGatedRunner(gate));
    if (previous === undefined) delete process.env.AI_REVIEW_MAX_CONCURRENT;
    else process.env.AI_REVIEW_MAX_CONCURRENT = previous;

    const { cookie } = await registerUser(app, 'boss');
    const firstId = await startReview(app, cookie); // 占用唯一槽位（gate 未放行）
    const queuedId = await startReview(app, cookie); // 排队

    const cancel = await app.request(`/api/reviews/${queuedId}/cancel`, {
      method: 'POST',
      headers: auth(cookie),
    });
    expect(cancel.status).toBe(200);

    // 排队任务被取消：立即落库并广播 cancelled（SSE 晚连接可重放）
    const body = await (
      await app.request(`/api/reviews/${queuedId}/events`, { headers: auth(cookie) })
    ).text();
    expect(body).toContain('event: cancelled');

    // 释放 gate 让第一个任务正常完成，避免悬挂
    gate.resolve();
    await vi.waitFor(async () => {
      const detail = await app.request(`/api/reviews/${firstId}`, { headers: auth(cookie) });
      expect(detail.status).toBe(200);
    });
  });
});

describe('审计日志（登录日志 + 操作日志）', () => {
  it('records login success and failure with reasons into login logs', async () => {
    const { app } = makeAuditedHarness(async () => makeState());
    const admin = await registerUser(app, 'boss');

    // 登录成功
    const ok = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'password123' }),
    });
    expect(ok.status).toBe(200);

    // 登录失败（错误密码）—— 审计必记，含原因与 IP
    const bad = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'boss', password: 'wrong-password' }),
    });
    expect(bad.status).toBe(401);

    // 失败筛选
    const failedRes = await app.request('/api/admin/login-logs?status=failed', {
      headers: auth(admin.cookie),
    });
    expect(failedRes.status).toBe(200);
    const failedBody = (await failedRes.json()) as {
      logs: Array<{ username: string; action: string; status: string; reason: string; ip: string }>;
      total: number;
    };
    expect(failedBody.total).toBe(1);
    expect(failedBody.logs[0]).toMatchObject({
      username: 'boss',
      action: 'login',
      status: 'failed',
      reason: 'invalid-password',
    });
    expect(failedBody.logs[0]?.ip).toBeTruthy();

    // 全部登录日志：register + login 成功 + login 失败
    const allRes = await app.request('/api/admin/login-logs', { headers: auth(admin.cookie) });
    const allBody = (await allRes.json()) as { total: number };
    expect(allBody.total).toBe(3);
  });

  it('records admin writes and review operations into operation logs', async () => {
    const { app } = makeAuditedHarness(async () => makeState());
    const admin = await registerUser(app, 'boss');

    // 管理员创建用户
    const created = await app.request('/api/admin/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth(admin.cookie) },
      body: JSON.stringify({ username: 'carol', password: 'password123' }),
    });
    expect(created.status).toBe(201);

    // 发起审查（handler 同步落审计，无需等待流水线完成）
    const reviewId = await startReview(app, admin.cookie);

    const res = await app.request('/api/admin/operation-logs?pageSize=50', {
      headers: auth(admin.cookie),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      logs: Array<{
        action: string;
        resource: string;
        resourceId: string;
        detail: string;
        username: string;
      }>;
      total: number;
    };
    // boss 注册 + carol 创建 + 发起审查
    expect(body.total).toBe(3);
    expect(
      body.logs.some(
        (log) => log.action === 'create' && log.resource === 'user' && log.detail.includes('carol'),
      ),
    ).toBe(true);
    expect(
      body.logs.some((log) => log.action === 'start_review' && log.resourceId === reviewId),
    ).toBe(true);
  });

  it('paginates and filters operation logs', async () => {
    const { app } = makeAuditedHarness(async () => makeState());
    const admin = await registerUser(app, 'boss');
    for (const name of ['user1', 'user2', 'user3']) await registerUser(app, name);

    const page1 = await app.request('/api/admin/operation-logs?page=1&pageSize=2', {
      headers: auth(admin.cookie),
    });
    const page1Body = (await page1.json()) as { logs: unknown[]; total: number; page: number };
    expect(page1Body.total).toBe(4); // 4 次注册
    expect(page1Body.logs).toHaveLength(2);
    expect(page1Body.page).toBe(1);

    const page2 = await app.request('/api/admin/operation-logs?page=2&pageSize=2', {
      headers: auth(admin.cookie),
    });
    const page2Body = (await page2.json()) as { logs: unknown[]; page: number };
    expect(page2Body.logs).toHaveLength(2);
    expect(page2Body.page).toBe(2);

    const byAction = await app.request('/api/admin/operation-logs?action=register', {
      headers: auth(admin.cookie),
    });
    const byActionBody = (await byAction.json()) as { total: number };
    expect(byActionBody.total).toBe(4);
  });

  it('restricts log pages to admins with the matching permission', async () => {
    const { app } = makeAuditedHarness(async () => makeState());
    await registerUser(app, 'boss');
    // 普通用户无 /admin/login-logs 权限
    const alice = await registerUser(app, 'alice');
    const res = await app.request('/api/admin/login-logs', { headers: auth(alice.cookie) });
    expect(res.status).toBe(403);
    const resOp = await app.request('/api/admin/operation-logs', { headers: auth(alice.cookie) });
    expect(resOp.status).toBe(403);
  });
});
