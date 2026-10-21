import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { and, count, desc, eq, gte, isNotNull, like, lte, or, sql, sum } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import {
  AGENT_DIMENSIONS,
  FindingSchema,
  LLM_RUNTIME_STATUSES,
  describeReviewSource,
} from '@ai-review/shared';
import type {
  AgentCount,
  Finding,
  FindingComment,
  FindingStatus,
  IdentifiedFinding,
  LlmCallAttemptRecord,
  LlmCallRecord,
  ReviewListItem,
  ReviewListQuery,
  ReviewDecisionEvent,
  ReviewMeta,
  ReviewStage,
  ReviewStatsQuery,
  RuleHitStat,
  ReviewReport,
  ReviewReportDetail,
  ReviewSource,
  ReviewStats,
  SeverityCount,
  TokenTrendPoint,
} from '@ai-review/shared';
import {
  findingComments,
  findings,
  llmCalls,
  reviewCache,
  reviewDecisionEvents,
  reviewStages,
  reviews,
} from './schema.js';
import type {
  FindingCommentRow,
  LlmCallRow,
  ReviewDecisionEventRow,
  ReviewStageRow,
} from './schema.js';
import { runMigrations } from './migrations.js';

// API 契约类型以 shared 为单一事实源，此处转出口供既有调用方使用
export type { IdentifiedFinding, ReviewListItem, ReviewReportDetail } from '@ai-review/shared';
export { UserStore } from './user-store.js';
export type { SafeUser } from './user-store.js';

/**
 * 报告元信息中不落独立列的扩展字段（M1 阶段以 report_json 承载，
 * 避免为了展示型字段引入迁移；需要聚合查询时再升级为列）。
 */
const StoredMetaExtraSchema = z.object({
  changeRiskScore: z.number().optional(),
  reviewScore: z.number().optional(),
  llmStatus: z.enum(LLM_RUNTIME_STATUSES).optional(),
  dimensions: z.array(z.string()).optional(),
  cacheHits: z.number().int().nonnegative().optional(),
  healRounds: z.number().int().nonnegative().optional(),
  promptVersion: z.string().optional(),
  truncatedFiles: z.array(z.string()).optional(),
  skippedFiles: z.array(z.string()).optional(),
  sourceLabel: z.string().optional(),
  trigger: z.enum(['web', 'hook', 'ci', 'api']).optional(),
  blockOn: z.enum(['BLOCKER', 'WARNING', 'NIT']).optional(),
});
type StoredMetaExtra = z.infer<typeof StoredMetaExtraSchema>;

/** 只写入已定义的扩展字段，避免把 undefined 写进 JSON */
function toStoredMeta(meta: ReviewMeta): StoredMetaExtra {
  const extra: StoredMetaExtra = {};
  if (meta.changeRiskScore !== undefined) extra.changeRiskScore = meta.changeRiskScore;
  if (meta.reviewScore !== undefined) extra.reviewScore = meta.reviewScore;
  if (meta.llmStatus !== undefined) extra.llmStatus = meta.llmStatus;
  if (meta.dimensions !== undefined) extra.dimensions = meta.dimensions;
  if (meta.cacheHits !== undefined) extra.cacheHits = meta.cacheHits;
  if (meta.healRounds !== undefined) extra.healRounds = meta.healRounds;
  if (meta.promptVersion !== undefined) extra.promptVersion = meta.promptVersion;
  if (meta.truncatedFiles !== undefined) extra.truncatedFiles = meta.truncatedFiles;
  if (meta.skippedFiles !== undefined) extra.skippedFiles = meta.skippedFiles;
  if (meta.sourceLabel !== undefined) extra.sourceLabel = meta.sourceLabel;
  if (meta.trigger !== undefined) extra.trigger = meta.trigger;
  if (meta.blockOn !== undefined) extra.blockOn = meta.blockOn;
  return extra;
}

/** llm_calls.attempts_json 的结构校验（损坏时按空数组降级） */
const StoredAttemptSchema = z.object({
  kind: z.string(),
  provider: z.string(),
  model: z.string(),
  status: z.enum(['succeeded', 'failed']),
  latencyMs: z.number(),
  errorKind: z.string().optional(),
  message: z.string().optional(),
});

function parseAttempts(value: string): LlmCallAttemptRecord[] {
  try {
    const parsed = z.array(StoredAttemptSchema).safeParse(JSON.parse(value));
    if (!parsed.success) return [];
    // exactOptionalPropertyTypes：不能把 undefined 显式赋给可选字段
    return parsed.data.map((attempt) => ({
      kind: attempt.kind,
      provider: attempt.provider,
      model: attempt.model,
      status: attempt.status,
      latencyMs: attempt.latencyMs,
      ...(attempt.errorKind === undefined ? {} : { errorKind: attempt.errorKind }),
      ...(attempt.message === undefined ? {} : { message: attempt.message }),
    }));
  } catch {
    return [];
  }
}

/** DB 行 → 调用记录（attempts 从 JSON 列还原） */
function toLlmCallRecord(row: LlmCallRow): LlmCallRecord {
  return {
    dimension: row.dimension,
    provider: row.provider,
    model: row.model,
    status: row.status,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    estimated: row.estimated,
    latencyMs: row.latencyMs,
    promptChars: row.promptChars,
    fallbackUsed: row.fallbackUsed,
    round: row.round,
    attempts: parseAttempts(row.attemptsJson),
  };
}

/** 报告 JSON 中非规范化段落的结构校验（规范 §5.5：读回的运行时数据必须经 zod 校验） */
const StoredReportSchema = z.object({
  summary: z.string(),
  qualityNotes: z.array(z.string()),
  suggestions: z.array(z.string()),
  assessment: z.string(),
  degradedToStatic: z.array(z.string()),
  meta: StoredMetaExtraSchema.optional(),
});

