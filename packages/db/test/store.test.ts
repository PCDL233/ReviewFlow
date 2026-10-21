import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import type { Finding, LlmCallRecord, ReviewReport } from '@ai-review/shared';
import { createReviewStore, openSqlite, ReviewStore, StoreError } from '../src/store.js';

let tempDir: string | undefined;

afterAll(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
});

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    agent: 'static',
    severity: 'BLOCKER',
    confidence: 0.9,
    filePath: 'src/config.ts',
    lineStart: 1,
    lineEnd: 1,
    title: 'Possible AWS access key id in changed code',
    description: 'Hardcoded credential detected on an added line.',
    isFalsePositive: false,
    ...overrides,
  };
}

function makeReport(reviewId: string, findings: Finding[]): ReviewReport {
  return {
    meta: {
      reviewId,
      repoPath: '/repo/demo',
      branch: 'main',
      model: 'mock + 静态分析',
      mode: 'fast',
      riskScore: 45,
      durationMs: 120,
      tokenUsed: 0,
    },
    summary: 'Reviewed 1 staged file(s).',
    findings,
    qualityNotes: ['no complexity hotspots'],
    suggestions: ['rotate the exposed key'],
    assessment: 'Blocking findings present.',
    degradedToStatic: [],
  };
}

describe('ReviewStore', () => {
  it('round-trips a report through the file-backed store with computed counts', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ai-review-db-'));
    const store = createReviewStore(join(tempDir, 'reviews.db'));
    try {
      store.saveReport(
        makeReport('review-1', [
          makeFinding(),
          makeFinding({ severity: 'WARNING', agent: 'correctness', title: 'missing guard' }),
          makeFinding({ severity: 'NIT', agent: 'performance', title: 'long function' }),
        ]),
      );

      const list = store.listReviews();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        reviewId: 'review-1',
        blockerCount: 1,
        warningCount: 1,
        nitCount: 1,
        totalFindings: 3,
      });

      const detail = store.getReportDetail('review-1');
      expect(detail.summary).toBe('Reviewed 1 staged file(s).');
      expect(detail.findings).toHaveLength(3);
      expect(detail.findings.map((finding) => finding.id)).toEqual([1, 2, 3]);
      expect(detail.findings[0]?.title).toBe('Possible AWS access key id in changed code');
      expect(detail.suggestions).toEqual(['rotate the exposed key']);
    } finally {
      store.close();
    }
  });

  it('persists false-positive flags across reads (Dashboard 回写)', () => {
    const store = new ReviewStore(new Database(':memory:'));
    try {
      store.saveReport(makeReport('review-fp', [makeFinding(), makeFinding({ title: 'second' })]));
      const [first] = store.getReportDetail('review-fp').findings;
      if (first === undefined) throw new Error('expected at least one finding row');

      expect(store.setFindingFalsePositive(first.id, true)).toBe(true);

      const detail = store.getReportDetail('review-fp');
      expect(detail.findings[0]?.isFalsePositive).toBe(true);
      expect(detail.findings[1]?.isFalsePositive).toBe(false);
      expect(store.setFindingFalsePositive(999, true)).toBe(false);
    } finally {
      store.close();
    }
  });

  it('returns zeroed statistics for an empty store', () => {
    const store = new ReviewStore(new Database(':memory:'));
    try {
      expect(store.getStats()).toEqual({
        totalReviews: 0,
        totalFindings: 0,
        falsePositiveCount: 0,
        avgRiskScore: 0,
        avgDurationMs: 0,
        totalTokenUsed: 0,
        severityDistribution: [
          { severity: 'BLOCKER', count: 0 },
          { severity: 'WARNING', count: 0 },
          { severity: 'NIT', count: 0 },
          { severity: 'PRAISE', count: 0 },
        ],
        riskTrend: [],
        topRiskyFiles: [],
        agentDistribution: [],
        tokenTrend: [],
      });
    } finally {
      store.close();
    }
  });

  it('round-trips cache entries keyed by content hash (方案 3.0 内容哈希去重)', () => {
    const store = new ReviewStore(new Database(':memory:'));
    try {
      expect(store.getCachedFindings('missing-key')).toBeUndefined();

      const finding = makeFinding();
      store.saveCacheEntries('review-1', [
        { cacheKey: 'key-a', findings: [finding], tokenSaved: 1200 },
      ]);
      // 相同键以最新口径覆盖（insert or replace）
      store.saveCacheEntries('review-2', [
        {
          cacheKey: 'key-a',
          findings: [finding, makeFinding({ title: 'second' })],
          tokenSaved: 800,
        },
      ]);

      expect(store.getCachedFindings('key-a')).toHaveLength(2);
      expect(store.getCacheSummary()).toEqual({ entries: 1, tokenSaved: 800 });

      // 损坏条目按"未命中"降级（core 侧语义），不抛错不阻断
      store['sqlite'].exec(
        "UPDATE review_cache SET findings_json = '{broken' WHERE cache_key = 'key-a'",
      );
      expect(store.getCachedFindings('key-a')).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it('aggregates severity distribution, daily trend and top risky files', () => {
    const store = new ReviewStore(new Database(':memory:'));
    try {
      store.saveReport(
        makeReport('review-a', [
          makeFinding(),
          makeFinding({ severity: 'NIT', filePath: 'src/other.ts', title: 'nit' }),
        ]),
      );
      store.saveReport(
        makeReport('review-b', [makeFinding({ filePath: 'src/other.ts', title: 'again' })]),
      );
      // 标记一条误报：误报仍计入检出分布，但单独计数（误报率 = falsePositiveCount / totalFindings）
      const [flagged] = store.getReportDetail('review-b').findings;
      if (flagged === undefined) throw new Error('expected a finding row');
      store.setFindingFalsePositive(flagged.id, true);

      const stats = store.getStats();
      expect(stats.totalReviews).toBe(2);
      expect(stats.totalFindings).toBe(3);
      expect(stats.falsePositiveCount).toBe(1);
      expect(stats.avgRiskScore).toBe(45);
      expect(stats.severityDistribution[0]).toEqual({ severity: 'BLOCKER', count: 2 });
      // Top 高风险文件按发现数降序：other.ts 两条（NIT + BLOCKER），config.ts 一条
      expect(stats.topRiskyFiles[0]).toMatchObject({
        filePath: 'src/other.ts',
        findingCount: 2,
        blockerCount: 1,
      });
      expect(stats.riskTrend).toHaveLength(1);
      expect(stats.riskTrend[0]).toMatchObject({ reviews: 2, avgRiskScore: 45 });
    } finally {
      store.close();
    }
  });

  it('rejects unknown review ids and corrupt report rows', () => {
    const store = new ReviewStore(new Database(':memory:'));
    try {
      expect(() => store.getReportDetail('missing')).toThrow(StoreError);

      store.saveReport(makeReport('review-corrupt', []));
      // 直接改写 report_json 制造损坏行，验证读路径的 zod 防线
      store['sqlite'].exec(
        "UPDATE reviews SET report_json = '{broken' WHERE id = 'review-corrupt'",
      );
      expect(() => store.getReportDetail('review-corrupt')).toThrow(StoreError);
    } finally {
      store.close();
    }
  });

  it('applies schema migrations idempotently and adds lifecycle columns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-review-migrate-'));
    const sqlite = openSqlite(join(dir, 'migrations.db'));
    try {
      new ReviewStore(sqlite);
      const columns = (table: string): string[] =>
        (sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
          (row) => row.name,
        );
      expect(columns('findings')).toEqual(
        expect.arrayContaining([
          'fingerprint',
          'origin',
          'line_scope',
          'agents',
          'status',
          'rule_id',
        ]),
      );
      expect(columns('reviews')).toEqual(
        expect.arrayContaining([
          'llm_status',
          'review_score',
          'change_risk_score',
          'cache_hits',
          'heal_rounds',
          'dimensions',
        ]),
      );
      const versions = (): number =>
        (sqlite.prepare('SELECT COUNT(*) AS c FROM schema_migrations').get() as { c: number }).c;
      const applied = versions();
      expect(applied).toBeGreaterThan(0);
      // 再次构造不应重复执行迁移
      new ReviewStore(sqlite);
      expect(versions()).toBe(applied);
    } finally {
      sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips llm status and finding lifecycle fields', () => {
    const store = new ReviewStore(new Database(':memory:'));
    try {
      const fingerprint = 'a'.repeat(32);
      const report = makeReport('review-meta', [
        makeFinding({
          fingerprint,
          origin: 'static',
          lineScope: 'changed',
          ruleId: 'rule-1',
          agents: ['static', 'security'],
        }),
      ]);
      report.meta.llmStatus = 'degraded';
      report.meta.reviewScore = 70;
      report.meta.changeRiskScore = 30;
      report.meta.dimensions = ['security'];
      report.meta.cacheHits = 2;
      report.meta.healRounds = 1;
      store.saveReport(report);

      const detail = store.getReportDetail('review-meta');
      expect(detail.meta).toMatchObject({
        reviewScore: 70,
        changeRiskScore: 30,
        llmStatus: 'degraded',
        cacheHits: 2,
        healRounds: 1,
        dimensions: ['security'],
      });
      expect(detail.findings[0]).toMatchObject({
        fingerprint,
        origin: 'static',
        lineScope: 'changed',
        ruleId: 'rule-1',
        agents: ['static', 'security'],
        status: 'open',
      });
    } finally {
      store.close();
    }
  });

  it('persists llm call audit rows and cascades them on delete', () => {
    const store = new ReviewStore(new Database(':memory:'));
    try {
      const call: LlmCallRecord = {
        dimension: 'security',
        provider: 'deepseek',
        model: 'deepseek-chat',
        status: 'degraded',
        round: 0,
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        estimated: false,
        latencyMs: 42,
        promptChars: 400,
        fallbackUsed: true,
        attempts: [
          {
            kind: 'primary',
            provider: 'deepseek',
            model: 'deepseek-chat',
            status: 'failed',
            latencyMs: 10,
            errorKind: 'timeout',
            message: 'request timed out',
          },
          {
            kind: 'fallback',
            provider: 'ollama',
            model: 'qwen3-coder:30b',
            status: 'succeeded',
            latencyMs: 32,
          },
        ],
      };
      store.saveReport(makeReport('review-calls', []));
      store.saveLlmCalls('review-calls', [call]);

      const calls = store.getLlmCalls('review-calls');
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        dimension: 'security',
        provider: 'deepseek',
        status: 'degraded',
        totalTokens: 120,
        fallbackUsed: true,
      });
      expect(calls[0]?.attempts).toHaveLength(2);
      expect(calls[0]?.attempts[0]).toMatchObject({ errorKind: 'timeout' });
      expect(store.listRecentLlmCalls()[0]).toMatchObject({ reviewId: 'review-calls' });

      store.deleteReview('review-calls');
      expect(store.getLlmCalls('review-calls')).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('updates finding lifecycle and stores comments/decision', () => {
    const store = new ReviewStore(new Database(':memory:'));
    try {
      store.saveReport(makeReport('review-life', [makeFinding({ fingerprint: 'b'.repeat(32) })]));
      const [finding] = store.getReportDetail('review-life').findings;
      if (finding === undefined) throw new Error('expected a finding row');

      expect(store.updateFinding(finding.id, { status: 'fixed' })).toBe(true);
      expect(store.updateFinding(finding.id, { status: 'false_positive' })).toBe(true);
      const updated = store.getReportDetail('review-life').findings[0];
      expect(updated).toMatchObject({ status: 'false_positive', isFalsePositive: true });

      const comment = store.addFindingComment({
        findingId: finding.id,
        userId: 'user-1',
        username: 'alice',
        body: '确认是误报',
      });
      expect(comment.id).toBeGreaterThan(0);
      expect(store.listFindingComments(finding.id)).toHaveLength(1);
      expect(store.listFindingComments(finding.id)[0]).toMatchObject({ username: 'alice' });

      expect(store.setReviewDecision('review-life', 'approve', 'LGTM', 'user-1')).toBe(true);
      expect(store.getReportDetail('review-life').meta).toMatchObject({
        decision: 'approve',
        decisionComment: 'LGTM',
        decidedBy: 'user-1',
      });
      expect(store.setReviewDecision('review-life', 'request_changes', 'fix it', 'user-1')).toBe(
        true,
      );
      expect(store.listReviewDecisionEvents('review-life')).toHaveLength(2);
      expect(store.listReviewDecisionEvents('review-life')[1]).toMatchObject({
        decision: 'request_changes',
        comment: 'fix it',
      });

      store.deleteReview('review-life');
      expect(store.listFindingComments(finding.id)).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('persists pipeline stage checkpoints and deletes them with the review', () => {
    const store = new ReviewStore(new Database(':memory:'));
    try {
      store.saveReport(makeReport('review-stages', []));
      const stage = store.saveReviewStage({
        reviewId: 'review-stages',
        node: 'parse',
        status: 'completed',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 1_000,
        detail: '{"files":1}',
      });
      expect(stage.id).toBeGreaterThan(0);
      expect(store.listReviewStages('review-stages')).toHaveLength(1);
      expect(store.listReviewStages('review-stages')[0]).toMatchObject({
        node: 'parse',
        status: 'completed',
        durationMs: 1_000,
      });

      store.deleteReview('review-stages');
      expect(store.listReviewStages('review-stages')).toEqual([]);

      store.saveReviewStage({
        reviewId: 'review-orphan',
        node: 'parse',
        status: 'completed',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:01.000Z',
        durationMs: 1_000,
      });
      expect(store.pruneOrphanReviewStages()).toBe(1);
      expect(store.listReviewStages('review-orphan')).toEqual([]);

      store.saveReport(
        makeReport('review-rules', [
          makeFinding({ ruleId: 'no-console', severity: 'BLOCKER' }),
          makeFinding({ ruleId: 'no-console', severity: 'WARNING' }),
        ]),
      );
      expect(store.getRuleHitStats()).toEqual([
        {
          ruleId: 'no-console',
          count: 2,
          blocker: 1,
          warning: 1,
          nit: 0,
          falsePositives: 0,
        },
      ]);

      store.saveReviewJob('review-resume', { repoPath: 'D:/repo', mode: 'fast' });
      expect(store.listRunningReviewJobs()).toHaveLength(1);
      store.setReviewJobStatus('review-resume', 'completed');
      expect(store.listRunningReviewJobs()).toEqual([]);
    } finally {
      store.close();
    }
  });
});
