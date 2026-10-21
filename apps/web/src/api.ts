import { z } from 'zod';
import {
  ReviewListResponseSchema,
  ReviewReportDetailSchema,
  ReviewStatsResponseSchema,
  StartReviewResponseSchema,
  FalsePositiveResponseSchema,
  ReviewDiffResponseSchema,
  RerunReviewResponseSchema,
  DeleteReviewResponseSchema,
  CancelReviewResponseSchema,
  ReviewDecisionResponseSchema,
  ReviewDecisionHistoryResponseSchema,
  ReviewTraceResponseSchema,
  ReviewCompareResponseSchema,
  FindingCommentListResponseSchema,
  FindingCommentSchema,
  AdminConfigResponseSchema,
  KnowledgeStatusResponseSchema,
  KnowledgeReindexResponseSchema,
  FindingSchema,
  RepositoryListResponseSchema,
  RepoStatusResponseSchema,
  RepoBranchListResponseSchema,
  RepoCommitListResponseSchema,
  HookTokenListResponseSchema,
  CreateHookTokenResponseSchema,
  HookScriptSchema,
  InstallHookResponseSchema,
} from '@ai-review/shared/api';
import type {
  AdminConfig,
  Finding,
  FindingComment,
  FindingStatus,
  HookScript,
  HookToken,
  InstallHookResponse,
  KnowledgeStatus,
  RepoBranch,
  RepoCommit,
  RepoStatus,
  Repository,
  ReviewCompare,
  ReviewDecision,
  ReviewDecisionEvent,
  ReviewListItem,
  ReviewReportDetail,
  ReviewSource,
  ReviewStats,
  ReviewTrace,
  ServerRuntime,
} from '@ai-review/shared/api';
import { ApiError, parseResponse } from './parse-response.js';

const API_BASE = '/api';
type ReviewQueryOptions = {
  q?: string;
  status?: 'completed' | 'failed' | 'cancelled';
  mode?: 'fast' | 'full';
  severity?: 'BLOCKER' | 'WARNING' | 'NIT';
  page?: number;
  pageSize?: number;
  repo?: string;
  branch?: string;
  from?: string;
  to?: string;
};

export async function fetchReviewPage(options: ReviewQueryOptions = {}): Promise<{
  reviews: ReviewListItem[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({
    ...options,
    page: options.page ?? 1,
    pageSize: options.pageSize ?? 20,
  })) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return parseResponse(ReviewListResponseSchema, await fetch(`${API_BASE}/reviews?${query}`));
}

export async function fetchReviews(options: ReviewQueryOptions = {}): Promise<ReviewListItem[]> {
  return (await fetchReviewPage({ ...options, pageSize: options.pageSize ?? 100 })).reviews;
}

export async function fetchReviewDetail(reviewId: string): Promise<ReviewReportDetail> {
  return parseResponse(
    ReviewReportDetailSchema,
    await fetch(`${API_BASE}/reviews/${encodeURIComponent(reviewId)}`),
  );
}

/** 更新发现处置状态（人工闭环；不改变已生成的报告统计口径） */
export async function updateFindingStatus(findingId: number, status: FindingStatus): Promise<void> {
  await parseResponse(
    FalsePositiveResponseSchema,
    await fetch(`${API_BASE}/findings/${findingId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status }),
    }),
  );
}

/** 提交人工审查决策（通过 / 要求修改 / 仅评论） */
export async function submitReviewDecision(
  reviewId: string,
  decision: ReviewDecision,
  comment?: string,
): Promise<void> {
  await parseResponse(
    ReviewDecisionResponseSchema,
    await fetch(`${API_BASE}/reviews/${encodeURIComponent(reviewId)}/decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, ...(comment === undefined ? {} : { comment }) }),
    }),
  );
}

/** 读取审查决策历史 */
export async function fetchReviewDecisions(reviewId: string): Promise<ReviewDecisionEvent[]> {
  const body = await parseResponse(
    ReviewDecisionHistoryResponseSchema,
    await fetch(`${API_BASE}/reviews/${encodeURIComponent(reviewId)}/decisions`),
  );
  return body.decisions;
}