/** 解析 JSON 数组列（损坏时按缺省处理，避免一条脏数据拖垮整份报告） */
function parseStringArray(value: string | null): string[] | undefined {
  if (value === null || value === '') return undefined;
  try {
    const parsed = z.array(z.string()).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** 解析发现命中的维度列表；非法内容按缺省处理 */
function parseFindingAgents(value: string | null): Finding['agents'] {
  if (value === null || value === '') return undefined;
  try {
    const parsed = z.array(z.enum(AGENT_DIMENSIONS)).safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 从落库的 target/source_label 还原审查来源。
 * source_label 形如 `commit:abc1234`、`range:main...HEAD`，与 describeReviewSource 对称；
 * 解析失败时退回 staged（存量记录语义），保证重跑不会因脏数据失败。
 */
function parseStoredSource(target: string | null, label: string | null): ReviewSource {
  if (target === 'worktree') return { target: 'worktree' };
  if (target === 'commit') {
    const commit = label?.startsWith('commit:') === true ? label.slice('commit:'.length) : '';
    if (commit !== '') return { target: 'commit', commit };
  }
  if (target === 'range') {
    const body = label?.startsWith('range:') === true ? label.slice('range:'.length) : '';
    const separator = body.indexOf('...');
    if (separator > 0) {
      const base = body.slice(0, separator);
      const head = body.slice(separator + 3);
      if (base !== '' && head !== '') return { target: 'range', base, head };
    }
  }
  return { target: 'staged' };
}

/** 持久层错误（行损坏、目标不存在等） */
export class StoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreError';
  }
}

/**
 * 审查结果存储（SQLite，Drizzle ORM 访问）。
 * 建表语句与 schema.ts 的列定义一一对应；不引入 drizzle-kit 迁移链路——
 * 当前为单机嵌入式库，CREATE TABLE IF NOT EXISTS 的幂等初始化已满足需求（迁移工具属团队版后续任务）。
 */
export class ReviewStore {
  private readonly db: BetterSQLite3Database;

  /**
   * @param sqlite better-sqlite3 连接；传 ':memory:' 可获得进程内库（测试用）
   */
  constructor(private readonly sqlite: Database.Database) {
    const file = sqlite.name;
    // WAL 仅对文件库有意义；:memory: 库设置 journal_mode 会被 SQLite 忽略/报错
    if (file !== ':memory:') sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS reviews (
        id              TEXT PRIMARY KEY,
        repo_path       TEXT NOT NULL,
        branch          TEXT NOT NULL,
        commit_hash     TEXT,
        author          TEXT,
        model           TEXT NOT NULL,
        mode            TEXT NOT NULL,
        block_on        TEXT,
        target          TEXT,
        source_label    TEXT,
        status          TEXT NOT NULL DEFAULT 'completed',
        risk_score      REAL NOT NULL,
        total_findings  INTEGER NOT NULL DEFAULT 0,
        blocker_count   INTEGER NOT NULL DEFAULT 0,
        warning_count   INTEGER NOT NULL DEFAULT 0,
        nit_count       INTEGER NOT NULL DEFAULT 0,
        token_used      INTEGER NOT NULL DEFAULT 0,
        duration_ms     INTEGER NOT NULL,
        report_json     TEXT NOT NULL,
        diff_text       TEXT,
        error_message   TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS findings (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        review_id          TEXT NOT NULL REFERENCES reviews(id),
        agent              TEXT NOT NULL,
        severity           TEXT NOT NULL,
        confidence         REAL NOT NULL,
        file_path          TEXT NOT NULL,
        line_start         INTEGER NOT NULL,
        line_end           INTEGER NOT NULL,
        title              TEXT NOT NULL,
        description        TEXT NOT NULL,
        suggestion         TEXT,
        code_snippet       TEXT,
        cwe_id             TEXT,
        low_confidence     INTEGER NOT NULL DEFAULT 0,
        is_false_positive  INTEGER NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_findings_review ON findings(review_id);
      CREATE TABLE IF NOT EXISTS review_cache (
        cache_key      TEXT PRIMARY KEY,
        review_id      TEXT,
        findings_json  TEXT NOT NULL,
        token_saved    INTEGER NOT NULL DEFAULT 0,
        created_at     TEXT NOT NULL
      );
    `);
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'user',
        status        TEXT NOT NULL DEFAULT 'active',
        created_at    TEXT NOT NULL,
        last_login_at TEXT,
        avatar_url    TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token       TEXT PRIMARY KEY,
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at  TEXT NOT NULL,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS roles (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL UNIQUE,
        description   TEXT,
        priority      INTEGER NOT NULL DEFAULT 100,
        permissions   TEXT NOT NULL DEFAULT '[]',
        is_system     INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_roles (
        user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role_id     TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (user_id, role_id)
      );
    `);
    // 统一迁移：补列、补索引、记录版本（幂等；旧库与新库走同一条路径）
    runMigrations(sqlite);
    seedRoles(sqlite);
    this.db = drizzle(sqlite);
  }

  /**
   * 持久化一份完整审查报告（事务：reviews 主行 + findings 行级明细）。
   * @param report 流水线产出的类型化报告
   * @param createdBy 发起人用户 id（Web 端触发时记录，用于数据隔离；CLI 直跑时缺省）
   * @returns 审查 ID（即 report.meta.reviewId）
   */
  public saveReport(
    report: ReviewReport,
    createdBy?: string,
    options: {
      diffText?: string | null;
      errorMessage?: string | null;
      /** 发起时配置的阻断阈值（BLOCKER/WARNING/NIT）；持久化供 SSE 晚连接重放按原阈值重算 blocking */
      blockOn?: 'BLOCKER' | 'WARNING' | 'NIT';
      /** 审查来源；持久化供 rerun 复现同一范围 */
      source?: ReviewSource;
    } = {},
  ): string {
    const reviewId = report.meta.reviewId;
    const count = (severity: string): number =>
      report.findings.filter((finding) => finding.severity === severity).length;

    this.db.transaction(() => {
      this.db
        .insert(reviews)
        .values({
          id: reviewId,
          repoPath: report.meta.repoPath,
          branch: report.meta.branch,
          commitHash: report.meta.commitHash,
          author: report.meta.author,
          model: report.meta.model,
          mode: report.meta.mode,
          blockOn: options.blockOn ?? null,
          target: options.source?.target ?? null,
          sourceLabel: options.source === undefined ? null : describeReviewSource(options.source),
          status: report.meta.status ?? 'completed',
          riskScore: report.meta.riskScore,
          totalFindings: report.findings.length,
          blockerCount: count('BLOCKER'),
          warningCount: count('WARNING'),
          nitCount: count('NIT'),
          tokenUsed: report.meta.tokenUsed,
          durationMs: report.meta.durationMs,
          createdBy: createdBy ?? null,
          changeRiskScore: report.meta.changeRiskScore ?? null,
          reviewScore: report.meta.reviewScore ?? report.meta.riskScore,
          llmStatus: report.meta.llmStatus ?? null,
          promptVersion: report.meta.promptVersion ?? null,
          cacheHits: report.meta.cacheHits ?? 0,
          healRounds: report.meta.healRounds ?? 0,
          dimensions:
            report.meta.dimensions === undefined ? null : JSON.stringify(report.meta.dimensions),
          diffText:
            options.diffText === undefined
              ? null
              : (options.diffText?.slice(0, 2 * 1024 * 1024) ?? null),
          errorMessage: options.errorMessage ?? report.meta.errorMessage ?? null,
          reportJson: JSON.stringify({
            summary: report.summary,
            qualityNotes: report.qualityNotes,
            suggestions: report.suggestions,
            assessment: report.assessment,
            degradedToStatic: report.degradedToStatic,
            meta: toStoredMeta(report.meta),
          }),
        })
        .run();
      if (report.findings.length > 0) {
        this.db
          .insert(findings)
          .values(
            report.findings.map((finding) => ({
              reviewId,
              agent: finding.agent,
              severity: finding.severity,
              confidence: finding.confidence,
              filePath: finding.filePath,
              lineStart: finding.lineStart,
              lineEnd: finding.lineEnd,
              title: finding.title,
              description: finding.description,
              suggestion: finding.suggestion,
              codeSnippet: finding.codeSnippet,
              cweId: finding.cweId,
              lowConfidence: finding.lowConfidence ?? false,
              isFalsePositive: finding.isFalsePositive,
              fingerprint: finding.fingerprint ?? null,
              origin: finding.origin ?? null,
              lineScope: finding.lineScope ?? null,
              agents: finding.agents === undefined ? null : JSON.stringify(finding.agents),
              status: finding.status ?? 'open',
              ruleId: finding.ruleId ?? null,
            })),
          )
          .run();
      }
    });
    return reviewId;
  }

  /**
   * 审查历史（Dashboard 列表页，按创建时间倒序）。
   * @param options.createdBy 数据隔离过滤：普通用户仅见本人记录（admin 省略此参数）
   */
  public listReviews(options: { limit?: number; createdBy?: string } = {}): ReviewListItem[] {
    const { limit = 50, createdBy } = options;
    const rows = this.db
      .select()
      .from(reviews)
      .where(createdBy === undefined ? undefined : eq(reviews.createdBy, createdBy))
      .orderBy(desc(reviews.createdAt), desc(reviews.id))
      .limit(limit)
      .all();
    return rows.map((row) => ({
      reviewId: row.id,
      repoPath: row.repoPath,
      branch: row.branch,
      commitHash: row.commitHash,
      ...(row.target === null ? {} : { target: row.target as ReviewListItem['target'] }),
      ...(row.sourceLabel === null ? {} : { sourceLabel: row.sourceLabel }),
      model: row.model,
      mode: row.mode,
      status: row.status,
      errorMessage: row.errorMessage,
      riskScore: row.riskScore,
      totalFindings: row.totalFindings,
      blockerCount: row.blockerCount,
      warningCount: row.warningCount,
      nitCount: row.nitCount,
      tokenUsed: row.tokenUsed,
      durationMs: row.durationMs,
      createdAt: row.createdAt,
      createdBy: row.createdBy,
    }));
  }

  /** 服务端分页查询；保留 listReviews 的旧数组 API 供 CLI 与既有调用方使用。 */
  public listReviewPage(
    query: ReviewListQuery,
    createdBy?: string,
  ): { reviews: ReviewListItem[]; total: number; page: number; pageSize: number } {
    const filters = [
      createdBy === undefined ? undefined : eq(reviews.createdBy, createdBy),
      query.status === undefined ? undefined : eq(reviews.status, query.status),
      query.mode === undefined ? undefined : eq(reviews.mode, query.mode),
      query.repo === undefined ? undefined : like(reviews.repoPath, `%${query.repo}%`),
      query.branch === undefined ? undefined : like(reviews.branch, `%${query.branch}%`),
      query.from === undefined ? undefined : gte(reviews.createdAt, query.from),
      query.to === undefined
        ? undefined
        : lte(reviews.createdAt, query.to.length === 10 ? `${query.to}T23:59:59.999Z` : query.to),
      query.q === undefined
        ? undefined
        : or(
            like(reviews.repoPath, `%${query.q}%`),
            like(reviews.branch, `%${query.q}%`),
            like(reviews.id, `%${query.q}%`),
          ),
      query.severity === 'BLOCKER' ? gte(reviews.blockerCount, 1) : undefined,
      query.severity === 'WARNING' ? gte(reviews.warningCount, 1) : undefined,
      query.severity === 'NIT' ? gte(reviews.nitCount, 1) : undefined,
    ];
    const where = and(...filters);
    // 方案 9：总数用 SQL COUNT 聚合，避免把全部匹配行读进内存仅为了计数
    const totalRow = this.db.select({ value: count() }).from(reviews).where(where).get();
    const total = totalRow?.value ?? 0;
    const rows = this.db
      .select()
      .from(reviews)
      .where(where)
      .orderBy(desc(reviews.createdAt), desc(reviews.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .all();
    return {
      reviews: rows.map((row) => ({
        reviewId: row.id,
        repoPath: row.repoPath,
        branch: row.branch,
        commitHash: row.commitHash,
        ...(row.target === null ? {} : { target: row.target as ReviewListItem['target'] }),
        ...(row.sourceLabel === null ? {} : { sourceLabel: row.sourceLabel }),
        model: row.model,
        mode: row.mode,
        status: row.status,
        errorMessage: row.errorMessage,
        riskScore: row.riskScore,
        totalFindings: row.totalFindings,
        blockerCount: row.blockerCount,
        warningCount: row.warningCount,
        nitCount: row.nitCount,
        tokenUsed: row.tokenUsed,
        durationMs: row.durationMs,
        createdAt: row.createdAt,
        createdBy: row.createdBy,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * 读取报告状态（方案 14：SSE 晚连接兜底仅需状态，避免解析完整报告与 findings）。
   * @returns 报告不存在返回 undefined
   */
  public getReportStatus(reviewId: string):
    | {
        status: 'completed' | 'failed' | 'cancelled';
        errorMessage: string | null;
        riskScore: number;
        blockerCount: number;
        warningCount: number;
        nitCount: number;
        blockOn: 'BLOCKER' | 'WARNING' | 'NIT' | null;
      }
    | undefined {
    const row = this.db
      .select({
        status: reviews.status,
        errorMessage: reviews.errorMessage,
        riskScore: reviews.riskScore,
        blockerCount: reviews.blockerCount,
        warningCount: reviews.warningCount,
        nitCount: reviews.nitCount,
        blockOn: reviews.blockOn,
      })
      .from(reviews)
      .where(eq(reviews.id, reviewId))
      .get();
    if (row === undefined) return undefined;
    return {
      status: row.status,
      errorMessage: row.errorMessage,
      riskScore: row.riskScore,
      blockerCount: row.blockerCount,
      warningCount: row.warningCount,
      nitCount: row.nitCount,
      blockOn: row.blockOn,
    };
  }

  /** 读取审查输入，供服务端重跑时复用原始仓库、模式、审查来源与阻断阈值。 */
  public getReviewInput(reviewId: string): {
    repoPath: string;
    mode: 'fast' | 'full';
    source: ReviewSource;
    blockOn: 'BLOCKER' | 'WARNING' | 'NIT' | null;
    createdBy: string | null;
  } {
    const row = this.db
      .select({
        repoPath: reviews.repoPath,
        mode: reviews.mode,
        blockOn: reviews.blockOn,
        target: reviews.target,
        sourceLabel: reviews.sourceLabel,
        createdBy: reviews.createdBy,
      })
      .from(reviews)
      .where(eq(reviews.id, reviewId))
      .get();
    if (row === undefined) throw new StoreError(`审查记录不存在`);
    return {
      repoPath: row.repoPath,
      mode: row.mode,
      source: parseStoredSource(row.target, row.sourceLabel),
      blockOn: row.blockOn,
      createdBy: row.createdBy,
    };
  }

  /**
   * 读取历史审查出现过的仓库路径（去重），供 Web 的仓库选择器复用。
   * @param limit 最多返回的记录数（按创建时间倒序取）
   * @returns 仓库路径列表（可能重复，调用方负责去重）
   */
  public listRepoPaths(limit = 200): string[] {
    return this.db
      .select({ repoPath: reviews.repoPath })
      .from(reviews)
      .groupBy(reviews.repoPath)
      .orderBy(desc(reviews.repoPath))
      .limit(limit)
      .all()
      .map((row) => row.repoPath);
  }

  /** 读取原始 diff；旧记录没有持久化 diff 时返回 null。 */
  public getDiff(reviewId: string): string | null {
    const row = this.db
      .select({ diffText: reviews.diffText })
      .from(reviews)
      .where(eq(reviews.id, reviewId))
      .get();
    if (row === undefined) throw new StoreError(`审查记录不存在`);
    return row.diffText;
  }

  /** 删除审查及其发现/调用明细，显式级联以兼容存量库没有外键级联的情况。 */
  public deleteReview(reviewId: string): boolean {
    const transaction = this.sqlite.transaction(() => {
      this.db.delete(llmCalls).where(eq(llmCalls.reviewId, reviewId)).run();
      this.db.delete(reviewStages).where(eq(reviewStages.reviewId, reviewId)).run();
      this.db.delete(reviewDecisionEvents).where(eq(reviewDecisionEvents.reviewId, reviewId)).run();
      // 评论通过 finding_id 间接关联审查；先按子查询清理，避免外键约束阻止删除
      this.sqlite
        .prepare(
          'DELETE FROM finding_comments WHERE finding_id IN (SELECT id FROM findings WHERE review_id = ?)',
        )
        .run(reviewId);
      this.db.delete(findings).where(eq(findings.reviewId, reviewId)).run();
      const result = this.db.delete(reviews).where(eq(reviews.id, reviewId)).run();
      return result.changes > 0;
    });
    return transaction();
  }

  /**
   * 报告详情：非规范化段落取自 report_json（zod 校验），findings 以行级存储为准
   * （isFalsePositive 可能已被 Dashboard 更新，不能回用 JSON 快照中的旧值）。
   * @throws {StoreError} 报告不存在或行损坏
   */
  public getReportDetail(reviewId: string): ReviewReportDetail {
    const row = this.db.select().from(reviews).where(eq(reviews.id, reviewId)).get();
    if (row === undefined) throw new StoreError(`审查记录不存在`);

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(row.reportJson);
    } catch (e) {
      throw new StoreError(`报告数据损坏，请删除该审查后重试`, { cause: e });
    }
    const stored = StoredReportSchema.safeParse(parsedJson);
    if (!stored.success) {
      throw new StoreError(`报告数据损坏，请删除该审查后重试`, {
        cause: stored.error,
      });
    }

    const findingRows = this.db
      .select()
      .from(findings)
      .where(eq(findings.reviewId, reviewId))
      .orderBy(findings.id)
      .all();
    const mapped: IdentifiedFinding[] = findingRows.map((findingRow) => {
      const agents = parseFindingAgents(findingRow.agents);
      // SQLite 列缺省读回 null，而 Finding 契约的 optional 语义是 undefined，先归一化再过 zod。
      // 新列必须显式映射：agents 在库里是 JSON 字符串，直接展开会破坏 schema。
      const parsed = FindingSchema.parse({
        agent: findingRow.agent,
        severity: findingRow.severity,
        confidence: findingRow.confidence,
        filePath: findingRow.filePath,
        lineStart: findingRow.lineStart,
        lineEnd: findingRow.lineEnd,
        title: findingRow.title,
        description: findingRow.description,
        suggestion: findingRow.suggestion ?? undefined,
        codeSnippet: findingRow.codeSnippet ?? undefined,
        cweId: findingRow.cweId ?? undefined,
        lowConfidence: findingRow.lowConfidence,
        isFalsePositive: findingRow.isFalsePositive,
        ...(findingRow.fingerprint === null ? {} : { fingerprint: findingRow.fingerprint }),
        ...(findingRow.origin === null ? {} : { origin: findingRow.origin }),
        ...(findingRow.lineScope === null ? {} : { lineScope: findingRow.lineScope }),
        ...(findingRow.ruleId === null ? {} : { ruleId: findingRow.ruleId }),
        ...(findingRow.status === null ? {} : { status: findingRow.status }),
        ...(agents === undefined ? {} : { agents }),
      });
      return { ...parsed, id: findingRow.id };
    });

    return {
      meta: {
        reviewId: row.id,
        repoPath: row.repoPath,
        branch: row.branch,
        commitHash: row.commitHash ?? undefined,
        author: row.author ?? undefined,
        model: row.model,
        mode: row.mode,
        status: row.status,
        errorMessage: row.errorMessage ?? undefined,
        riskScore: row.riskScore,
        reviewScore: row.reviewScore ?? row.riskScore,
        ...(row.changeRiskScore === null ? {} : { changeRiskScore: row.changeRiskScore }),
        ...(row.llmStatus === null ? {} : { llmStatus: row.llmStatus }),
        cacheHits: row.cacheHits,
        healRounds: row.healRounds,
        ...(row.dimensions === null ? {} : { dimensions: parseStringArray(row.dimensions) ?? [] }),
        ...(row.promptVersion === null ? {} : { promptVersion: row.promptVersion }),
        ...(row.decision === null ? {} : { decision: row.decision }),
        ...(row.decisionComment === null ? {} : { decisionComment: row.decisionComment }),
        ...(row.decidedBy === null ? {} : { decidedBy: row.decidedBy }),
        ...(row.decidedAt === null ? {} : { decidedAt: row.decidedAt }),
        durationMs: row.durationMs,
        tokenUsed: row.tokenUsed,
        // 扩展字段以 report_json 为准；旧报告没有该段时使用上面的列值/缺省（前端按 optional 处理）
        ...(stored.data.meta ?? {}),
      },
      summary: stored.data.summary,
      findings: mapped,
      qualityNotes: stored.data.qualityNotes,
      suggestions: stored.data.suggestions,
      assessment: stored.data.assessment,
      degradedToStatic: stored.data.degradedToStatic,
    };
  }

  /**
   * 标记/取消误报（Dashboard 乐观更新后回写，方案 3.10）。
   * @returns 目标发现是否存在
   */
  public setFindingFalsePositive(findingId: number, isFalsePositive: boolean): boolean {
    const result = this.db
      .update(findings)
      .set({ isFalsePositive })
      .where(eq(findings.id, findingId))
      .run();
    return result.changes > 0;
  }

  /**
   * 更新发现的处置状态/误报标记（人工闭环）。
   * status=false_positive 时同步置 isFalsePositive=true，避免两个字段互相矛盾。
   * @param findingId 发现行 id
   * @param patch 状态与/或误报标记
   * @returns 目标发现是否存在
   */
  public updateFinding(
    findingId: number,
    patch: { status?: FindingStatus; isFalsePositive?: boolean },
  ): boolean {
    const falsePositive = patch.status === 'false_positive' ? true : patch.isFalsePositive;
    const result = this.db
      .update(findings)
      .set({
        ...(patch.status === undefined ? {} : { status: patch.status }),
        ...(falsePositive === undefined ? {} : { isFalsePositive: falsePositive }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(findings.id, findingId))
      .run();
    return result.changes > 0;
  }

  /**
   * 新增发现评论。
   * @returns 落库后的评论行
   */
  public addFindingComment(input: {
    findingId: number;
    userId: string;
    username: string;
    body: string;
  }): FindingComment {
    const createdAt = new Date().toISOString();
    const result = this.db
      .insert(findingComments)
      .values({
        findingId: input.findingId,
        userId: input.userId,
        username: input.username,
        body: input.body,
        createdAt,
      })
      .run();
    return {
      id: Number(result.lastInsertRowid),
      findingId: input.findingId,
      userId: input.userId,
      username: input.username,
      body: input.body,
      createdAt,
    };
  }

  /**
   * 读取某条发现的评论（按时间升序）。
   * @param findingId 发现行 id
   */
  public listFindingComments(findingId: number): FindingComment[] {
    return this.db
      .select()
      .from(findingComments)
      .where(eq(findingComments.findingId, findingId))
      .orderBy(findingComments.id)
      .all()
      .map((row: FindingCommentRow) => ({
        id: row.id,
        findingId: row.findingId,
        userId: row.userId,
        username: row.username,
        body: row.body,
        createdAt: row.createdAt,
      }));
  }

  /**
   * 写入人工审查决策（approve / request_changes / comment）。
   * @returns 审查是否存在
   */
  public setReviewDecision(
    reviewId: string,
    decision: 'approve' | 'request_changes' | 'comment',
    comment: string | undefined,
    decidedBy: string,
  ): boolean {
    const createdAt = new Date().toISOString();
    const transaction = this.sqlite.transaction(() => {
      const result = this.db
        .update(reviews)
        .set({
          decision,
          decisionComment: comment ?? null,
          decidedBy,
          decidedAt: createdAt,
        })
        .where(eq(reviews.id, reviewId))
        .run();
      if (result.changes === 0) return false;
      this.db
        .insert(reviewDecisionEvents)
        .values({
          reviewId,
          decision,
          comment: comment ?? null,
          decidedBy,
          createdAt,
        })
        .run();
      return true;
    });
    return transaction();
  }

  /**
   * 读取某次审查的决策历史（append-only，按写入顺序）。
   * @param reviewId 审查 id
   */
  public listReviewDecisionEvents(reviewId: string): ReviewDecisionEvent[] {
    return this.db
      .select()
      .from(reviewDecisionEvents)
      .where(eq(reviewDecisionEvents.reviewId, reviewId))
      .orderBy(reviewDecisionEvents.id)
      .all()
      .map((row: ReviewDecisionEventRow) => ({
        id: row.id,
        reviewId: row.reviewId,
        decision: row.decision,
        comment: row.comment,
        decidedBy: row.decidedBy,
        createdAt: row.createdAt,
      }));
  }

  /**
   * 查询审查发起人（server 层归属校验用：非本人且非 admin 一律按不存在处理）。
   * @returns 发起人用户 id；CLI 直跑的存量记录或行不存在返回 null
   */
  public getReviewOwner(reviewId: string): string | null {
    const row = this.db
      .select({ createdBy: reviews.createdBy })
      .from(reviews)
      .where(eq(reviews.id, reviewId))
      .get();
    return row?.createdBy ?? null;
  }

  /**
   * 查询发现所属审查的发起人（误报标记 API 的归属校验：API 只有 finding id）。
   * @returns 发起人用户 id；审查无发起人（CLI 存量）或行不存在返回 null
   */
  public getFindingReviewOwner(findingId: number): string | null {
    const row = this.db
      .select({ createdBy: reviews.createdBy })
      .from(findings)
      .innerJoin(reviews, eq(findings.reviewId, reviews.id))
      .where(eq(findings.id, findingId))
      .get();
    return row?.createdBy ?? null;
  }

  /**
   * 保存一次审查的模型调用明细（事务；空数组直接返回）。
   * @param reviewId 审查 id
   * @param calls 每个维度/每个自愈轮次一条
   */
  public saveLlmCalls(reviewId: string, calls: readonly LlmCallRecord[]): void {
    if (calls.length === 0) return;
    this.db.transaction(() => {
      this.db
        .insert(llmCalls)
        .values(
          calls.map((call) => ({
            reviewId,
            dimension: call.dimension,
            provider: call.provider,
            model: call.model,
            status: call.status,
            round: call.round,
            promptTokens: call.promptTokens,
            completionTokens: call.completionTokens,
            totalTokens: call.totalTokens,
            estimated: call.estimated,
            latencyMs: call.latencyMs,
            promptChars: call.promptChars,
            fallbackUsed: call.fallbackUsed,
            attemptsJson: JSON.stringify(call.attempts),
          })),
        )
        .run();
    });
  }

  /**
   * 追加一个流水线节点检查点（节点完成/失败时调用）。
   * @param stage 节点、状态、起止时间、耗时与摘要
   * @returns 落库后的记录（含自增 id）
   */
  public saveReviewStage(stage: {
    reviewId: string;
    node: string;
    status: 'completed' | 'failed';
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    detail?: string;
  }): ReviewStage {
    const result = this.db
      .insert(reviewStages)
      .values({
        reviewId: stage.reviewId,
        node: stage.node,
        status: stage.status,
        startedAt: stage.startedAt,
        finishedAt: stage.finishedAt,
        durationMs: stage.durationMs,
        detail: stage.detail ?? null,
      })
      .run();
    return {
      id: Number(result.lastInsertRowid),
      node: stage.node,
      status: stage.status,
      startedAt: stage.startedAt,
      finishedAt: stage.finishedAt,
      durationMs: stage.durationMs,
      ...(stage.detail === undefined ? {} : { detail: stage.detail }),
    };
  }

  /**
   * 读取某次审查的节点检查点（按写入顺序）。
   * @param reviewId 审查 id
   */
  public listReviewStages(reviewId: string): ReviewStage[] {
    return this.db
      .select()
      .from(reviewStages)
      .where(eq(reviewStages.reviewId, reviewId))
      .orderBy(reviewStages.id)
      .all()
      .map((row: ReviewStageRow) => ({
        id: row.id,
        node: row.node,
        status: row.status,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        durationMs: row.durationMs,
        ...(row.detail === null ? {} : { detail: row.detail }),
      }));
  }

  /**
   * 清理没有对应 reviews 行的检查点（进程崩溃/手工删库残留）。
   * 检查点先于 reviews 行写入，故不能依赖外键级联。
   * @returns 删除行数
   */
  public pruneOrphanReviewStages(): number {
    return this.sqlite
      .prepare('DELETE FROM review_stages WHERE review_id NOT IN (SELECT id FROM reviews)')
      .run().changes;
  }

  /**
   * 读取某次审查的模型调用明细（按写入顺序）。
   * @param reviewId 审查 id
   */
  public getLlmCalls(reviewId: string): LlmCallRecord[] {
    return this.db
      .select()
      .from(llmCalls)
      .where(eq(llmCalls.reviewId, reviewId))
      .orderBy(llmCalls.id)
      .all()
      .map(toLlmCallRecord);
  }

  /**
   * 最近的模型调用（管理台可观测页数据源）。
   * @param limit 返回条数上限
   */
  public listRecentLlmCalls(
    limit = 200,
  ): Array<LlmCallRecord & { reviewId: string; createdAt: string }> {
    return this.db
      .select()
      .from(llmCalls)
      .orderBy(desc(llmCalls.createdAt), desc(llmCalls.id))
      .limit(limit)
      .all()
      .map((row) => ({
        ...toLlmCallRecord(row),
        reviewId: row.reviewId,
        createdAt: row.createdAt,
      }));
  }

  /**
   * 读取审查缓存（方案 3.0 步骤 8：内容哈希去重，供 core 的 ReviewCache 接口调用）。
   * @returns 命中时返回该键的全部发现；未命中或条目损坏（JSON/zod 校验失败）返回 undefined——
   *          缓存损坏按"未命中"降级重审，属规范 §7.7 的可降级错误，不阻断流水线
   */
  public getCachedFindings(cacheKey: string): Finding[] | undefined {
    const row = this.db.select().from(reviewCache).where(eq(reviewCache.cacheKey, cacheKey)).get();
    if (row === undefined) return undefined;

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(row.findingsJson);
    } catch {
      return undefined;
    }
    if (!Array.isArray(parsedJson)) return undefined;
    const result = z.array(FindingSchema).safeParse(parsedJson);
    return result.success ? result.data : undefined;
  }

  /**
   * 写入审查缓存（insert or replace：相同键以最新审查口径为准）。
   * @param reviewId 产出该条目的审查（供追溯，可空——缓存由内容哈希寻址，与审查弱关联）
   * @param entries 键为 core 生成的内容哈希
   */
  public saveCacheEntries(
    reviewId: string | undefined,
    entries: ReadonlyArray<{ cacheKey: string; findings: Finding[]; tokenSaved: number }>,
  ): void {
    if (entries.length === 0) return;
    this.db.transaction(() => {
      for (const entry of entries) {
        this.db
          .insert(reviewCache)
          .values({
            cacheKey: entry.cacheKey,
            reviewId: reviewId ?? null,
            findingsJson: JSON.stringify(entry.findings),
            tokenSaved: entry.tokenSaved,
          })
          .onConflictDoUpdate({
            target: reviewCache.cacheKey,
            set: {
              reviewId,
              findingsJson: JSON.stringify(entry.findings),
              tokenSaved: entry.tokenSaved,
            },
          })
          .run();
      }
    });
  }

  /** 缓存表规模与累计节省 token（成本观测，方案 §七 成本估算的落地数据） */
  public getCacheSummary(): { entries: number; tokenSaved: number } {
    // 方案 10：COUNT + SUM 一次 SQL 聚合，避免全表读入 JS 累加
    const row = this.db
      .select({ entries: count(), tokenSaved: sum(reviewCache.tokenSaved) })
      .from(reviewCache)
      .get();
    return { entries: Number(row?.entries ?? 0), tokenSaved: Number(row?.tokenSaved ?? 0) };
  }

  /**
   * 自定义规则命中统计（按 ruleId 聚合，最多 50 条）。
   * @param ownerId 数据隔离过滤：普通用户仅统计本人数据（admin 省略）
   * @param range 时间范围（与 Dashboard 统计一致）
   */
  public getRuleHitStats(ownerId?: string, range: ReviewStatsQuery = {}): RuleHitStat[] {
    const conditions = [isNotNull(findings.ruleId)];
    if (ownerId !== undefined) conditions.push(eq(reviews.createdBy, ownerId));
    if (range.from !== undefined) conditions.push(gte(reviews.createdAt, range.from));
    if (range.to !== undefined) conditions.push(lte(reviews.createdAt, range.to));
    const rows = this.db
      .select({
        ruleId: findings.ruleId,
        total: sql<number>`count(*)`,
        blocker: sql<number>`sum(case when ${findings.severity} = 'BLOCKER' then 1 else 0 end)`,
        warning: sql<number>`sum(case when ${findings.severity} = 'WARNING' then 1 else 0 end)`,
        nit: sql<number>`sum(case when ${findings.severity} = 'NIT' then 1 else 0 end)`,
        falsePositives: sql<number>`sum(case when ${findings.isFalsePositive} = 1 then 1 else 0 end)`,
      })
      .from(findings)
      .innerJoin(reviews, eq(findings.reviewId, reviews.id))
      .where(and(...conditions))
      .groupBy(findings.ruleId)
      .orderBy(desc(sql`count(*)`))
      .limit(50)
      .all();
    return rows.flatMap((row) =>
      row.ruleId === null
        ? []
        : [
            {
              ruleId: row.ruleId,
              count: Number(row.total ?? 0),
              blocker: Number(row.blocker ?? 0),
              warning: Number(row.warning ?? 0),
              nit: Number(row.nit ?? 0),
              falsePositives: Number(row.falsePositives ?? 0),
            },
          ],
    );
  }

  /**
   * 记录一次审查任务（供进程重启后恢复未完成任务）。
   * @param reviewId 审查 id（LangGraph thread_id）
   * @param options 发起参数（JSON 序列化）
   */
  public saveReviewJob(reviewId: string, options: unknown): void {
    const now = new Date().toISOString();
    this.sqlite
      .prepare(
        `INSERT OR REPLACE INTO review_jobs
         (review_id, options_json, status, created_at, updated_at)
         VALUES (?, ?, 'running', ?, ?)`,
      )
      .run(reviewId, JSON.stringify(options), now, now);
  }

  /**
   * 更新任务终态。
   * @param reviewId 审查 id
   * @param status completed / failed / cancelled
   */
  public setReviewJobStatus(reviewId: string, status: 'completed' | 'failed' | 'cancelled'): void {
    this.sqlite
      .prepare('UPDATE review_jobs SET status = ?, updated_at = ? WHERE review_id = ?')
      .run(status, new Date().toISOString(), reviewId);
  }

  /**
   * 读取上次进程退出时仍处于 running 的任务（启动恢复用）。
   */
  public listRunningReviewJobs(): Array<{ reviewId: string; optionsJson: string }> {
    const rows = this.sqlite
      .prepare("SELECT review_id, options_json FROM review_jobs WHERE status = 'running'")
      .all() as Array<{ review_id: string; options_json: string }>;
    return rows.map((row) => ({ reviewId: row.review_id, optionsJson: row.options_json }));
  }

  /**
   * 清理过期的 LangGraph checkpoint（默认保留 7 天）。
   * 运行中的任务不清理，避免恢复失败；writes 随 checkpoint 一起删除。
   * @param beforeIso 早于该时间的 checkpoint 可删除
   * @returns 删除的 checkpoint 行数
   */
  public pruneLanggraphCheckpoints(beforeIso: string): number {
    const transaction = this.sqlite.transaction(() => {
      const result = this.sqlite
        .prepare(
          `DELETE FROM langgraph_checkpoints
           WHERE created_at < ?
             AND thread_id NOT IN (SELECT review_id FROM review_jobs WHERE status = 'running')`,
        )
        .run(beforeIso);
      this.sqlite
        .prepare(
          `DELETE FROM langgraph_writes
           WHERE NOT EXISTS (
             SELECT 1 FROM langgraph_checkpoints c
             WHERE c.thread_id = langgraph_writes.thread_id
               AND c.checkpoint_ns = langgraph_writes.checkpoint_ns
               AND c.checkpoint_id = langgraph_writes.checkpoint_id
           )`,
        )
        .run();
      return result.changes;
    });
    return transaction();
  }

  /**
   * 统计聚合（Dashboard 统计分析页的数据源，方案 3.10 页面 4）。
   * 数据量为单机审查历史量级（数千行），全表读出后在 JS 侧聚合，
   * 避免 SQLite 字符串日期聚合的方言耦合。
   * @param createdBy 数据隔离过滤：普通用户仅统计本人数据（admin 省略此参数）
   */
  public getStats(
    createdBy?: string,
    range?: { from?: string | undefined; to?: string | undefined },
  ): ReviewStats {
    const conditions = [
      ...(createdBy === undefined ? [] : [eq(reviews.createdBy, createdBy)]),
      ...(range?.from === undefined ? [] : [gte(reviews.createdAt, `${range.from}T00:00:00.000Z`)]),
      ...(range?.to === undefined ? [] : [lte(reviews.createdAt, `${range.to}T23:59:59.999Z`)]),
    ];
    const reviewRows = this.db
      .select()
      .from(reviews)
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .all();
    const reviewIds = new Set(reviewRows.map((row) => row.id));
    const findingRows = this.db
      .select({
        reviewId: findings.reviewId,
        agent: findings.agent,
        filePath: findings.filePath,
        severity: findings.severity,
        isFalsePositive: findings.isFalsePositive,
      })
      .from(findings)
      .innerJoin(reviews, eq(findings.reviewId, reviews.id))
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .all()
      .filter((row) => reviewIds.has(row.reviewId));

    const severityCounts = new Map<string, number>();
    const agentCounts = new Map<string, number>();
    const fileCounts = new Map<string, { findingCount: number; blockerCount: number }>();
    let falsePositiveCount = 0;
    for (const row of findingRows) {
      // is_false_positive 列为 drizzle boolean 模式，读回即 true/false
      if (row.isFalsePositive) falsePositiveCount += 1;
      severityCounts.set(row.severity, (severityCounts.get(row.severity) ?? 0) + 1);
      agentCounts.set(row.agent, (agentCounts.get(row.agent) ?? 0) + 1);
      const file = fileCounts.get(row.filePath) ?? { findingCount: 0, blockerCount: 0 };
      file.findingCount += 1;
      if (row.severity === 'BLOCKER') file.blockerCount += 1;
      fileCounts.set(row.filePath, file);
    }

    // 字面量元组标注：避免数组字面量拓宽为 string 后无法满足 SeverityCount
    const severityLiterals = ['BLOCKER', 'WARNING', 'NIT', 'PRAISE'] as const;
    const severityDistribution: SeverityCount[] = severityLiterals.map((severity) => ({
      severity,
      count: severityCounts.get(severity) ?? 0,
    }));

    // 风险分趋势按自然日聚合（created_at 为 ISO 字符串，前 10 位即日期）
    const dayBuckets = new Map<string, { riskScoreSum: number; reviews: number }>();
    for (const row of reviewRows) {
      const date = row.createdAt.slice(0, 10);
      const bucket = dayBuckets.get(date) ?? { riskScoreSum: 0, reviews: 0 };
      bucket.riskScoreSum += row.riskScore;
      bucket.reviews += 1;
      dayBuckets.set(date, bucket);
    }
    const riskTrend = [...dayBuckets.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, bucket]) => ({
        date,
        reviews: bucket.reviews,
        avgRiskScore: bucket.riskScoreSum / bucket.reviews,
      }));
    const tokenByDate = new Map<string, number>();
    for (const row of reviewRows) {
      const date = row.createdAt.slice(0, 10);
      tokenByDate.set(date, (tokenByDate.get(date) ?? 0) + row.tokenUsed);
    }
    const tokenTrend: TokenTrendPoint[] = [...tokenByDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, tokenUsed]) => ({ date, tokenUsed }));
    const agentDistribution: AgentCount[] = [...agentCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .map(([agent, count]) => ({ agent, count }));

    const totalReviews = reviewRows.length;
    const avgRiskScore =
      totalReviews === 0
        ? 0
        : reviewRows.reduce((sum, row) => sum + row.riskScore, 0) / totalReviews;

    return {
      totalReviews,
      totalFindings: findingRows.length,
      falsePositiveCount,
      avgRiskScore,
      avgDurationMs:
        totalReviews === 0
          ? 0
          : reviewRows.reduce((sum, row) => sum + row.durationMs, 0) / totalReviews,
      totalTokenUsed: reviewRows.reduce((sum, row) => sum + row.tokenUsed, 0),
      severityDistribution,
      riskTrend,
      topRiskyFiles: [...fileCounts.entries()]
        .map(([filePath, file]) => ({ filePath, ...file }))
        .sort((a, b) => b.findingCount - a.findingCount)
        .slice(0, 10),
      agentDistribution,
      tokenTrend,
    };
  }

  /** 关闭底层连接（进程退出 / 测试清理） */
  public close(): void {
    this.sqlite.close();
  }
}

/** 创建基于文件路径的存储（随项目目录持久化，如 .ai-review-cache/reviews.db）；父目录不存在时自动创建 */
export function createReviewStore(dbFile: string): ReviewStore {
  return new ReviewStore(openSqlite(dbFile));
}

/**
 * 内置角色种子（幂等）：admin（全权限、最高优先级）与 user（常规用户端权限）。
 * 仅在首次建表时插入，后续启动不再覆盖用户对内置角色的修改。
 */
function seedRoles(sqlite: Database.Database): void {
  const count = sqlite.prepare('SELECT COUNT(*) AS c FROM roles').get() as { c: number };
  if (count.c > 0) return;
  const now = new Date().toISOString();
  const adminId = 'role-admin';
  const userId = 'role-user';
  sqlite
    .prepare(
      `INSERT INTO roles (id, name, description, priority, permissions, is_system, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(adminId, 'admin', '系统管理员，拥有全部页面与操作权限', 1, JSON.stringify(['*']), now);
  sqlite
    .prepare(
      `INSERT INTO roles (id, name, description, priority, permissions, is_system, created_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`,
    )
    .run(
      userId,
      'user',
      '普通用户，可访问用户端常规页面',
      100,
      JSON.stringify(['/', '/run', '/reviews', '/stats', '/profile']),
      now,
    );
}

/**
 * 打开 SQLite 连接（ReviewStore 与 UserStore 共用同一连接）。
 * 导出而非内置于 createReviewStore，是为了让 server 在单库上同时装配两种 store。
 */
export function openSqlite(dbFile: string): Database.Database {
  const parent = dirname(dbFile);
  if (parent !== '' && parent !== '.' && !existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  return new Database(dbFile);
}
