import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { LogStore, HookTokenStore, openSqlite, ReviewStore, UserStore } from '@ai-review/db';
import { createFileHistory, createGitRunner, createIgnoreRules, GitReader } from '@ai-review/diff';
import { TokenBudget, createConfiguredProviders } from '@ai-review/llm';
import { runReviewPipeline } from '@ai-review/core';
import type { PipelineDeps } from '@ai-review/core';
import { AiReviewConfigSchema, loadConfig } from '@ai-review/shared';
import type { AiReviewConfig, ReviewSource } from '@ai-review/shared';
import { buildDefaultRegistry, resolveEnabledTools } from '@ai-review/tools';
import { resolveReviewDimensions } from '@ai-review/core';
import { SqliteCheckpointSaver } from '@ai-review/db';
import { AuditService } from './audit.js';
import { AvatarStore } from './avatar.js';
import { buildApp } from './app.js';
import { createStoreReviewCache } from './cache.js';
import { Logger } from './logger.js';
import { createReviewMetrics } from './metrics.js';
import { ReviewService } from './review-service.js';
import type { ReviewOverrides } from './review-service.js';
import { createReviewTools } from './review-tools.js';
import { loadServerSettings } from './server-settings.js';
import { createKnowledgeManager } from './knowledge.js';

export type ServerCliOptions = {
  port: number;
  dbFile: string;
  webDistDir: string | undefined;
  configPath?: string;
};

function parseArgs(argv: readonly string[]): ServerCliOptions {
  const values: { port: number; dbFile: string; webDistDir?: string; configPath?: string } = {
    port: 8080,
    dbFile: '.ai-review-cache/reviews.db',
  };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--port' && value !== undefined) values.port = Number(value);
    else if (flag === '--db' && value !== undefined) values.dbFile = value;
    else if (flag === '--web-dist' && value !== undefined) values.webDistDir = value;
    else if (flag === '--config' && value !== undefined) values.configPath = value;
  }
  return {
    ...values,
    webDistDir: values.webDistDir === undefined ? undefined : resolve(values.webDistDir),
    ...(values.configPath === undefined ? {} : { configPath: resolve(values.configPath) }),
  };
}

/**
 * 读取仓库内的项目约定文件（AGENTS.md / CLAUDE.md / .ai-review/conventions.md）。
 * 约定作为 LLM 的“背景证据”，限长避免把整份文档塞进每次审查。
 * @param repoPath 仓库根目录
 * @returns 约定摘要；没有约定文件时返回 undefined
 */
function readConventions(repoPath: string): string | undefined {
  const candidates = ['AGENTS.md', 'CLAUDE.md', '.ai-review/conventions.md'];
  const parts: string[] = [];
  for (const name of candidates) {
    const path = join(repoPath, name);
    if (!existsSync(path)) continue;
    try {
      const text = readFileSync(path, 'utf8');
      parts.push(`### ${name}\n${text.slice(0, 4_000)}`);
    } catch {
      // 约定文件读取失败不影响审查（降级为无约定）
    }
    if (parts.join('\n\n').length > 6_000) break;
  }
  return parts.length === 0 ? undefined : parts.join('\n\n').slice(0, 6_000);
}

/**
 * 规则指纹：自定义规则、静态阈值、维度与模型共同决定结果，
 * 任一变化都必须让审查缓存失效（历史缺陷：只按 prompt 版本失效）。
 * @param config 当前配置
 * @returns 32 位十六进制指纹
 */
function fingerprintRules(config: AiReviewConfig, overrides: ReviewOverrides = {}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        provider: config.llm.provider,
        model: config.llm.model,
        temperature: config.llm.temperature,
        dimensions: config.review.dimensions,
        customRules: config.customRules,
        staticAnalysis: config.staticAnalysis,
        // 单次覆盖也会改变结论，必须参与缓存键
        overrides,
      }),
    )
    .digest('hex')
    .slice(0, 32);
}

/**
 * 组装服务端审查流水线；Provider 无法使用时仍保留确定性的 mock fallback。
 * @param source 审查来源（staged/worktree/commit/range），由发起方指定
 */