/** 读取审查的模型调用明细 */
export async function fetchReviewTrace(reviewId: string): Promise<ReviewTrace> {
  const body = await parseResponse(
    ReviewTraceResponseSchema,
    await fetch(`${API_BASE}/reviews/${encodeURIComponent(reviewId)}/trace`),
  );
  return body.trace;
}

/** 与历史审查对比（按发现指纹：新增/已修复/仍存在） */
export async function fetchReviewCompare(reviewId: string, baseId: string): Promise<ReviewCompare> {
  const body = await parseResponse(
    ReviewCompareResponseSchema,
    await fetch(
      `${API_BASE}/reviews/${encodeURIComponent(reviewId)}/compare?baseId=${encodeURIComponent(baseId)}`,
    ),
  );
  return body.compare;
}

/** 读取某条发现的评论 */
export async function fetchFindingComments(findingId: number): Promise<FindingComment[]> {
  const body = await parseResponse(
    FindingCommentListResponseSchema,
    await fetch(`${API_BASE}/findings/${findingId}/comments`),
  );
  return body.comments;
}

/** 新增发现评论 */
export async function addFindingComment(
  findingId: number,
  commentBody: string,
): Promise<FindingComment> {
  return parseResponse(
    FindingCommentSchema,
    await fetch(`${API_BASE}/findings/${findingId}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: commentBody }),
    }),
  );
}

export type StartReviewOverrides = {
  dimensions?: string[];
  maxFiles?: number;
  maxChangedLines?: number;
  toolCalling?: boolean;
  includePraise?: boolean;
};

export async function startReview(
  repoPath: string,
  mode?: 'fast' | 'full',
  blockOn?: 'BLOCKER' | 'WARNING' | 'NIT',
  source?: ReviewSource,
  overrides: StartReviewOverrides = {},
): Promise<string> {
  // 判空 + 展开：exactOptionalPropertyTypes 下不能显式传 undefined
  const payload = {
    repoPath,
    ...(mode === undefined ? {} : { mode }),
    ...(blockOn === undefined ? {} : { blockOn }),
    ...(source === undefined ? {} : { target: source.target }),
    ...(source !== undefined && source.target === 'commit' ? { commit: source.commit } : {}),
    ...(source !== undefined && source.target === 'range' ? { base: source.base } : {}),
    ...(overrides.dimensions === undefined ? {} : { dimensions: overrides.dimensions }),
    ...(overrides.maxFiles === undefined ? {} : { maxFiles: overrides.maxFiles }),
    ...(overrides.maxChangedLines === undefined
      ? {}
      : { maxChangedLines: overrides.maxChangedLines }),
    ...(overrides.toolCalling === undefined ? {} : { toolCalling: overrides.toolCalling }),
    ...(overrides.includePraise === undefined ? {} : { includePraise: overrides.includePraise }),
  };
  const response = await fetch(`${API_BASE}/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await parseResponse(StartReviewResponseSchema, response);
  return body.reviewId;
}

/** 可用于发起审查的仓库列表（服务端扫描 allowedRoots + 历史审查记录） */
export async function fetchRepositories(): Promise<Repository[]> {
  const body = await parseResponse(RepositoryListResponseSchema, await fetch(`${API_BASE}/repos`));
  return body.repositories;
}

/** 仓库工作区状态（发起审查前的即时校验依据） */
export async function fetchRepoStatus(repoPath: string): Promise<RepoStatus> {
  const params = new URLSearchParams({ repoPath });
  const body = await parseResponse(
    RepoStatusResponseSchema,
    await fetch(`${API_BASE}/repos/status?${params.toString()}`),
  );
  return body.status;
}

/** 仓库分支列表（区间审查的 base 选择器数据源） */
export async function fetchRepoBranches(repoPath: string): Promise<RepoBranch[]> {
  const params = new URLSearchParams({ repoPath });
  const body = await parseResponse(
    RepoBranchListResponseSchema,
    await fetch(`${API_BASE}/repos/branches?${params.toString()}`),
  );
  return body.branches;
}

/** 仓库提交列表（单提交审查与区间审查的选择器数据源） */
export async function fetchRepoCommits(
  repoPath: string,
  ref?: string,
  limit = 50,
): Promise<RepoCommit[]> {
  const params = new URLSearchParams({ repoPath, limit: String(limit) });
  if (ref !== undefined) params.set('ref', ref);
  const body = await parseResponse(
    RepoCommitListResponseSchema,
    await fetch(`${API_BASE}/repos/commits?${params.toString()}`),
  );
  return body.commits;
}

export async function markFalsePositive(
  findingId: number,
  isFalsePositive: boolean,
): Promise<void> {
  const response = await fetch(`${API_BASE}/findings/${findingId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ isFalsePositive }),
  });
  await parseResponse(FalsePositiveResponseSchema, response);
}

export async function fetchStats(
  options: { from?: string; to?: string } = {},
): Promise<ReviewStats> {
  const params = new URLSearchParams();
  if (options.from !== undefined) params.set('from', options.from);
  if (options.to !== undefined) params.set('to', options.to);
  const query = params.toString();
  const body = await parseResponse(
    ReviewStatsResponseSchema,
    await fetch(`${API_BASE}/stats${query === '' ? '' : `?${query}`}`),
  );
  return body.stats;
}

export async function fetchReviewDiff(reviewId: string): Promise<string | null> {
  const body = await parseResponse(
    ReviewDiffResponseSchema,
    await fetch(`${API_BASE}/reviews/${encodeURIComponent(reviewId)}/diff`),
  );
  return body.diffText;
}

export async function rerunReview(reviewId: string): Promise<string> {
  const body = await parseResponse(
    RerunReviewResponseSchema,
    await fetch(`${API_BASE}/reviews/${encodeURIComponent(reviewId)}/rerun`, { method: 'POST' }),
  );
  return body.reviewId;
}

export async function cancelReview(reviewId: string): Promise<void> {
  await parseResponse(
    CancelReviewResponseSchema,
    await fetch(`${API_BASE}/reviews/${encodeURIComponent(reviewId)}/cancel`, { method: 'POST' }),
  );
}

export async function deleteReview(reviewId: string): Promise<void> {
  await parseResponse(
    DeleteReviewResponseSchema,
    await fetch(`${API_BASE}/reviews/${encodeURIComponent(reviewId)}`, { method: 'DELETE' }),
  );
}

export function reviewExportUrl(reviewId: string, format: 'markdown' | 'html' | 'json'): string {
  return `${API_BASE}/reviews/${encodeURIComponent(reviewId)}/export?format=${format}`;
}

export type ReviewExportFormat = 'markdown' | 'html' | 'json';

/**
 * 读取导出内容（导出端点返回原始文本/HTML，不走 JSON 契约校验）。
 * 供"复制 Markdown""打印为 PDF"等需要在页面内直接使用报告文本的场景调用。
 */
export async function fetchReviewExport(
  reviewId: string,
  format: ReviewExportFormat,
): Promise<string> {
  const response = await fetch(reviewExportUrl(reviewId, format));
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const prefix = response.status === 404 ? '审查记录不存在' : '导出失败';
    throw new ApiError(detail === '' ? prefix : `${prefix}：${detail}`, {
      status: response.status,
    });
  }
  return response.text();
}

/** 配置响应体：可编辑配置 + 服务端只读运行环境（两者来自同一次 GET）。 */
export type AdminConfigPayload = { config: AdminConfig; runtime: ServerRuntime };

/** 读取配置与运行环境：配置页需要同时展示两者，避免重复请求。 */
export async function fetchAdminConfigPayload(): Promise<AdminConfigPayload> {
  const body = await parseResponse(
    AdminConfigResponseSchema,
    await fetch(`${API_BASE}/admin/config`),
  );
  return { config: body.config, runtime: body.runtime };
}

export async function fetchAdminConfig(): Promise<AdminConfig> {
  const body = await fetchAdminConfigPayload();
  return body.config;
}

export async function updateAdminConfig(config: AdminConfig): Promise<AdminConfig> {
  const body = await parseResponse(
    AdminConfigResponseSchema,
    await fetch(`${API_BASE}/admin/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(config),
    }),
  );
  return body.config;
}

