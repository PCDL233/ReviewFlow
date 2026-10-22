import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve as resolvePath, sep } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { compress } from 'hono/compress';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { HookTokenStore, SafeUser, ReviewStore, UserStore } from '@ai-review/db';
import { StoreError } from '@ai-review/db';
import {
  AdminOverviewResponseSchema,
  AdminUserPatchSchema,
  AdminCreateUserSchema,
  AuthResponseSchema,
  UserListResponseSchema,
  RoleInputSchema,
  RoleListResponseSchema,
  RoleResponseSchema,
  AssignRolesSchema,
  ReviewListQuerySchema,
  ReviewStatsQuerySchema,
  ReviewDiffResponseSchema,
  ReviewTraceResponseSchema,
  LlmCallListQuerySchema,
  LlmCallListResponseSchema,
  FindingUpdateSchema,
  FindingCommentCreateSchema,
  FindingCommentListResponseSchema,
  ReviewDecisionRequestSchema,
  ReviewDecisionResponseSchema,
  PrCommentWriteRequestSchema,
  PrCommentWriteResponseSchema,
  ReviewDecisionHistoryResponseSchema,
  ReviewCompareResponseSchema,
  RuleHitStatsResponseSchema,
  DeleteReviewResponseSchema,
  CancelReviewResponseSchema,
  AdminConfigSchema,
  AdminConfigResponseSchema,
  AdminRulesResponseSchema,
  AdminRulesUpdateSchema,
  CustomRuleTestRequestSchema,
  CustomRuleTestResultSchema,
  LoginLogQuerySchema,
  LoginLogListResponseSchema,
  OperationLogQuerySchema,
  OperationLogListResponseSchema,
  AiReviewConfigSchema,
  KnowledgeReindexResponseSchema,
  KnowledgeStatusResponseSchema,
  StartReviewSchema,
  RepoQuerySchema,
  RepositoryListResponseSchema,
  RepoStatusResponseSchema,
  RepoBranchListResponseSchema,
  RepoCommitListResponseSchema,
  HookTokenListResponseSchema,
  CreateHookTokenSchema,
  CreateHookTokenResponseSchema,
  HookScriptSchema,
  InstallHookSchema,
  InstallHookResponseSchema,
  HookReviewRequestSchema,
  HookReviewResponseSchema,
  describeReviewSource,
  EXIT_CODES,
} from '@ai-review/shared';
import { ensureFindingFingerprint } from '@ai-review/shared';
import type { ReviewSource, ServerRuntime } from '@ai-review/shared';
import { renderHtml, renderJson, renderMarkdown, renderPrComment } from '@ai-review/report';
import {
  analyzeComplexity,
  compileCustomRulePattern,
  scanDiffTextForSecrets,
  testCustomRuleOnSamples,
} from '@ai-review/tools';
import {
  createRequireAuth,
  generateRandomPassword,
  hashPassword,
  registerAuthRoutes,
  requireAnyPermission,
  requirePermission,
} from './auth.js';
import type { ReviewMetrics } from './metrics.js';
import type { ReviewStageEvent } from './review-service.js';
import { AvatarError, AvatarStore, AVATAR_MAX_BYTES } from './avatar.js';
import { createRateLimiter, getClientIp } from './rate-limit.js';
import { securityHeaders } from './security-headers.js';
import { AuditService, createNoopAudit } from './audit.js';
import type { ReviewService } from './review-service.js';
import { RepoService, uniqueRepoPaths } from './repos.js';
import { buildHookScripts, installHookFiles } from './hooks.js';
import { handleMcpRequest } from './mcp.js';

/** POST /api/reviews 入参由 shared 的 StartReviewSchema 提供（含 target/base/commit） */

/** PATCH /api/findings/:id 入参（Dashboard 误报标记回写） */
export const FalsePositiveSchema = z.object({ isFalsePositive: z.boolean() });

/** Hono 环境类型：requireAuth 之后可从 Context 读取登录用户 */
export type AppEnv = {
  Variables: { user: SafeUser };
};

export type AppDeps = {
  store: ReviewStore;
  users: UserStore;
  service: ReviewService;
  metrics: ReviewMetrics;
  /** 管理员配置文件位置；未提供时使用当前目录 .ai-review.yml */
  configPath?: string;
  /** 允许审查的仓库根目录（方案 3：防任意本地路径读取）；缺省为 process.cwd() */
  allowedRoots?: readonly string[];
  /** 是否允许开放注册（方案 8）；缺省：已存在用户后关闭 */
  registrationOpen?: boolean;
  /** 会话 Cookie 是否携带 Secure；缺省：生产环境自动开启 */
  cookieSecure?: boolean;
  /** 反向代理部署时信任 X-Forwarded-For（限流/审计共用） */
  trustProxy?: boolean;
  /** 服务端运行环境只读信息（端口/DB 路径/静态目录等），供配置页展示 */
  runtime?: ServerRuntime;
  /** 可选知识库管理器，未装配时返回 idle 状态 */
  knowledge?: KnowledgeManager;
  /** 可选头像存储；未装配时头像上传返回 503 */
  avatars?: AvatarStore;
  /** 审计日志服务（登录日志 + 操作日志）；未装配时静默跳过 */
  audit?: AuditService;
  /** Hook / CI 令牌存储；未装配时 Hook 相关接口返回 503 */
  hookTokens?: HookTokenStore;
  /** Hook/CI 同步审查超时（毫秒）；缺省 120s */
  hookTimeoutMs?: number;
  /** 是否暴露 /api/mcp；缺省关闭 */
  mcpEnabled?: boolean;
};

export type KnowledgeManager = {
  getStatus(repoPath?: string): Promise<unknown> | unknown;
  reindex(repoPath?: string): Promise<void>;
};

/** SSE 桥接队列：ReviewService 的同步广播 → streamSSE 的异步消费 */
class EventQueue<T> {
  private readonly items: T[] = [];
  private resolvers: Array<() => void> = [];

  public push(item: T): void {
    this.items.push(item);
    this.resolvers.shift()?.();
  }

  public next(): Promise<T | undefined> {
    const immediate = this.items.shift();
    if (immediate !== undefined) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      this.resolvers.push(() => resolve(this.items.shift()));
    });
  }

  /** 唤醒所有等待者（返回 undefined 表示队列关闭） */
  public close(): void {
    for (const resolve of this.resolvers.splice(0)) resolve();
  }
}

/**
 * 组装 Hono REST + SSE 应用（方案 3.9/3.10 的服务端契约）。
 * 路由一览：
 * - POST /api/auth/register    注册（首个用户自动 admin）
 * - POST /api/auth/login       登录（建立 Cookie 会话）
 * - POST /api/auth/logout      登出
 * - GET  /api/auth/me          当前用户
 * - POST /api/auth/change-password  改密（吊销全部旧会话）
 * - POST /api/reviews          触发审查（202 + reviewId，记录发起人）
 * - GET  /api/reviews          审查历史列表（普通用户仅本人记录）
 * - GET  /api/reviews/:id      报告详情（五段式 + 行级 findings）
 * - GET  /api/reviews/:id/events  实时进度 SSE
 * - PATCH /api/findings/:id    误报标记回写
 * - GET  /api/stats            统计聚合（普通用户仅本人数据）
 * - GET  /api/admin/users      用户管理（admin）
 * - PATCH /api/admin/users/:id 角色与状态管理（admin）
 * - POST /api/admin/users/:id/reset-password  重置密码（admin）
 * - DELETE /api/admin/users/:id  删除用户（admin）
 * - GET  /api/admin/overview   系统概览聚合（admin）
 * - POST /api/admin/init-config 生成默认配置文件（admin）
 * - GET  /api/admin/login-logs     登录日志（admin，分页+筛选）
 * - GET  /api/admin/operation-logs 操作日志（admin，分页+筛选）
 * - GET  /api/admin/rules     自定义审查规则列表（admin）
 * - PUT  /api/admin/rules     保存自定义审查规则（admin）
 * - POST /api/admin/rules/test 试跑自定义审查规则（admin）
 * - POST /api/admin/tools/secret-scan diff 密钥扫描（admin）
 * - POST /api/admin/tools/complexity 源码复杂度扫描（admin）
 * - GET  /api/admin/tools/complexity 源码复杂度扫描（admin）
 * - GET  /api/admin/hooks/script  获取 hook 脚本（admin）
 * - POST /api/admin/hooks/install 在仓库内安装 hook（admin）
 * - POST /api/hooks/review        同步审查（Bearer 令牌，返回退出码）
 * - GET  /api/repos               仓库发现（登录用户）
 * - GET  /metrics              Prometheus 指标（admin）
 */
/**
 * 校验 repoPath 是否落在允许的根目录内（方案 3）：
 * 拒绝空路径、绝对路径逃逸到允许根之外的情况，防任意本地目录/文件读取。
 * 存在路径先经 realpath 解析再比较——符号链接指向白名单之外时必须被拒绝，
 * 否则 `allowedRoots` 可被一条指向 / 的软链绕过。
 */
