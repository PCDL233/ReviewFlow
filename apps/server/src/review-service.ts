import { getMaxRiskScore, runReviewPipeline } from '@ai-review/core';
import type { PipelineDeps, PipelineNodeName, ReviewState } from '@ai-review/core';
import type { ReviewStore } from '@ai-review/db';
import { describeReviewSource, severityMeetsThreshold } from '@ai-review/shared';
import type { ReviewReport, ReviewSource, ReviewStageEvent } from '@ai-review/shared';
import { deriveQualityNotes, deriveSuggestions } from '@ai-review/report';
import type { ReviewMetrics } from './metrics.js';

// SSE 事件契约以 shared 为单一事实源，此处转出口供既有调用方使用
export type { ReviewStageEvent } from '@ai-review/shared';

/** 与 packages/core 的 PipelineNodeName 保持一致（SSE stage 值契约，方案 3.9） */
const PIPELINE_NODE_NAMES: readonly PipelineNodeName[] = [
  'parse',
  'riskPlan',
  'correctness',
  'security',
  'performance',
  'static',
  'validate',
  'heal',
  'report',
];

function isPipelineNodeName(node: string): node is PipelineNodeName {
  return PIPELINE_NODE_NAMES.some((name) => name === node);
}

export type StartReviewOptions = {
  repoPath: string;
  mode: 'fast' | 'full';
  /** 审查来源（暂存区/工作区/单提交/区间）；缺省为暂存区 */
  source?: ReviewSource;
  /** 阻断阈值，默认 BLOCKER（退出码契约的 BLOCKER 级语义） */
  blockOn?: 'BLOCKER' | 'WARNING' | 'NIT';
  /** 发起人用户 id（Web 端数据隔离依据） */
  createdBy?: string;
  /** 是否保留 PRAISE 级发现（report.includePraise）；缺省保留 */
  includePraise?: boolean;
};

/** 组装流水线依赖；Provider 链由配置选择云端、本地 Ollama 与 mock 保底。 */
export type PipelineDepsFactory = (
  repoPath: string,
  mode: 'fast' | 'full',
  source: ReviewSource,
) => PipelineDeps;

/** 允许测试注入假流水线；生产即 @ai-review/core 的 runReviewPipeline */
export type PipelineRunner = typeof runReviewPipeline;

/**
 * 后台审查调度：触发流水线 → 节点级事件广播（SSE）→ 报告落库。
 * 事件为同步广播 + 内存分发，进程重启后不回放（checkpoint 持久化属团队版后续任务）。
 */
export class ReviewService {
  private jobSeq = 0;
  private readonly controllers = new Map<string, AbortController>();
  private readonly jobs = new Map<string, StartReviewOptions>();
  private readonly listeners = new Map<string, Set<(event: ReviewStageEvent) => void>>();
  private readonly terminalEvents = new Map<string, ReviewStageEvent>();
  // —— 方案 13：并发审查上限（信号量 + FIFO 排队），防用户批量触发压垮 LLM 配额与进程 ——
  private readonly maxConcurrent: number;
  private running = 0;
  /** 排队等待者（FIFO）；cancelled 标记的等待者在唤醒时直接跳过（排队期间被取消） */
  private readonly pending: Array<{
    reviewId: string;
    cancelled: boolean;
    resolve: (granted: boolean) => void;
  }> = [];

  constructor(
    private readonly store: ReviewStore,
    private readonly depsFactory: PipelineDepsFactory,
    private readonly runner: PipelineRunner = runReviewPipeline,
    private readonly metrics?: ReviewMetrics,
    maxConcurrent?: number,
  ) {
    // 并发上限：注入的 server 参数 > 环境变量 > 默认 3
    const configured = maxConcurrent ?? Number(process.env.AI_REVIEW_MAX_CONCURRENT ?? 3);
    this.maxConcurrent = Number.isFinite(configured) && configured > 0 ? configured : 3;
  }