export async function fetchKnowledgeStatus(): Promise<KnowledgeStatus> {
  const body = await parseResponse(
    KnowledgeStatusResponseSchema,
    await fetch(`${API_BASE}/admin/knowledge`),
  );
  return body.knowledge;
}

export async function reindexKnowledge(): Promise<void> {
  await parseResponse(
    KnowledgeReindexResponseSchema,
    await fetch(`${API_BASE}/admin/knowledge/reindex`, { method: 'POST' }),
  );
}

const SecretScanResponseSchema = z.object({ findings: z.array(FindingSchema) });
const ComplexityResponseSchema = z.object({
  functions: z.array(
    z.object({
      name: z.string(),
      line: z.number(),
      endLine: z.number(),
      complexity: z.number(),
      params: z.array(z.string()),
      isAsync: z.boolean(),
    }),
  ),
});

export async function scanSecrets(diffText: string): Promise<Finding[]> {
  const body = await parseResponse(
    SecretScanResponseSchema,
    await fetch(`${API_BASE}/admin/tools/secret-scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ diffText }),
    }),
  );
  return body.findings;
}

export type FunctionMetrics = {
  name: string;
  line: number;
  endLine: number;
  complexity: number;
  params: string[];
  isAsync: boolean;
};

export async function analyzeComplexity(
  source: string,
  threshold?: number,
): Promise<FunctionMetrics[]> {
  const body = await parseResponse(
    ComplexityResponseSchema,
    await fetch(`${API_BASE}/admin/tools/complexity`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source, ...(threshold !== undefined ? { threshold } : {}) }),
    }),
  );
  return body.functions;
}

export async function fetchHookScript(serverUrl?: string): Promise<HookScript> {
  const params = serverUrl === undefined ? '' : `?serverUrl=${encodeURIComponent(serverUrl)}`;
  return parseResponse(HookScriptSchema, await fetch(`${API_BASE}/admin/hooks/script${params}`));
}

/** 已签发的 Hook 令牌（不含明文） */
export async function fetchHookTokens(): Promise<HookToken[]> {
  const body = await parseResponse(
    HookTokenListResponseSchema,
    await fetch(`${API_BASE}/admin/hooks/tokens`),
  );
  return body.tokens;
}

/** 签发新令牌；明文仅在本响应中出现一次 */
export async function createHookToken(
  label: string,
  expiresInDays = 90,
): Promise<{ token: HookToken; plainText: string }> {
  return parseResponse(
    CreateHookTokenResponseSchema,
    await fetch(`${API_BASE}/admin/hooks/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label, expiresInDays }),
    }),
  );
}