function createPipelineDeps(
  repoPath: string,
  mode: 'fast' | 'full',
  config: AiReviewConfig,
  knowledge: ReturnType<typeof createKnowledgeManager>,
  source: ReviewSource,
  overrides: ReviewOverrides = {},
  checkpointer?: SqliteCheckpointSaver,
): PipelineDeps {
  const git = createGitRunner(repoPath);
  const gitReader = new GitReader(git, repoPath);
  const conventions = readConventions(repoPath);
  return {
    gitReader,
    rag: knowledge.retriever,
    repoPath,
    ignores: createIgnoreRules(config.review.ignorePatterns),
    history: createFileHistory(git),
    providers: createConfiguredProviders(config),
    ...(conventions === undefined ? {} : { conventions }),
    ...((overrides.toolCalling ?? config.review.toolCalling)
      ? {
          tools: createReviewTools({
            gitReader,
            source,
            charBudget: config.review.toolCharBudget,
          }),
        }
      : {}),
    rulesFingerprint: fingerprintRules(config, overrides),
    ...(checkpointer === undefined ? {} : { checkpointer }),
    registry: buildDefaultRegistry({
      complexityThreshold: config.staticAnalysis.complexityThreshold,
      customRules: config.customRules,
    }),
    enabledTools: resolveEnabledTools(config.staticAnalysis.enabledTools, config.customRules),
    ragTopK: config.rag.topK,
    budget: new TokenBudget(config.llm.maxTokensPerReview),
    modelName:
      config.llm.provider === 'mock' ? 'mock + 静态分析' : `${config.llm.model} + 静态分析`,
    mode,
    source,
    dimensions: resolveReviewDimensions(overrides.dimensions ?? config.review.dimensions),
    maxFiles: overrides.maxFiles ?? config.review.maxFiles,
    maxChangedLines: overrides.maxChangedLines ?? config.review.maxChangedLines,
  };
}

/** 可注入的配置读取器：每次调用重读配置文件，读取/校验失败时返回上次有效配置（热生效语义）。 */
export type LiveConfigReader = () => AiReviewConfig;

/**
 * 创建配置热重读器（管理后台保存配置/规则后，下一次审查自动生效，无需重启服务）。
 * @param configPath 配置文件路径
 * @param fallback 启动时加载的初始配置（文件缺失/读取失败时的兜底）
 * @returns 每次调用返回最新有效配置的读取器
 */
export function createLiveConfigReader(
  configPath: string,
  fallback: AiReviewConfig,
): LiveConfigReader {
  let live = fallback;
  return () => {
    try {
      if (existsSync(configPath)) live = loadConfig(configPath);
    } catch {
      // 保留上次有效配置，避免配置写入瞬间的临时文件状态拖垮审查
    }
    return live;
  };
}