  /**
   * 触发一次异步审查。
   * @returns 审查 ID（调用方凭此订阅 SSE 与查询报告）
   */
  public startReview(options: StartReviewOptions): string {
    this.jobSeq += 1;
    const reviewId = `review-${Date.now()}-${this.jobSeq}`;
    // 后台执行：失败不抛给调用方，经 'failed' 事件与订阅者约定（规范 §7.4 转译而非静默）
    const controller = new AbortController();
    this.controllers.set(reviewId, controller);
    this.jobs.set(reviewId, options);
    void this.runJob(reviewId, options, controller);
    return reviewId;
  }

  /** 取消审查；任务已进入终态时返回 false。排队中的任务会立即出队并直接落库为 cancelled。 */
  public cancelReview(reviewId: string): boolean {
    const controller = this.controllers.get(reviewId);
    if (controller === undefined || controller.signal.aborted) return false;
    controller.abort();
    // 排队中的任务：立即出队并放行 runJob 走取消终态（不占并发槽），SSE 即时收到 cancelled
    const waiter = this.pending.find((w) => w.reviewId === reviewId);
    if (waiter !== undefined) {
      waiter.cancelled = true;
      this.pending.splice(this.pending.indexOf(waiter), 1);
      waiter.resolve(false);
    }
    return true;
  }

  /** 查询运行中任务的归属；用于 SSE/取消在报告落库前的访问控制。 */
  public getReviewOwner(reviewId: string): string | null {
    return this.jobs.get(reviewId)?.createdBy ?? null;
  }

  /** 返回已落库任务的终态事件，避免客户端晚连接 SSE 后永久等待。 */
  public getTerminalEvent(reviewId: string): ReviewStageEvent | undefined {
    const remembered = this.terminalEvents.get(reviewId);
    if (remembered !== undefined) return remembered;
    try {
      // 方案 14：仅读状态列，避免为晚连接兜底而解析完整报告与 findings
      const status = this.store.getReportStatus(reviewId);
      if (status === undefined) return undefined;
      if (status.status === 'failed' || status.status === 'cancelled') {
        return {
          type: status.status,
          reviewId,
          message: status.errorMessage ?? '审查任务未正常完成。',
        };
      }
      const blockOn = status.blockOn ?? 'BLOCKER';
      // 与实时事件同口径：按发起时阈值重算 blocking（PRAISE 不计数，各严重度计数列覆盖全部分布）
      const blocking =
        status.blockerCount > 0 ||
        (blockOn !== 'BLOCKER' && status.warningCount > 0) ||
        (blockOn === 'NIT' && status.nitCount > 0);
      return {
        type: 'completed',
        reviewId,
        riskScore: status.riskScore,
        blockerCount: status.blockerCount,
        blocking,
      };
    } catch {
      // 运行中的任务尚未落库；订阅者会从实时广播中收到终态事件。
      return undefined;
    }
  }

  /** 使用原审查的仓库、模式、审查来源与阻断阈值创建新任务。 */
  public rerunReview(reviewId: string, createdBy?: string): string {
    const input = this.store.getReviewInput(reviewId);
    return this.startReview({
      repoPath: input.repoPath,
      mode: input.mode,
      source: input.source,
      ...(input.blockOn !== null ? { blockOn: input.blockOn } : {}),
      ...(createdBy === undefined ? {} : { createdBy }),
    });
  }

  public subscribe(reviewId: string, listener: (event: ReviewStageEvent) => void): () => void {
    const set = this.listeners.get(reviewId) ?? new Set<(event: ReviewStageEvent) => void>();
    set.add(listener);
    this.listeners.set(reviewId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(reviewId);
    };
  }