/** 吊销令牌 */
export async function revokeHookToken(id: string): Promise<void> {
  await parseResponse(
    z.object({ revoked: z.boolean() }),
    await fetch(`${API_BASE}/admin/hooks/tokens/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  );
}

/** 在指定仓库安装 hook（服务端写盘），返回写入的文件与本次签发的令牌明文 */
export async function installHook(input: {
  repoPath: string;
  serverUrl?: string;
  tokenLabel?: string;
  overwrite?: boolean;
}): Promise<InstallHookResponse> {
  return parseResponse(
    InstallHookResponseSchema,
    await fetch(`${API_BASE}/admin/hooks/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        repoPath: input.repoPath,
        ...(input.serverUrl === undefined ? {} : { serverUrl: input.serverUrl }),
        ...(input.tokenLabel === undefined ? {} : { tokenLabel: input.tokenLabel }),
        ...(input.overwrite === undefined ? {} : { overwrite: input.overwrite }),
      }),
    }),
  );
}

/** Prometheus 文本指标：非 200 时抛出可读错误，避免把错误页当成指标渲染。 */
export async function fetchMetricsText(): Promise<string> {
  const response = await fetch('/metrics');
  if (!response.ok) throw new ApiError(`指标服务返回错误（HTTP ${response.status}）`);
  return response.text();
}

export async function initializeConfig(): Promise<AdminConfig> {
  const body = await parseResponse(
    AdminConfigResponseSchema,
    await fetch(`${API_BASE}/admin/init-config`, { method: 'POST' }),
  );
  return body.config;
}