export async function startServer(options: ServerCliOptions): Promise<void> {
  const configPath = options.configPath ?? '.ai-review.yml';
  const config = existsSync(configPath)
    ? loadConfig(configPath)
    : options.configPath === undefined
      ? AiReviewConfigSchema.parse({})
      : loadConfig(configPath);

  // ReviewStore 与 UserStore 共用同一 SQLite 连接（users/sessions/reviews 同库）
  const knowledge = createKnowledgeManager(config);
  const sqlite = openSqlite(options.dbFile);
  const store = new ReviewStore(sqlite);
  // LangGraph 检查点持久化：进程重启后可按 reviewId（thread_id）续跑
  const checkpointer = new SqliteCheckpointSaver(sqlite);
  // 崩溃恢复：清理无主检查点（节点先于 reviews 行写入，不能依赖外键级联）
  try {
    const pruned = store.pruneOrphanReviewStages();
    if (pruned > 0) console.warn(`[ai-review] pruned ${pruned} orphan review stage(s)`);
  } catch (error) {
    console.error('[ai-review] failed to prune orphan review stages:', error);
  }
  try {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    const pruned = store.pruneLanggraphCheckpoints(cutoff);
    if (pruned > 0) console.warn(`[ai-review] pruned ${pruned} expired checkpoint(s)`);
  } catch (error) {
    console.error('[ai-review] failed to prune expired checkpoints:', error);
  }
  const users = new UserStore(sqlite);
  const hookTokens = new HookTokenStore(sqlite);
  // 审计日志：SQLite 落库（页面查询）+ Logger（控制台 + 按日文件归档），配置项总开关
  const logs = new LogStore(sqlite);
  const audit = new AuditService(
    logs,
    new Logger({
      console: config.logging.console,
      file: config.logging.file,
      dir: config.logging.dir,
      maxDays: config.logging.maxDays,
    }),
    config.logging.enabled,
  );
  // 存量迁移：为 RBAC 引入前创建、尚无角色分配的账号补发内置角色（admin→role-admin 等）
  users.backfillDefaultRoles();
  const metrics = createReviewMetrics();
  const reviewCache = createStoreReviewCache(store);
  // 服务端运行参数（web 可配置，env > config > 默认）：启动时快照，保存后需重启生效
  const settings = loadServerSettings(config);
  // 配置热重读：管理后台保存配置/自定义规则后，下一次审查自动生效，无需重启服务
  const readLiveConfig = createLiveConfigReader(configPath, config);
  const service = new ReviewService(
    store,
    (repoPath, mode, source, overrides) => {
      const liveConfig = readLiveConfig();
      return {
        ...createPipelineDeps(
          repoPath,
          mode,
          liveConfig,
          knowledge,
          source,
          overrides,
          checkpointer,
        ),
        reviewCache,
      };
    },
    runReviewPipeline,
    metrics,
    settings.maxConcurrent,
  );
  // 恢复上次进程退出时仍在 running 的任务（checkpointer 会从最后成功节点继续）
  const resumed = service.resumeInterrupted();
  if (resumed > 0) console.warn(`[ai-review] resumed ${resumed} interrupted review job(s)`);
  // 头像目录与 DB 同目录（默认 .ai-review-cache/avatars），由 AvatarStore 自行 mkdir
  const avatarStore = new AvatarStore(join(dirname(options.dbFile), 'avatars'));
  const app = buildApp({
    store,
    users,
    service,
    metrics,
    configPath,
    knowledge,
    avatars: avatarStore,
    audit,
    hookTokens,
    hookTimeoutMs: config.server.hookTimeoutMs,
    mcpEnabled: config.server.mcpEnabled,
    // 服务端参数（env > config > 默认）：允许审查的仓库根目录、开放注册、Cookie Secure、信任代理
    // 开放注册仅在显式开启时注入；关闭时保留“首个管理员引导”语义（无用户时仍可注册首账号）
    allowedRoots: settings.allowedRoots,
    ...(settings.allowRegister ? { registrationOpen: true } : {}),
    cookieSecure: settings.cookieSecure,
    trustProxy: settings.trustProxy,
    runtime: {
      port: options.port,
      dbPath: resolve(options.dbFile),
      webDistDir: options.webDistDir ?? null,
      configPath: resolve(configPath),
      allowedRoots: [...settings.allowedRoots],
    },
  });

  if (options.webDistDir !== undefined && existsSync(options.webDistDir)) {
    // Hono 同时托管 Dashboard 静态产物（方案 3.10：单容器提供 API + 前端）
    app.use('*', serveStatic({ root: options.webDistDir }));
    // SPA fallback：非 API/指标路径的未命中请求回退 index.html，前端深链接（如 /reviews/:id）刷新可用。
    // 直接读文件返回：serveStatic 的 rewriteRequestPath 路径在 node-server 下存在流式响应兼容问题
    const indexHtmlPath = join(options.webDistDir, 'index.html');
    const indexHtml = readFileSync(indexHtmlPath, 'utf8');
    app.get('*', (c) => {
      if (c.req.path.startsWith('/api/') || c.req.path === '/metrics') return c.notFound();
      return c.html(indexHtml);
    });
  }

  const server = serve({ fetch: app.fetch, port: options.port });
  console.log(`ai-review server listening on http://localhost:${options.port}`);
  await new Promise<void>((keepAlive) => {
    server.on('close', () => keepAlive());
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await startServer(parseArgs(process.argv.slice(2)));
}