  /**
   * 等待审查进入终态（Hook / CI 的同步审查端点使用）。
   * 终态可能是 completed/failed/cancelled；超时返回 null，由调用方映射为退出码 3。
   * @param reviewId 审查 ID
   * @param timeoutMs 超时毫秒数
   * @returns 终态事件；超时返回 null
   */
  public async waitForTerminal(
    reviewId: string,
    timeoutMs: number,
  ): Promise<ReviewStageEvent | null> {
    const remembered = this.terminalEvents.get(reviewId);
    if (remembered !== undefined) return remembered;
    return new Promise<ReviewStageEvent | null>((resolve) => {
      let settled = false;
      const finish = (event: ReviewStageEvent | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        resolve(event);
      };
      const unsubscribe = this.subscribe(reviewId, (event) => {
        if (event.type !== 'stage') finish(event);
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
      // 订阅前任务可能已终结（goroutine 已广播完），补一次检查避免永久等待
      const already = this.terminalEvents.get(reviewId);
      if (already !== undefined) finish(already);
    });
  }

  private emit(event: ReviewStageEvent): void {
    if (event.type !== 'stage') {
      this.terminalEvents.set(event.reviewId, event);
      // 仅保留最近 1,000 条终态，避免长时间运行的服务发生无界内存增长。
      if (this.terminalEvents.size > 1000) {
        const oldest = this.terminalEvents.keys().next().value;
        if (oldest !== undefined) this.terminalEvents.delete(oldest);
      }
    }
    for (const listener of this.listeners.get(event.reviewId) ?? []) {
      listener(event);
    }
  }

  /** 申请并发槽位：未达上限立即通过；排队期间被取消时返回 false（不消耗槽位） */
  private async acquireSlot(reviewId: string): Promise<boolean> {
    if (this.running < this.maxConcurrent) {
      this.running += 1;
      return true;
    }
    return new Promise<boolean>((resolve) => {
      this.pending.push({ reviewId, cancelled: false, resolve });
    });
  }

  /** 释放并发槽位并唤醒下一个未取消的排队任务 */
  private releaseSlot(): void {
    this.running -= 1;
    while (this.pending.length > 0) {
      const next = this.pending.shift();
      if (next === undefined) break;
      if (next.cancelled) continue;
      this.running += 1;
      next.resolve(true);
      return;
    }
  }

  /** 终态失败/取消：落库降级报告并广播事件（成功与失败共用的失败形状） */
  private finalizeTerminalFailure(
    reviewId: string,
    options: StartReviewOptions,
    status: 'failed' | 'cancelled',
    message: string,
  ): void {
    this.metrics?.recordFailed();
    const failureReport: ReviewReport = {
      meta: {
        reviewId,
        repoPath: options.repoPath,
        branch: '—',
        model: '未完成',
        mode: options.mode,
        status,
        errorMessage: message,
        riskScore: 0,
        durationMs: 0,
        tokenUsed: 0,
      },
      summary: status === 'cancelled' ? '审查任务已取消。' : '审查任务执行失败。',
      findings: [],
      qualityNotes: [],
      suggestions: [],
      assessment: message,
      degradedToStatic: [],
    };
    this.store.saveReport(failureReport, options.createdBy, {
      errorMessage: message,
      ...(options.blockOn === undefined ? {} : { blockOn: options.blockOn }),
    });
    this.emit({ type: status, reviewId, message });
  }

  private async runJob(
    reviewId: string,
    options: StartReviewOptions,
    controller: AbortController,
  ): Promise<void> {
    const granted = await this.acquireSlot(reviewId);
    if (!granted) {
      // 排队期间被取消：立即落库 cancelled 并广播（不经过流水线、不占用并发槽）
      this.finalizeTerminalFailure(reviewId, options, 'cancelled', '审查已取消');
      this.controllers.delete(reviewId);
      this.jobs.delete(reviewId);
      return;
    }
    try {
      const deps = this.depsFactory(options.repoPath, options.mode, options.source ?? { target: 'staged' });
      const state = await this.runner(deps, {
        reviewId,
        signal: controller.signal,
        onNodeUpdate: (node, update) => {
          if (isPipelineNodeName(node)) {
            const detail =
              typeof update === 'object' && update !== null
                ? JSON.stringify(update).slice(0, 240)
                : undefined;
            this.emit({
              type: 'stage',
              reviewId,
              stage: node,
              ...(detail === undefined ? {} : { detail }),
            });
          }
        },
      });
      if (controller.signal.aborted) {
        throw new DOMException('The review was cancelled', 'AbortError');
      }
      const report = await this.buildReport(reviewId, options, deps, state);
      this.store.saveReport(report, options.createdBy, {
        diffText: state.rawDiff,
        ...(options.blockOn === undefined ? {} : { blockOn: options.blockOn }),
        ...(options.source === undefined ? {} : { source: options.source }),
      });
      this.metrics?.recordCompleted(report);
      // 与存储列同口径（含流水线阶段标记的误报），SSE 实时与晚连接重放数值一致
      const blockerCount = report.findings.filter(
        (finding) => finding.severity === 'BLOCKER',
      ).length;
      this.emit({
        type: 'completed',
        reviewId,
        riskScore: report.meta.riskScore,
        blockerCount,
        blocking: report.findings.some((finding) =>
          severityMeetsThreshold(finding.severity, options.blockOn ?? 'BLOCKER'),
        ),
      });
    } catch (e) {
      const cancelled =
        controller.signal.aborted || (e instanceof DOMException && e.name === 'AbortError');
      const message = cancelled ? '审查已取消' : e instanceof Error ? e.message : String(e);
      this.finalizeTerminalFailure(reviewId, options, cancelled ? 'cancelled' : 'failed', message);
    } finally {
      this.controllers.delete(reviewId);
      this.jobs.delete(reviewId);
      this.releaseSlot();
    }
  }

  /** 由流水线最终状态装配五段式报告（方案 3.8） */
  private async buildReport(
    reviewId: string,
    options: StartReviewOptions,
    deps: PipelineDeps,
    state: ReviewState,
  ): Promise<ReviewReport> {
    const blocking = state.findings.some((finding) =>
      severityMeetsThreshold(finding.severity, options.blockOn ?? 'BLOCKER'),
    );
    const source: ReviewSource = options.source ?? { target: 'staged' };
    // 报告必须可追溯到具体提交：commit/range 取目标提交，staged/worktree 取 HEAD
    const commitRef =
      source.target === 'commit' ? source.commit : source.target === 'range' ? (source.head ?? 'HEAD') : 'HEAD';
    const [branch, commitHash, commitMeta] = await Promise.all([
      deps.gitReader.readBranch(),
      deps.gitReader.readHeadCommit(),
      deps.gitReader.readCommitMeta(commitRef),
    ]);
    const suggestions = deriveSuggestions(state.findings);
    const qualityNotes = deriveQualityNotes(
      state.context.metadata.totalFiles,
      state.findings,
      state.metrics.degradedToStatic,
    );
    // report.includePraise 决定 PRAISE 是否进入报告与统计（关闭后仅保留问题类发现）
    const findings =
      options.includePraise === false
        ? state.findings.filter((finding) => finding.severity !== 'PRAISE')
        : state.findings;
    const truncated = state.metrics.truncatedFiles ?? [];
    const notes =
      truncated.length === 0
        ? qualityNotes
        : [
            ...qualityNotes,
            `以下 ${truncated.length} 个文件因超出单次审查规模上限（review.maxFiles / maxChangedLines）未做 LLM 审查，仅执行静态分析：${truncated.join(', ')}`,
          ];
    return {
      meta: {
        reviewId,
        repoPath: options.repoPath,
        branch: (branch.trim() || 'HEAD') as string,
        ...(commitHash === null ? {} : { commitHash }),
        ...(commitMeta === null ? {} : { author: commitMeta.author }),
        model: deps.modelName ?? 'mock + 静态分析',
        mode: options.mode,
        riskScore: getMaxRiskScore(state.plan),
        durationMs: state.metrics.durationMs,
        tokenUsed: state.metrics.totalTokens,
      },
      summary: `本次审查覆盖 ${state.context.metadata.totalFiles} 个文件（${describeReviewSource(source)}），发现 ${findings.length} 个问题。`,
      findings,
      qualityNotes: notes,
      suggestions,
      assessment: blocking
        ? '存在达到阻断阈值的发现。Changes should not be committed until blocking findings are addressed.'
        : '未发现达到当前阻断阈值的问题。No findings reached the configured blocking threshold.',
      degradedToStatic: state.metrics.degradedToStatic,
    };
  }
}