export function assertRepoPathAllowed(
  repoPath: string,
  roots: readonly string[] = [process.cwd()],
): void {
  if (repoPath === '') throw new Error('repoPath must not be empty');
  const resolved = canonicalize(resolvePath(repoPath));
  for (const root of roots) {
    const rootResolved = canonicalize(resolvePath(root));
    // 目录边界：根目录本身或其子路径合法；根目录已以分隔符结尾（如 Windows 'D:/'→'D:\\'）时不重复追加
    const boundary = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
    if (resolved === rootResolved || resolved.startsWith(boundary)) return;
  }
  throw new Error('repoPath is outside the allowed workspace roots');
}

/** 解析符号链接；路径不存在（尚未创建/已删除）时退回原始路径，保证校验不因 ENOENT 放行 */
function canonicalize(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * 把扁平的请求体（target/base/commit）折算为判别式 ReviewSource。
 * 参数缺失时给出可读错误而不是抛 zod 异常——旧客户端只传 repoPath 仍然可用。
 * @param body POST /api/reviews 的请求体
 * @returns 成功时带 source，失败时带人类可读的错误
 */
export function toReviewSource(body: {
  target?: string | undefined;
  base?: string | undefined;
  commit?: string | undefined;
}): { ok: true; source: ReviewSource } | { ok: false; error: string } {
  const target = body.target ?? 'staged';
  if (target === 'staged' || target === 'worktree') return { ok: true, source: { target } };
  if (target === 'commit') {
    if (body.commit === undefined || body.commit === '') {
      return { ok: false, error: '审查单个提交时必须指定 commit' };
    }
    return { ok: true, source: { target: 'commit', commit: body.commit } };
  }
  if (target === 'range') {
    if (body.base === undefined || body.base === '') {
      return { ok: false, error: '审查提交区间时必须指定 base' };
    }
    return { ok: true, source: { target: 'range', base: body.base } };
  }
  return { ok: false, error: `不支持的审查目标：${target}` };
}

/**
 * 请求体大小上限（方案 2：防内存 DoS）。
 * - 有 Content-Length：先按头快速拒绝（读 body 前拦截）
 * - 无论有无 CL 均逐块计数实际字节：修复 chunked/伪造 CL 绕过，超限即断流 413；
 *   未超限则回填等价 Request，供后续 zValidator / formData 正常解析
 * - exempt：对该路径跳过（avatar 有专属上限）
 */
function limitBody(maxBytes: number, exempt?: (path: string) => boolean) {
  return async (c: import('hono').Context, next: () => Promise<void>) => {
    if (exempt !== undefined && exempt(c.req.path)) return next();
    const raw = c.req.raw;
    if (raw.body === null || raw.method === 'GET' || raw.method === 'HEAD') return next();
    const declared = c.req.header('content-length');
    if (declared !== undefined) {
      const length = Number(declared);
      // CL 仅作快速拒绝；真实体积仍按流计数（声明值可与 chunked 实际体积不符）
      if (Number.isFinite(length) && length > maxBytes) {
        return c.json({ error: '请求体过大' }, 413);
      }
    }
    const reader = raw.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done === true) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return c.json({ error: '请求体过大' }, 413);
      }
      chunks.push(value);
    }
    // 回填等价 Request（Blob 体，无 CL 依赖），后续 c.req.json()/formData() 从它读取
    const headers = new Headers(raw.headers);
    headers.set('content-length', String(total));
    c.req.raw = new Request(raw.url, { method: raw.method, headers, body: new Blob(chunks) });
    await next();
  };
}

// 响应压缩（方案 12）：模块级创建一次复用；SSE 端点在挂载处跳过，避免破坏流式分块
const gzipMiddleware = compress({ encoding: 'gzip' });

export function buildApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // 审计日志：未装配时使用空实现（写路径 no-op、查询返回空页），既有调用方无需感知
  const audit = deps.audit ?? createNoopAudit();
  // 审计埋点用请求元信息：客户端 IP（与限流同一判定）与 User-Agent
  const requestMeta = (c: import('hono').Context): { ip: string; userAgent: string } => ({
    ip: getClientIp(c, deps.trustProxy),
    userAgent: c.req.header('user-agent') ?? '',
  });
  const actor = (c: import('hono').Context): { userId: string; username: string } => {
    const user = c.get('user');
    return { userId: user.id, username: user.username };
  };

  // —— 全局安全响应头（方案 5）——
  app.use('*', securityHeaders());

  // —— 响应压缩（方案 12）：跳过 SSE 实时事件端点，避免破坏流式分块 ——
  app.use('*', async (c, next) => {
    if (c.req.path.endsWith('/events')) return next();
    return gzipMiddleware(c, next);
  });

  // —— /api/* 泛化限流（方案 1：认证端点另有更严限流）——
  app.use('/api/*', createRateLimiter({ windowMs: 60_000, max: 300 }));

  // —— /api/* 请求体大小上限（方案 2）：avatar 路由有专属上限（2MB+multipart 开销），在此豁免 ——
  app.use('/api/auth/avatar', limitBody(AVATAR_MAX_BYTES + 256 * 1024));
  app.use(
    '/api/*',
    limitBody(1024 * 1024, (path) => path === '/api/auth/avatar'),
  );

  // —— 认证路由（匿名可访问 + me/change-password 自带 requireAuth）——
  registerAuthRoutes(app, {
    users: deps.users,
    audit,
    ...(deps.registrationOpen === undefined ? {} : { registrationOpen: deps.registrationOpen }),
    ...(deps.cookieSecure === undefined ? {} : { cookieSecure: deps.cookieSecure }),
    ...(deps.trustProxy === undefined ? {} : { trustProxy: deps.trustProxy }),
  });

  // —— 数据隔离：除 auth 前缀外所有 /api 请求必须登录 ——
  // /api/hooks/*（Hook/CI 同步审查）与 /api/mcp（MCP over HTTP）改用 Bearer 令牌，
  // 它们由 git hook / CI / MCP 客户端调用，无法携带浏览器 Cookie。
  const requireAuth = createRequireAuth({ users: deps.users });
  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/auth/')) return next();
    if (c.req.path.startsWith('/api/hooks/')) return next();
    if (c.req.path === '/api/mcp') return next();
    return requireAuth(c, next);
  });

  // 头像上传：仅本人（requireAuth），multipart 表单字段名为 avatar。
  // /api/auth/* 被上方全局中间件放行，故在此显式挂 requireAuth。
  app.post('/api/auth/avatar', createRequireAuth({ users: deps.users }), async (c) => {
    if (deps.avatars === undefined) {
      return c.json({ error: '头像存储未配置，请联系管理员' }, 503);
    }
    // 读取前按 Content-Length 前置拦截，避免超大 multipart 被整体读入内存（方案 2）；
    // chunked / 无 CL 请求由上方 limitBody 流式计数兜底
    const avatarContentLength = Number(c.req.header('content-length') ?? 0);
    if (
      Number.isFinite(avatarContentLength) &&
      avatarContentLength > AVATAR_MAX_BYTES + 256 * 1024
    ) {
      return c.json({ error: '图片大小不能超过 2MB' }, 413);
    }
    let body: FormData;
    try {
      body = await c.req.formData();
    } catch {
      return c.json({ error: '图片上传数据无效，请重新选择图片' }, 400);
    }
    const file = body.get('avatar');
    if (!(file instanceof File)) {
      return c.json({ error: '未接收到头像文件' }, 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.byteLength > AVATAR_MAX_BYTES) {
      return c.json({ error: '图片大小不能超过 2MB' }, 413);
    }
    try {
      deps.avatars.save(c.get('user').id, bytes);
    } catch (e) {
      if (e instanceof AvatarError) return c.json({ error: e.message }, 400);
      throw e;
    }
    deps.users.setAvatarUrl(c.get('user').id, `/api/users/${c.get('user').id}/avatar`);
    const user = deps.users.getById(c.get('user').id);
    if (user === undefined) return c.json({ error: '用户不存在' }, 404);
    return c.json(AuthResponseSchema.parse({ user }));
  });

  // 头像读取：登录可见（业务侧可读任何用户头像，供后台列表展示）
  app.get('/api/users/:id/avatar', (c) => {
    if (deps.avatars === undefined) return c.json({ error: '头像存储未配置，请联系管理员' }, 503);
    const target = deps.users.getById(c.req.param('id'));
    if (target === undefined || target.avatarUrl === null)
      return c.json({ error: '头像不存在' }, 404);
    const avatar = deps.avatars.read(target.id);
    if (avatar === null) return c.json({ error: '头像不存在' }, 404);
    return c.body(avatar.buffer, 200, {
      'content-type': avatar.mime,
      'cache-control': 'no-store',
    });
  });

  // Prometheus 拉取端点：仅 admin 可读（审查量与 token 成本属团队敏感数据）
  app.get('/metrics', requireAuth, requirePermission('/admin/metrics'), async (c) =>
    c.text(await deps.metrics.render(), 200, { 'content-type': 'text/plain; version=0.0.4' }),
  );

  app.post('/api/reviews', zValidator('json', StartReviewSchema), (c) => {
    const body = c.req.valid('json');
    const meta = requestMeta(c);
    const me = actor(c);
    // 未显式选择模式/阻断阈值时回退系统配置默认值（config.review.mode / blockOn），
    // 保证管理后台「默认审查模式/阻断阈值」对 web 发起的审查生效
    const liveConfig = readAdminConfig(deps.configPath ?? '.ai-review.yml');
    const mode = body.mode ?? liveConfig.review.mode;
    const blockOn = body.blockOn ?? liveConfig.review.blockOn;
    // 审查来源：旧客户端不带 target 时按 staged 处理（保持既有语义）
    const sourceResult = toReviewSource(body);
    if (!sourceResult.ok) {
      audit.operation({
        ...me,
        ...meta,
        action: 'start_review',
        resource: 'review',
        detail: JSON.stringify({ repoPath: body.repoPath, mode }),
        status: 'failed',
        reason: 'invalid-target',
      });
      return c.json({ error: sourceResult.error }, 400);
    }
    // 方案 3：仅允许审查落在白名单根目录内的仓库，防任意本地路径读取
    try {
      assertRepoPathAllowed(body.repoPath, deps.allowedRoots ?? [process.cwd()]);
    } catch {
      audit.operation({
        ...me,
        ...meta,
        action: 'start_review',
        resource: 'review',
        detail: JSON.stringify({ repoPath: body.repoPath, mode }),
        status: 'failed',
        reason: 'path-not-allowed',
      });
      return c.json({ error: '仓库路径不在允许的目录白名单内' }, 400);
    }
    const createdBy = c.get('user').id;
    const reviewId = deps.service.startReview({
      repoPath: body.repoPath,
      mode,
      createdBy,
      blockOn,
      source: sourceResult.source,
      includePraise: body.includePraise ?? liveConfig.report.includePraise,
      ...(body.dimensions === undefined ? {} : { dimensions: body.dimensions }),
      ...(body.maxFiles === undefined ? {} : { maxFiles: body.maxFiles }),
      ...(body.maxChangedLines === undefined ? {} : { maxChangedLines: body.maxChangedLines }),
      ...(body.toolCalling === undefined ? {} : { toolCalling: body.toolCalling }),
    });
    audit.operation({
      ...me,
      ...meta,
      action: 'start_review',
      resource: 'review',
      resourceId: reviewId,
      detail: JSON.stringify({
        repoPath: body.repoPath,
        mode,
        source: describeReviewSource(sourceResult.source),
      }),
      status: 'success',
    });
    return c.json({ reviewId }, 202);
  });

  // 数据隔离：admin 可见全部；普通用户仅见本人发起的记录，筛选与分页在数据库侧完成
  app.get('/api/reviews', zValidator('query', ReviewListQuerySchema), (c) => {
    const current = c.get('user');
    const queryParams = c.req.query();
    const query = c.req.valid('query');
    const page = deps.store.listReviewPage(
      query,
      current.role === 'admin' ? undefined : current.id,
    );
    // 保留无参数旧客户端的响应形状；显式分页参数使用完整分页契约。
    if (Object.keys(queryParams).length === 0) return c.json({ reviews: page.reviews });
    return c.json(page);
  });

  app.get('/api/reviews/:id/diff', (c) => {
    const current = c.get('user');
    const reviewId = c.req.param('id');
    if (!canAccessReview(deps, current, reviewId)) return c.json({ error: '审查记录不存在' }, 404);
    try {
      return c.json(ReviewDiffResponseSchema.parse({ diffText: deps.store.getDiff(reviewId) }));
    } catch (e) {
      if (e instanceof StoreError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  app.post('/api/reviews/:id/rerun', (c) => {
    const current = c.get('user');
    const reviewId = c.req.param('id');
    const meta = requestMeta(c);
    if (!canAccessReview(deps, current, reviewId)) {
      audit.operation({
        userId: current.id,
        username: current.username,
        ...meta,
        action: 'rerun_review',
        resource: 'review',
        resourceId: reviewId,
        status: 'failed',
        reason: 'not-found',
      });
      return c.json({ error: '审查记录不存在' }, 404);
    }
    try {
      const newReviewId = deps.service.rerunReview(reviewId, current.id);
      audit.operation({
        userId: current.id,
        username: current.username,
        ...meta,
        action: 'rerun_review',
        resource: 'review',
        resourceId: reviewId,
        detail: JSON.stringify({ newReviewId }),
        status: 'success',
      });
      return c.json({ reviewId: newReviewId }, 202);
    } catch (e) {
      if (e instanceof StoreError) {
        audit.operation({
          userId: current.id,
          username: current.username,
          ...meta,
          action: 'rerun_review',
          resource: 'review',
          resourceId: reviewId,
          status: 'failed',
          reason: 'not-found',
        });
        return c.json({ error: e.message }, 404);
      }
      throw e;
    }
  });

  app.post('/api/reviews/:id/cancel', (c) => {
    const current = c.get('user');
    const reviewId = c.req.param('id');
    const meta = requestMeta(c);
    if (!canAccessReview(deps, current, reviewId)) {
      audit.operation({
        userId: current.id,
        username: current.username,
        ...meta,
        action: 'cancel_review',
        resource: 'review',
        resourceId: reviewId,
        status: 'failed',
        reason: 'not-found',
      });
      return c.json({ error: '审查记录不存在' }, 404);
    }
    if (!deps.service.cancelReview(reviewId)) {
      audit.operation({
        userId: current.id,
        username: current.username,
        ...meta,
        action: 'cancel_review',
        resource: 'review',
        resourceId: reviewId,
        status: 'failed',
        reason: 'already-terminal',
      });
      return c.json({ error: '审查任务已结束或不存在' }, 409);
    }
    audit.operation({
      userId: current.id,
      username: current.username,
      ...meta,
      action: 'cancel_review',
      resource: 'review',
      resourceId: reviewId,
      status: 'success',
    });
    return c.json(CancelReviewResponseSchema.parse({ cancelled: true }));
  });

  app.delete('/api/reviews/:id', (c) => {
    const current = c.get('user');
    const reviewId = c.req.param('id');
    const meta = requestMeta(c);
    if (!canAccessReview(deps, current, reviewId)) {
      audit.operation({
        userId: current.id,
        username: current.username,
        ...meta,
        action: 'delete_review',
        resource: 'review',
        resourceId: reviewId,
        status: 'failed',
        reason: 'not-found',
      });
      return c.json({ error: '审查记录不存在' }, 404);
    }
    const deleted = deps.store.deleteReview(reviewId);
    audit.operation({
      userId: current.id,
      username: current.username,
      ...meta,
      action: 'delete_review',
      resource: 'review',
      resourceId: reviewId,
      status: deleted ? 'success' : 'failed',
      ...(deleted ? {} : { reason: 'not-found' }),
    });
    return c.json(DeleteReviewResponseSchema.parse({ deleted }));
  });

  app.get('/api/reviews/:id/export', (c) => {
    const current = c.get('user');
    const reviewId = c.req.param('id');
    if (!canAccessReview(deps, current, reviewId)) return c.json({ error: '审查记录不存在' }, 404);
    const requested = c.req.query('format');
    // 未显式指定时使用配置的 report.format（此前该配置项从未被消费）
    const format = requested ?? readAdminConfig(deps.configPath ?? '.ai-review.yml').report.format;
    if (format !== 'markdown' && format !== 'json' && format !== 'html')
      return c.json({ error: '导出格式仅支持 markdown / html / json' }, 400);
    try {
      const report = deps.store.getReportDetail(reviewId);
      const body =
        format === 'json'
          ? renderJson(report)
          : format === 'html'
            ? renderHtml(report)
            : renderMarkdown(report);
      return c.body(body, 200, {
        'content-type':
          format === 'json'
            ? 'application/json; charset=utf-8'
            : format === 'html'
              ? 'text/html; charset=utf-8'
              : 'text/markdown; charset=utf-8',
        'content-disposition': `attachment; filename="${reviewId}.${format === 'json' ? 'json' : format === 'html' ? 'html' : 'md'}"`,
      });
    } catch (e) {
      if (e instanceof StoreError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  app.get('/api/reviews/:id/pr-comment', (c) => {
    const current = c.get('user');
    const reviewId = c.req.param('id');
    if (!canAccessReview(deps, current, reviewId)) return c.json({ error: '审查记录不存在' }, 404);
    try {
      const report = deps.store.getReportDetail(reviewId);
      return c.body(renderPrComment(report), 200, {
        'content-type': 'text/markdown; charset=utf-8',
      });
    } catch (e) {
      if (e instanceof StoreError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  app.post(
    '/api/reviews/:id/pr-comment',
    zValidator('json', PrCommentWriteRequestSchema),
    async (c) => {
      const current = c.get('user');
      const reviewId = c.req.param('id');
      if (!canAccessReview(deps, current, reviewId))
        return c.json({ error: '审查记录不存在' }, 404);
      const token = process.env.GITHUB_TOKEN;
      if (token === undefined || token === '') {
        return c.json({ error: '未配置 GITHUB_TOKEN，无法回写 PR 评论' }, 400);
      }
      const body = c.req.valid('json');
      let markdown: string;
      try {
        markdown = renderPrComment(deps.store.getReportDetail(reviewId));
      } catch (e) {
        if (e instanceof StoreError) return c.json({ error: e.message }, 404);
        throw e;
      }
      const apiBase = (process.env.GITHUB_API_BASE ?? 'https://api.github.com').replace(/\/+$/, '');
      try {
        const response = await fetch(
          `${apiBase}/repos/${body.repo}/issues/${body.pullNumber}/comments`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/vnd.github+json',
              'content-type': 'application/json',
              'user-agent': 'reviewflow',
            },
            body: JSON.stringify({ body: markdown }),
          },
        );
        if (!response.ok) {
          return c.json({ error: `GitHub 评论写入失败（HTTP ${response.status}）` }, 502);
        }
        const payload = (await response.json()) as { html_url?: unknown };
        if (typeof payload.html_url !== 'string') {
          return c.json({ error: 'GitHub 响应缺少 html_url' }, 502);
        }
        return c.json(PrCommentWriteResponseSchema.parse({ url: payload.html_url }));
      } catch {
        return c.json({ error: 'GitHub 评论写入失败（网络错误）' }, 502);
      }
    },
  );

  app.get('/api/stats/rules', zValidator('query', ReviewStatsQuerySchema), (c) => {
    const current = c.get('user');
    const query = c.req.valid('query');
    return c.json(
      RuleHitStatsResponseSchema.parse({
        rules: deps.store.getRuleHitStats(current.role === 'admin' ? undefined : current.id, query),
      }),
    );
  });

  app.get('/api/stats', zValidator('query', ReviewStatsQuerySchema), (c) => {
    const current = c.get('user');
    const query = c.req.valid('query');
    return c.json({
      stats: deps.store.getStats(current.role === 'admin' ? undefined : current.id, query),
    });
  });

  app.get('/api/reviews/:id', (c) => {
    const current = c.get('user');
    const reviewId = c.req.param('id');
    if (!canAccessReview(deps, current, reviewId)) return c.json({ error: '审查记录不存在' }, 404);
    try {
      return c.json(deps.store.getReportDetail(reviewId));
    } catch (e) {
      if (e instanceof StoreError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  app.get('/api/reviews/:id/trace', (c) => {
    const current = c.get('user');
    const reviewId = c.req.param('id');
    if (!canAccessReview(deps, current, reviewId)) return c.json({ error: '审查记录不存在' }, 404);
    try {
      const detail = deps.store.getReportDetail(reviewId);
      return c.json(
        ReviewTraceResponseSchema.parse({
          trace: {
            reviewId,
            llmCalls: deps.store.getLlmCalls(reviewId),
            stages: deps.store.listReviewStages(reviewId),
            summary: {
              durationMs: detail.meta.durationMs,
              tokenUsed: detail.meta.tokenUsed,
              reviewScore: detail.meta.reviewScore ?? detail.meta.riskScore,
              ...(detail.meta.changeRiskScore === undefined
                ? {}
                : { changeRiskScore: detail.meta.changeRiskScore }),
              ...(detail.meta.llmStatus === undefined ? {} : { llmStatus: detail.meta.llmStatus }),
              cacheHits: detail.meta.cacheHits ?? 0,
              healRounds: detail.meta.healRounds ?? 0,
              ...(detail.meta.dimensions === undefined
                ? {}
                : { dimensions: detail.meta.dimensions }),
            },
          },
        }),
      );
    } catch (e) {
      if (e instanceof StoreError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  app.post('/api/reviews/:id/decision', zValidator('json', ReviewDecisionRequestSchema), (c) => {
    const current = c.get('user');
    const reviewId = c.req.param('id');
    if (!canAccessReview(deps, current, reviewId)) return c.json({ error: '审查记录不存在' }, 404);
    const body = c.req.valid('json');
    if (!deps.store.setReviewDecision(reviewId, body.decision, body.comment, current.id)) {
      return c.json({ error: '审查记录不存在' }, 404);
    }
    audit.operation({
      userId: current.id,
      username: current.username,
      ...requestMeta(c),
      action: 'update',
      resource: 'review',
      resourceId: reviewId,
      detail: JSON.stringify({ decision: body.decision }),
      status: 'success',
    });
    return c.json(
      ReviewDecisionResponseSchema.parse({
        reviewId,
        decision: body.decision,
        decidedBy: current.id,
        decidedAt: new Date().toISOString(),
      }),
    );
  });

  app.get('/api/reviews/:id/decisions', (c) => {
    const current = c.get('user');
    const reviewId = c.req.param('id');
    if (!canAccessReview(deps, current, reviewId)) return c.json({ error: '审查记录不存在' }, 404);
    return c.json(
      ReviewDecisionHistoryResponseSchema.parse({
        decisions: deps.store.listReviewDecisionEvents(reviewId),
      }),
    );
  });

  app.get('/api/reviews/:id/compare', (c) => {
    const current = c.get('user');
    const reviewId = c.req.param('id');
    const baseId = c.req.query('baseId');
    if (baseId === undefined || baseId === '') {
      return c.json({ error: '缺少 baseId（要对比的历史审查）' }, 400);
    }
    if (!canAccessReview(deps, current, reviewId) || !canAccessReview(deps, current, baseId)) {
      return c.json({ error: '审查记录不存在' }, 404);
    }
    try {
      const currentDetail = deps.store.getReportDetail(reviewId);
      const baseDetail = deps.store.getReportDetail(baseId);
      const keyOf = (finding: (typeof currentDetail.findings)[number]): string =>
        ensureFindingFingerprint(finding).fingerprint ?? '';
      const baseKeys = new Set(baseDetail.findings.map(keyOf));
      const currentKeys = new Set(currentDetail.findings.map(keyOf));
      const added = currentDetail.findings.filter((finding) => !baseKeys.has(keyOf(finding)));
      const resolved = baseDetail.findings.filter((finding) => !currentKeys.has(keyOf(finding)));
      const persisting = currentDetail.findings.filter((finding) => baseKeys.has(keyOf(finding)));
      return c.json(
        ReviewCompareResponseSchema.parse({
          compare: {
            reviewId,
            baseId,
            summary: {
              added: added.length,
              resolved: resolved.length,
              persisting: persisting.length,
            },
            added,
            resolved,
            persisting,
          },
        }),
      );
    } catch (e) {
      if (e instanceof StoreError) return c.json({ error: e.message }, 404);
      throw e;
    }
  });

  app.patch('/api/findings/:id', zValidator('json', FindingUpdateSchema), (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) {
      return c.json({ error: '发现 ID 无效' }, 400);
    }
    const current = c.get('user');
    const meta = requestMeta(c);
    const owner = deps.store.getFindingReviewOwner(id);
    if (owner !== current.id && current.role !== 'admin') {
      audit.operation({
        userId: current.id,
        username: current.username,
        ...meta,
        action: 'mark_false_positive',
        resource: 'finding',
        resourceId: String(id),
        status: 'failed',
        reason: 'not-found',
      });
      return c.json({ error: '发现记录不存在' }, 404);
    }
    const body = c.req.valid('json');
    const updated = deps.store.updateFinding(id, {
      ...(body.isFalsePositive === undefined ? {} : { isFalsePositive: body.isFalsePositive }),
      ...(body.status === undefined ? {} : { status: body.status }),
    });
    if (!updated) {
      audit.operation({
        userId: current.id,
        username: current.username,
        ...meta,
        action: 'mark_false_positive',
        resource: 'finding',
        resourceId: String(id),
        status: 'failed',
        reason: 'not-found',
      });
      return c.json({ error: '发现记录不存在' }, 404);
    }
    audit.operation({
      userId: current.id,
      username: current.username,
      ...meta,
      action: 'mark_false_positive',
      resource: 'finding',
      resourceId: String(id),
      detail: JSON.stringify({
        ...(body.isFalsePositive === undefined ? {} : { isFalsePositive: body.isFalsePositive }),
        ...(body.status === undefined ? {} : { status: body.status }),
        ...(body.reason === undefined ? {} : { reason: body.reason }),
      }),
      status: 'success',
    });
    return c.json({ updated: true });
  });

  app.get('/api/findings/:id/comments', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: '发现 ID 无效' }, 400);
    const current = c.get('user');
    const owner = deps.store.getFindingReviewOwner(id);
    if (owner !== current.id && current.role !== 'admin') {
      return c.json({ error: '发现记录不存在' }, 404);
    }
    return c.json(
      FindingCommentListResponseSchema.parse({ comments: deps.store.listFindingComments(id) }),
    );
  });

  app.post('/api/findings/:id/comments', zValidator('json', FindingCommentCreateSchema), (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: '发现 ID 无效' }, 400);
    const current = c.get('user');
    const owner = deps.store.getFindingReviewOwner(id);
    if (owner !== current.id && current.role !== 'admin') {
      return c.json({ error: '发现记录不存在' }, 404);
    }
    const comment = deps.store.addFindingComment({
      findingId: id,
      userId: current.id,
      username: current.username,
      body: c.req.valid('json').body,
    });
    audit.operation({
      userId: current.id,
      username: current.username,
      ...requestMeta(c),
      action: 'update',
      resource: 'finding',
      resourceId: String(id),
      detail: JSON.stringify({ commentId: comment.id }),
      status: 'success',
    });
    return c.json(comment, 201);
  });

  app.get('/api/reviews/:id/events', (c) => {
    const current = c.get('user');
    const reviewId = c.req.param('id');
    if (!canAccessReview(deps, current, reviewId)) return c.json({ error: '审查记录不存在' }, 404);

    const queue = new EventQueue<ReviewStageEvent>();
    const unsubscribe = deps.service.subscribe(reviewId, (event) => queue.push(event));
    // 晚连接回放：把已落库的节点检查点按顺序补发，避免客户端只看到“subscribed”
    for (const stage of deps.store.listReviewStages(reviewId)) {
      queue.push({
        type: 'stage',
        reviewId,
        stage: stage.node,
        ...(stage.detail === undefined ? {} : { detail: stage.detail }),
      });
    }
    // 订阅后再次检查，覆盖“任务刚完成、实时事件已广播但客户端尚未连接”的竞态窗口。
    const terminal = deps.service.getTerminalEvent(reviewId);
    if (terminal !== undefined) queue.push(terminal);
    c.req.raw.signal.addEventListener('abort', () => {
      unsubscribe();
      queue.close();
    });

    return streamSSE(c, async (stream) => {
      await stream.writeSSE({ event: 'subscribed', data: JSON.stringify({ reviewId }) });
      for (;;) {
        const event = await queue.next();
        if (event === undefined) break;
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
        if (event.type === 'completed' || event.type === 'failed' || event.type === 'cancelled') {
          // 终态事件即流结束；残余等待者由 close 唤醒
          unsubscribe();
          queue.close();
          break;
        }
      }
    });
  });

  // —— 管理员后台（配置、知识库、用户管理、系统概览）——
  // AdminConfig 响应载荷：掩码配置 + 只读运行环境（未注入运行时使用兜底值，供测试/独立装配）
  const adminConfigPayload = (
    config: ReturnType<typeof AiReviewConfigSchema.parse>,
  ): {
    config: ReturnType<typeof AiReviewConfigSchema.parse>;
    runtime: ServerRuntime;
  } => ({
    config: maskApiKey(config),
    runtime: deps.runtime ?? {
      port: 8080,
      dbPath: '.ai-review-cache/reviews.db',
      webDistDir: null,
      configPath: deps.configPath ?? '.ai-review.yml',
      allowedRoots: [...(deps.allowedRoots ?? [process.cwd()])],
    },
  });

  app.get('/api/admin/config', requireAnyPermission('/admin/config', '/admin/ai'), (c) => {
    const configPath = deps.configPath ?? '.ai-review.yml';
    const config = readAdminConfig(configPath);
    return c.json(AdminConfigResponseSchema.parse(adminConfigPayload(config)));
  });

  app.put(
    '/api/admin/config',
    requireAnyPermission('/admin/config', '/admin/ai'),
    zValidator('json', AdminConfigSchema),
    (c) => {
      const config = c.req.valid('json');
      const configPath = deps.configPath ?? '.ai-review.yml';
      const current = readAdminConfig(configPath);
      const persisted = {
        ...(config.llm.apiKey === '********'
          ? { ...config, llm: { ...config.llm, apiKey: current.llm.apiKey } }
          : config),
        // 系统配置表单不渲染规则字段：入参为空时保留既有规则，避免保存配置时误清空自定义规则
        customRules: config.customRules.length === 0 ? current.customRules : config.customRules,
      };
      writeFileSync(configPath, stringifyYaml(persisted), 'utf8');
      const me = actor(c);
      const meta = requestMeta(c);
      // 只记录变更字段名，避免 apiKey 等敏感值进入审计日志
      const fields = Object.keys(config).join(',');
      audit.operation({
        ...me,
        ...meta,
        action: 'save_config',
        resource: 'config',
        detail: JSON.stringify({ fields }),
        status: 'success',
      });
      return c.json(AdminConfigResponseSchema.parse(adminConfigPayload(persisted)));
    },
  );

  app.post('/api/admin/init-config', requirePermission('/admin/init'), (c) => {
    const configPath = deps.configPath ?? '.ai-review.yml';
    const me = actor(c);
    const meta = requestMeta(c);
    if (existsSync(configPath)) {
      audit.operation({
        ...me,
        ...meta,
        action: 'save_config',
        resource: 'config',
        status: 'failed',
        reason: 'already-exists',
      });
      return c.json({ error: '配置文件已存在' }, 409);
    }
    const config = AiReviewConfigSchema.parse({});
    writeFileSync(configPath, stringifyYaml(config), 'utf8');
    audit.operation({
      ...me,
      ...meta,
      action: 'save_config',
      resource: 'config',
      status: 'success',
    });
    return c.json(AdminConfigResponseSchema.parse(adminConfigPayload(config)));
  });

  // —— 自定义审查规则（admin）：规则随配置持久化，经 custom_rule_check 工具在审查时生效 ——
  app.get('/api/admin/rules', requirePermission('/admin/rules'), (c) => {
    const configPath = deps.configPath ?? '.ai-review.yml';
    const config = readAdminConfig(configPath);
    return c.json(AdminRulesResponseSchema.parse({ rules: config.customRules }));
  });

  app.put(
    '/api/admin/rules',
    requirePermission('/admin/rules'),
    zValidator('json', AdminRulesUpdateSchema),
    (c) => {
      const { rules } = c.req.valid('json');
      const me = actor(c);
      const meta = requestMeta(c);
      // 正则可编译校验：非法表达式在保存时即拒绝，避免规则在审查中静默失效
      const invalid = rules.find((rule) => compileCustomRulePattern(rule) === null);
      if (invalid !== undefined) {
        audit.operation({
          ...me,
          ...meta,
          action: 'save_rules',
          resource: 'rules',
          status: 'failed',
          reason: 'invalid-regex',
        });
        return c.json(
          { error: `规则「${invalid.name}」的正则表达式无法编译，请检查 pattern 与 flags` },
          400,
        );
      }
      const configPath = deps.configPath ?? '.ai-review.yml';
      const current = readAdminConfig(configPath);
      const persisted = { ...current, customRules: rules };
      writeFileSync(configPath, stringifyYaml(persisted), 'utf8');
      audit.operation({
        ...me,
        ...meta,
        action: 'save_rules',
        resource: 'rules',
        detail: JSON.stringify({ count: rules.length }),
        status: 'success',
      });
      return c.json(AdminRulesResponseSchema.parse({ rules: persisted.customRules }));
    },
  );

  app.post(
    '/api/admin/rules/test',
    requirePermission('/admin/rules'),
    zValidator('json', CustomRuleTestRequestSchema),
    (c) => {
      const { rule, sampleDiffText, sampleSource } = c.req.valid('json');
      const me = actor(c);
      const meta = requestMeta(c);
      if (compileCustomRulePattern(rule) === null) {
        audit.operation({
          ...me,
          ...meta,
          action: 'test_rules',
          resource: 'rules',
          resourceId: rule.name,
          status: 'failed',
          reason: 'invalid-regex',
        });
        return c.json({ error: '正则表达式无法编译，请检查 pattern 与 flags' }, 400);
      }
      const matches = testCustomRuleOnSamples(rule, {
        diffText: sampleDiffText,
        source: sampleSource,
      });
      audit.operation({
        ...me,
        ...meta,
        action: 'test_rules',
        resource: 'rules',
        resourceId: rule.name,
        detail: JSON.stringify({ matches: matches.length }),
        status: 'success',
      });
      return c.json(CustomRuleTestResultSchema.parse({ matches }));
    },
  );

  app.post(
    '/api/admin/tools/secret-scan',
    requirePermission('/admin/tools'),
    zValidator('json', z.object({ diffText: z.string() })),
    (c) => {
      const { diffText } = c.req.valid('json');
      return c.json({ findings: scanDiffTextForSecrets(diffText) });
    },
  );

  app.post(
    '/api/admin/tools/complexity',
    requirePermission('/admin/tools'),
    zValidator(
      'json',
      z.object({ source: z.string(), threshold: z.coerce.number().int().min(1).optional() }),
    ),
    (c) => {
      const { source, threshold } = c.req.valid('json');
      return c.json({ functions: analyzeComplexity(source, threshold) });
    },
  );

  app.get('/api/admin/knowledge', requirePermission('/admin/knowledge'), async (c) => {
    const repoPath = c.req.query('repoPath');
    if (repoPath !== undefined && repoPath !== '') {
      try {
        assertRepoPathAllowed(repoPath, deps.allowedRoots ?? [process.cwd()]);
      } catch {
        return c.json({ error: '仓库路径不在允许的目录白名单内' }, 400);
      }
    }
    const status =
      deps.knowledge === undefined
        ? defaultKnowledgeStatus(deps.configPath ?? '.ai-review.yml')
        : await deps.knowledge.getStatus(repoPath);
    return c.json(KnowledgeStatusResponseSchema.parse({ knowledge: status }));
  });

  app.post('/api/admin/knowledge/reindex', requirePermission('/admin/knowledge'), (c) => {
    if (deps.knowledge === undefined) {
      audit.operation({
        ...actor(c),
        ...requestMeta(c),
        action: 'reindex_knowledge',
        resource: 'knowledge',
        status: 'failed',
        reason: 'not-configured',
      });
      return c.json({ error: '知识库服务未配置' }, 503);
    }
    const repoPath = c.req.query('repoPath');
    if (repoPath !== undefined && repoPath !== '') {
      try {
        assertRepoPathAllowed(repoPath, deps.allowedRoots ?? [process.cwd()]);
      } catch {
        audit.operation({
          ...actor(c),
          ...requestMeta(c),
          action: 'reindex_knowledge',
          resource: 'knowledge',
          status: 'failed',
          reason: 'path-not-allowed',
        });
        return c.json({ error: '仓库路径不在允许的目录白名单内' }, 400);
      }
    }
    void deps.knowledge.reindex(repoPath).catch(() => undefined);
    audit.operation({
      ...actor(c),
      ...requestMeta(c),
      action: 'reindex_knowledge',
      resource: 'knowledge',
      ...(repoPath === undefined ? {} : { detail: JSON.stringify({ repoPath }) }),
      status: 'success',
    });
    return c.json(KnowledgeReindexResponseSchema.parse({ accepted: true }), 202);
  });

  app.get('/api/admin/users', requirePermission('/admin/users'), (c) => {
    return c.json(UserListResponseSchema.parse({ users: deps.users.listUsers() }));
  });

  app.post(
    '/api/admin/users',
    requirePermission('/admin/users'),
    zValidator('json', AdminCreateUserSchema),
    async (c) => {
      const { username, password } = c.req.valid('json');
      const me = actor(c);
      const meta = requestMeta(c);
      let user: SafeUser;
      try {
        // 管理员代办创建：固定为普通用户角色
        user = deps.users.createUser({
          username,
          passwordHash: await hashPassword(password),
          role: 'user',
        });
      } catch (e) {
        if (e instanceof StoreError) {
          audit.operation({
            ...me,
            ...meta,
            action: 'create',
            resource: 'user',
            detail: JSON.stringify({ username }),
            status: 'failed',
            reason: 'username-exists',
          });
          return c.json({ error: e.message }, 409);
        }
        throw e;
      }
      audit.operation({
        ...me,
        ...meta,
        action: 'create',
        resource: 'user',
        resourceId: user.id,
        detail: JSON.stringify({ username }),
        status: 'success',
      });
      return c.json(AuthResponseSchema.parse({ user }), 201);
    },
  );

  // —— 角色管理（RBAC）：拥有角色管理权限即可 ——
  app.get('/api/admin/roles', requirePermission('/admin/roles'), (c) => {
    return c.json(RoleListResponseSchema.parse({ roles: deps.users.listRoles() }));
  });

  app.post(
    '/api/admin/roles',
    requirePermission('/admin/roles'),
    zValidator('json', RoleInputSchema),
    (c) => {
      const input = c.req.valid('json');
      const me = actor(c);
      const meta = requestMeta(c);
      try {
        const role = deps.users.createRole({
          name: input.name,
          description: input.description ?? null,
          priority: input.priority,
          permissions: input.permissions,
        });
        audit.operation({
          ...me,
          ...meta,
          action: 'create',
          resource: 'role',
          resourceId: role.id,
          detail: JSON.stringify({ name: role.name }),
          status: 'success',
        });
        return c.json(RoleResponseSchema.parse({ role }), 201);
      } catch (e) {
        if (e instanceof StoreError) {
          audit.operation({
            ...me,
            ...meta,
            action: 'create',
            resource: 'role',
            detail: JSON.stringify({ name: input.name }),
            status: 'failed',
            reason: 'name-exists',
          });
          return c.json({ error: e.message }, 409);
        }
        throw e;
      }
    },
  );

  app.put(
    '/api/admin/roles/:id',
    requirePermission('/admin/roles'),
    zValidator('json', RoleInputSchema),
    (c) => {
      const input = c.req.valid('json');
      const me = actor(c);
      const meta = requestMeta(c);
      const roleId = c.req.param('id');
      try {
        const role = deps.users.updateRole(roleId, {
          name: input.name,
          description: input.description ?? null,
          priority: input.priority,
          permissions: input.permissions,
        });
        if (role === undefined) {
          audit.operation({
            ...me,
            ...meta,
            action: 'update',
            resource: 'role',
            resourceId: roleId,
            status: 'failed',
            reason: 'not-found',
          });
          return c.json({ error: '角色不存在' }, 404);
        }
        audit.operation({
          ...me,
          ...meta,
          action: 'update',
          resource: 'role',
          resourceId: roleId,
          detail: JSON.stringify({ name: role.name }),
          status: 'success',
        });
        return c.json(RoleResponseSchema.parse({ role }));
      } catch (e) {
        if (e instanceof StoreError) {
          audit.operation({
            ...me,
            ...meta,
            action: 'update',
            resource: 'role',
            resourceId: roleId,
            status: 'failed',
            reason: 'name-exists',
          });
          return c.json({ error: e.message }, 409);
        }
        throw e;
      }
    },
  );

  app.delete('/api/admin/roles/:id', requirePermission('/admin/roles'), (c) => {
    const me = actor(c);
    const meta = requestMeta(c);
    const roleId = c.req.param('id');
    try {
      if (!deps.users.deleteRole(roleId)) {
        audit.operation({
          ...me,
          ...meta,
          action: 'delete',
          resource: 'role',
          resourceId: roleId,
          status: 'failed',
          reason: 'not-found',
        });
        return c.json({ error: '角色不存在' }, 404);
      }
      audit.operation({
        ...me,
        ...meta,
        action: 'delete',
        resource: 'role',
        resourceId: roleId,
        status: 'success',
      });
      return c.json({ deleted: true });
    } catch (e) {
      if (e instanceof StoreError) {
        audit.operation({
          ...me,
          ...meta,
          action: 'delete',
          resource: 'role',
          resourceId: roleId,
          status: 'failed',
          reason: 'system-role',
        });
        return c.json({ error: e.message }, 400);
      }
      throw e;
    }
  });

  // 给用户分配角色（整体替换）
  app.put(
    '/api/admin/users/:id/roles',
    requirePermission('/admin/users'),
    zValidator('json', AssignRolesSchema),
    (c) => {
      const { roleIds } = c.req.valid('json');
      const me = actor(c);
      const meta = requestMeta(c);
      if (!deps.users.assignRoles(c.req.param('id'), roleIds)) {
        audit.operation({
          ...me,
          ...meta,
          action: 'assign_roles',
          resource: 'user',
          resourceId: c.req.param('id'),
          status: 'failed',
          reason: 'not-found',
        });
        return c.json({ error: '用户不存在' }, 404);
      }
      const user = deps.users.getById(c.req.param('id'));
      if (user === undefined) return c.json({ error: '用户不存在' }, 404);
      audit.operation({
        ...me,
        ...meta,
        action: 'assign_roles',
        resource: 'user',
        resourceId: user.id,
        detail: JSON.stringify({ roleIds }),
        status: 'success',
      });
      return c.json(AuthResponseSchema.parse({ user }));
    },
  );

  app.patch(
    '/api/admin/users/:id',
    requirePermission('/admin/users'),
    zValidator('json', AdminUserPatchSchema),
    (c) => {
      const targetId = c.req.param('id');
      const current = c.get('user');
      const patch = c.req.valid('json');
      const meta = requestMeta(c);
      // 防自锁：唯一操作人不可自降权限或自禁用（admin 数量判定交给列表页展示，此处守住直接风险）
      if (targetId === current.id && (patch.role === 'user' || patch.status === 'disabled')) {
        audit.operation({
          userId: current.id,
          username: current.username,
          ...meta,
          action: 'update',
          resource: 'user',
          resourceId: targetId,
          detail: JSON.stringify(patch),
          status: 'failed',
          reason: 'self-lock-guard',
        });
        return c.json({ error: '不能降级或禁用当前登录账号' }, 400);
      }
      let updated = false;
      if (patch.role !== undefined) updated = deps.users.updateUserRole(targetId, patch.role);
      if (patch.status !== undefined) updated = deps.users.setUserStatus(targetId, patch.status);
      if (!updated) {
        audit.operation({
          userId: current.id,
          username: current.username,
          ...meta,
          action: 'update',
          resource: 'user',
          resourceId: targetId,
          status: 'failed',
          reason: 'not-found',
        });
        return c.json({ error: '用户不存在' }, 404);
      }
      const nextUser = deps.users.getById(targetId);
      if (nextUser === undefined) return c.json({ error: '用户不存在' }, 404);
      audit.operation({
        userId: current.id,
        username: current.username,
        ...meta,
        action: 'update',
        resource: 'user',
        resourceId: targetId,
        detail: JSON.stringify(patch),
        status: 'success',
      });
      return c.json({ user: nextUser });
    },
  );

  app.post('/api/admin/users/:id/reset-password', requirePermission('/admin/users'), async (c) => {
    const targetId = c.req.param('id');
    const me = actor(c);
    const meta = requestMeta(c);
    const newPassword = generateRandomPassword();
    if (!deps.users.resetPassword(targetId, await hashPassword(newPassword))) {
      audit.operation({
        ...me,
        ...meta,
        action: 'reset_password',
        resource: 'user',
        resourceId: targetId,
        status: 'failed',
        reason: 'not-found',
      });
      return c.json({ error: '用户不存在' }, 404);
    }
    // 旧凭据立即失效
    deps.users.deleteSessionsForUser(targetId);
    audit.operation({
      ...me,
      ...meta,
      action: 'reset_password',
      resource: 'user',
      resourceId: targetId,
      status: 'success',
    });
    return c.json({ newPassword });
  });

  app.delete('/api/admin/users/:id', requirePermission('/admin/users'), (c) => {
    const targetId = c.req.param('id');
    const me = actor(c);
    const meta = requestMeta(c);
    if (targetId === c.get('user').id) {
      audit.operation({
        ...me,
        ...meta,
        action: 'delete',
        resource: 'user',
        resourceId: targetId,
        status: 'failed',
        reason: 'self-delete-guard',
      });
      return c.json({ error: '不能删除当前登录账号' }, 400);
    }
    if (!deps.users.deleteUser(targetId)) {
      audit.operation({
        ...me,
        ...meta,
        action: 'delete',
        resource: 'user',
        resourceId: targetId,
        status: 'failed',
        reason: 'not-found',
      });
      return c.json({ error: '用户不存在' }, 404);
    }
    audit.operation({
      ...me,
      ...meta,
      action: 'delete',
      resource: 'user',
      resourceId: targetId,
      status: 'success',
    });
    return c.json({ deleted: true });
  });

  // —— 审计日志查询（登录日志 / 操作日志，独立权限；分页 + 日期/状态/动作/用户名筛选）——
  app.get(
    '/api/admin/login-logs',
    requirePermission('/admin/login-logs'),
    zValidator('query', LoginLogQuerySchema),
    (c) => c.json(LoginLogListResponseSchema.parse(audit.listLoginLogs(c.req.valid('query')))),
  );

  app.get(
    '/api/admin/operation-logs',
    requirePermission('/admin/operation-logs'),
    zValidator('query', OperationLogQuerySchema),
    (c) =>
      c.json(OperationLogListResponseSchema.parse(audit.listOperationLogs(c.req.valid('query')))),
  );

  // —— 模型调用审计（可观测页数据源；只读，不触发任何模型请求）——
  // 同时接受 /admin（概览页沿用）与 /admin/observability，使只被授予审计页的角色也能查看。
  app.get(
    '/api/admin/llm-calls',
    requireAnyPermission('/admin', '/admin/observability'),
    zValidator('query', LlmCallListQuerySchema),
    (c) =>
      c.json(
        LlmCallListResponseSchema.parse({
          calls: deps.store.listRecentLlmCalls(c.req.valid('query').limit),
        }),
      ),
  );

  app.get('/api/admin/overview', requirePermission('/admin'), (c) => {
    const stats = deps.store.getStats();
    const cache = deps.store.getCacheSummary();
    const roleCounts = deps.users.getUserRoleCounts();
    const recentFailures = deps.store
      .listReviewPage({ status: 'failed', page: 1, pageSize: 5 })
      .reviews.map((review) => ({
        reviewId: review.reviewId,
        repoPath: review.repoPath,
        errorMessage: review.errorMessage,
        createdAt: review.createdAt,
      }));
    const failedTotal = deps.store.listReviewPage({ status: 'failed', page: 1, pageSize: 1 }).total;
    return c.json(
      AdminOverviewResponseSchema.parse({
        overview: {
          userCount: roleCounts.total,
          adminCount: roleCounts.admins,
          totalReviews: stats.totalReviews,
          totalFindings: stats.totalFindings,
          totalTokenUsed: stats.totalTokenUsed,
          cacheEntries: cache.entries,
          tokenSavedByCache: cache.tokenSaved,
          failureRate: stats.totalReviews === 0 ? 0 : failedTotal / stats.totalReviews,
          riskTrend: stats.riskTrend.filter((point) => {
            const cutoff = new Date();
            cutoff.setDate(cutoff.getDate() - 6);
            return point.date >= cutoff.toISOString().slice(0, 10);
          }),
          recentFailures,
        },
      }),
    );
  });

  // —— 仓库发现（Web 发起审查的仓库/分支/提交选择器数据源）——
  // 所有查询都以 allowedRoots 为界：先做路径白名单校验，再交给 RepoService 只读访问
  const repoService = new RepoService();
  const allowedRoots = (): readonly string[] => deps.allowedRoots ?? [process.cwd()];

  app.get('/api/repos', requirePermission('/run'), (c) => {
    const reviewed = uniqueRepoPaths(deps.store.listRepoPaths(200));
    return c.json(
      RepositoryListResponseSchema.parse({
        repositories: repoService.list(allowedRoots(), reviewed),
      }),
    );
  });

  /** 三个仓库子资源共用的前置校验：解析 query 并校验路径白名单 */
  const validateRepoQuery = (
    c: import('hono').Context,
  ): { repoPath: string; query: ReturnType<typeof RepoQuerySchema.parse> } | Response => {
    const query = RepoQuerySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: '仓库路径无效' }, 400);
    try {
      assertRepoPathAllowed(query.data.repoPath, allowedRoots());
    } catch {
      return c.json({ error: '仓库路径不在允许的目录白名单内' }, 400);
    }
    return { repoPath: query.data.repoPath, query: query.data };
  };

  app.get('/api/repos/status', async (c) => {
    const parsed = validateRepoQuery(c);
    if (parsed instanceof Response) return parsed;
    try {
      const status = await repoService.status(parsed.repoPath);
      return c.json(RepoStatusResponseSchema.parse({ status }));
    } catch {
      return c.json({ error: '无法读取仓库状态' }, 400);
    }
  });

  app.get('/api/repos/branches', async (c) => {
    const parsed = validateRepoQuery(c);
    if (parsed instanceof Response) return parsed;
    try {
      const branches = await repoService.branches(parsed.repoPath, parsed.query.limit);
      return c.json(RepoBranchListResponseSchema.parse({ branches }));
    } catch {
      return c.json({ error: '无法读取分支列表' }, 400);
    }
  });

  app.get('/api/repos/commits', async (c) => {
    const parsed = validateRepoQuery(c);
    if (parsed instanceof Response) return parsed;
    try {
      const commits = await repoService.commits(
        parsed.repoPath,
        parsed.query.limit,
        parsed.query.ref ?? 'HEAD',
      );
      return c.json(RepoCommitListResponseSchema.parse({ commits }));
    } catch {
      return c.json({ error: '无法读取提交列表' }, 400);
    }
  });

  // —— Hook / CI 令牌（Web 一键安装 Hook 的凭据管理）——
  app.get('/api/admin/hooks/tokens', requirePermission('/admin/hook'), (c) => {
    if (deps.hookTokens === undefined) return c.json({ error: 'Hook 令牌服务未配置' }, 503);
    return c.json(HookTokenListResponseSchema.parse({ tokens: deps.hookTokens.list() }));
  });

  app.post(
    '/api/admin/hooks/tokens',
    requirePermission('/admin/hook'),
    zValidator('json', CreateHookTokenSchema),
    (c) => {
      if (deps.hookTokens === undefined) return c.json({ error: 'Hook 令牌服务未配置' }, 503);
      const { label, expiresInDays } = c.req.valid('json');
      const created = deps.hookTokens.create({
        label,
        expiresInDays,
        createdBy: c.get('user').id,
      });
      audit.operation({
        ...actor(c),
        ...requestMeta(c),
        action: 'rotate_hook_token',
        resource: 'hook',
        resourceId: created.token.id,
        detail: JSON.stringify({ label }),
        status: 'success',
      });
      return c.json(
        CreateHookTokenResponseSchema.parse({ token: created.token, plainText: created.plainText }),
        201,
      );
    },
  );

  app.delete('/api/admin/hooks/tokens/:id', requirePermission('/admin/hook'), (c) => {
    if (deps.hookTokens === undefined) return c.json({ error: 'Hook 令牌服务未配置' }, 503);
    const revoked = deps.hookTokens.revoke(c.req.param('id'));
    audit.operation({
      ...actor(c),
      ...requestMeta(c),
      action: 'revoke_hook_token',
      resource: 'hook',
      resourceId: c.req.param('id'),
      status: revoked ? 'success' : 'failed',
      ...(revoked ? {} : { reason: 'not-found' }),
    });
    return c.json({ revoked });
  });

  app.get('/api/admin/hooks/script', requirePermission('/admin/hook'), (c) => {
    const config = readAdminConfig(deps.configPath ?? '.ai-review.yml');
    const origin = c.req.header('origin') ?? `http://localhost:${deps.runtime?.port ?? 8080}`;
    return c.json(
      HookScriptSchema.parse(
        buildHookScripts(c.req.query('serverUrl') ?? origin, {
          target: 'staged',
          mode: 'fast',
          blockOn: config.review.blockOn,
        }),
      ),
    );
  });

  app.post(
    '/api/admin/hooks/install',
    requirePermission('/admin/hook'),
    zValidator('json', InstallHookSchema),
    (c) => {
      const body = c.req.valid('json');
      const meta = requestMeta(c);
      const me = actor(c);
      try {
        assertRepoPathAllowed(body.repoPath, allowedRoots());
      } catch {
        audit.operation({
          ...me,
          ...meta,
          action: 'install_hook',
          resource: 'hook',
          status: 'failed',
          reason: 'path-not-allowed',
        });
        return c.json({ error: '仓库路径不在允许的目录白名单内' }, 400);
      }
      if (deps.hookTokens === undefined) {
        return c.json({ error: 'Hook 令牌服务未配置' }, 503);
      }
      const config = readAdminConfig(deps.configPath ?? '.ai-review.yml');
      const origin =
        body.serverUrl ??
        c.req.header('origin') ??
        `http://localhost:${deps.runtime?.port ?? 8080}`;
      const scripts = buildHookScripts(origin, {
        target: 'staged',
        mode: 'fast',
        blockOn: config.review.blockOn,
      });

      let plainText: string | null = null;
      if (body.tokenLabel !== undefined) {
        const created = deps.hookTokens.create({
          label: body.tokenLabel,
          expiresInDays: 90,
          createdBy: c.get('user').id,
        });
        plainText = created.plainText;
      }

      try {
        const result = installHookFiles({
          repoPath: body.repoPath,
          scripts,
          plainText,
          overwrite: body.overwrite,
        });
        audit.operation({
          ...me,
          ...meta,
          action: 'install_hook',
          resource: 'hook',
          resourceId: body.repoPath,
          detail: JSON.stringify({ files: result.files.length, skipped: result.skipped.length }),
          status: 'success',
        });
        return c.json(
          InstallHookResponseSchema.parse({
            installed: result.files.length > 0,
            files: result.files,
            plainText,
            skipped: result.skipped,
          }),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Hook 安装失败';
        audit.operation({
          ...me,
          ...meta,
          action: 'install_hook',
          resource: 'hook',
          resourceId: body.repoPath,
          status: 'failed',
          reason: 'io',
        });
        return c.json({ error: message }, 400);
      }
    },
  );

  // —— Hook / CI 同步审查（Bearer 令牌鉴权，返回退出码契约 0/1/2/3）——
  app.post('/api/hooks/review', zValidator('json', HookReviewRequestSchema), async (c) => {
    const startedAt = Date.now();
    if (deps.hookTokens === undefined) return c.json({ error: 'Hook 令牌服务未配置' }, 503);
    const header = c.req.header('authorization') ?? '';
    const plainText = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    const hookToken = deps.hookTokens.verify(plainText);
    if (hookToken === undefined) {
      return c.json({ error: '令牌无效或已过期，请在管理后台重新安装 Hook' }, 401);
    }

    const body = c.req.valid('json');
    const meta = requestMeta(c);
    try {
      assertRepoPathAllowed(body.repoPath, allowedRoots());
    } catch {
      return c.json({ error: '仓库路径不在允许的目录白名单内' }, 400);
    }
    const sourceResult = toReviewSource(body);
    if (!sourceResult.ok) return c.json({ error: sourceResult.error }, 400);

    const config = readAdminConfig(deps.configPath ?? '.ai-review.yml');
    const reviewId = deps.service.startReview({
      repoPath: body.repoPath,
      mode: body.mode ?? config.review.mode,
      blockOn: body.blockOn ?? config.review.blockOn,
      source: sourceResult.source,
      includePraise: config.report.includePraise,
      ...(hookToken.createdBy === null ? {} : { createdBy: hookToken.createdBy }),
    });
    const timeoutMs = deps.hookTimeoutMs ?? 120_000;
    const terminal = await deps.service.waitForTerminal(reviewId, timeoutMs);

    if (terminal === null) {
      deps.service.cancelReview(reviewId);
      audit.operation({
        userId: hookToken.createdBy ?? '',
        username: `hook:${hookToken.label}`,
        ...meta,
        action: 'run_hook_review',
        resource: 'review',
        resourceId: reviewId,
        detail: JSON.stringify({ source: describeReviewSource(sourceResult.source) }),
        status: 'failed',
        reason: 'timeout',
      });
      return c.json(
        HookReviewResponseSchema.parse({
          reviewId,
          status: 'cancelled',
          blocking: false,
          riskScore: 0,
          blockerCount: 0,
          summary: `ai-review: 审查超时（${Math.round(timeoutMs / 1000)}s），已跳过本次阻断判定。`,
          exitCode: EXIT_CODES.cancelled,
        }),
      );
    }

    if (terminal.type === 'completed') {
      audit.operation({
        userId: hookToken.createdBy ?? '',
        username: `hook:${hookToken.label}`,
        ...meta,
        action: 'run_hook_review',
        resource: 'review',
        resourceId: reviewId,
        detail: JSON.stringify({
          source: describeReviewSource(sourceResult.source),
          blocking: terminal.blocking,
        }),
        status: 'success',
      });
      return c.json(
        HookReviewResponseSchema.parse({
          reviewId,
          status: 'completed',
          blocking: terminal.blocking,
          riskScore: terminal.riskScore,
          blockerCount: terminal.blockerCount,
          summary: terminal.blocking
            ? `ai-review: 发现 BLOCKER × ${terminal.blockerCount}（风险 ${terminal.riskScore}/100），已阻断本次提交。`
            : `ai-review: 未发现达到阻断阈值的问题（风险 ${terminal.riskScore}/100）。`,
          exitCode: terminal.blocking ? EXIT_CODES.blocked : EXIT_CODES.ok,
        }),
      );
    }

    const failed = terminal.type === 'failed';
    audit.operation({
      userId: hookToken.createdBy ?? '',
      username: `hook:${hookToken.label}`,
      ...meta,
      action: 'run_hook_review',
      resource: 'review',
      resourceId: reviewId,
      status: 'failed',
      reason: terminal.type,
    });
    return c.json(
      HookReviewResponseSchema.parse({
        reviewId,
        status: failed ? 'failed' : 'cancelled',
        blocking: false,
        riskScore: 0,
        blockerCount: 0,
        summary: failed
          ? `ai-review: 审查执行失败（${Math.round((Date.now() - startedAt) / 1000)}s）。`
          : 'ai-review: 审查已取消。',
        exitCode: failed ? EXIT_CODES.configError : EXIT_CODES.cancelled,
      }),
    );
  });

  // —— MCP over Streamable HTTP（替代 stdio 形态；默认关闭）——
  app.all('/api/mcp', async (c) => {
    if (deps.mcpEnabled !== true) return c.json({ error: 'MCP 端点未启用' }, 404);
    const header = c.req.header('authorization') ?? '';
    const plainText = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
    if (deps.hookTokens?.verify(plainText) === undefined) {
      return c.json({ error: '令牌无效或已过期' }, 401);
    }
    return handleMcpRequest(c.req.raw);
  });

  // 统一错误响应（方案 4）：完整异常仅记录到服务端日志，向调用方返回泛化信息，避免泄露内部路径/细节
  app.onError((error, c) => {
    console.error(`[ai-review] unhandled error on ${c.req.method} ${c.req.path}:`, error);
    return c.json({ error: '服务器内部错误' }, 500);
  });

  return app;
}

function readAdminConfig(path: string): ReturnType<typeof AiReviewConfigSchema.parse> {
  if (!existsSync(path)) return AiReviewConfigSchema.parse({});
  const parsed = parseYaml(readFileSync(path, 'utf8')) as unknown;
  return AiReviewConfigSchema.parse(parsed);
}

function maskApiKey(
  config: ReturnType<typeof AiReviewConfigSchema.parse>,
): ReturnType<typeof AiReviewConfigSchema.parse> {
  const apiKey = config.llm.apiKey;
  return {
    ...config,
    llm: {
      ...config.llm,
      apiKey: /^\$\{[A-Z0-9_]+\}$/.test(apiKey) ? apiKey : '********',
    },
  };
}

function defaultKnowledgeStatus(configPath: string): {
  status: 'disabled' | 'idle';
  indexDir: string;
  chunkCount: number;
  paths: string[];
  lastIndexedAt: string | null;
  error: string | null;
} {
  const config = readAdminConfig(configPath);
  return {
    status: config.rag.enabled ? 'idle' : 'disabled',
    indexDir: config.rag.indexDir,
    chunkCount: 0,
    paths: config.rag.knowledgeBasePaths,
    lastIndexedAt: null,
    error: null,
  };
}

/** 审查归属校验：非本人且非 admin 一律按不存在处理（避免探测有效审查 ID） */
function canAccessReview(
  deps: Pick<AppDeps, 'store' | 'service'>,
  current: SafeUser,
  reviewId: string,
): boolean {
  if (current.role === 'admin') return true;
  return (
    deps.store.getReviewOwner(reviewId) === current.id ||
    deps.service.getReviewOwner(reviewId) === current.id
  );
}
