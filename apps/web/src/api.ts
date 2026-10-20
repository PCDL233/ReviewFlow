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
  AdminConfigResponseSchema,
  KnowledgeStatusResponseSchema,
  KnowledgeReindexResponseSchema,
  FindingSchema,
} from '@ai-review/shared/api';
import type {
  AdminConfig,
  Finding,
  KnowledgeStatus,
  ReviewListItem,
  ReviewReportDetail,
  ReviewStats,
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

export async function startReview(
  repoPath: string,
  mode?: 'fast' | 'full',
  blockOn?: 'BLOCKER' | 'WARNING' | 'NIT',
): Promise<string> {
  const response = await fetch(`${API_BASE}/reviews`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      repoPath,
      ...(mode !== undefined ? { mode } : {}),
      ...(blockOn !== undefined ? { blockOn } : {}),
    }),
  });
  const body = await parseResponse(StartReviewResponseSchema, response);
  return body.reviewId;
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

export async function fetchHookScript(): Promise<string> {
  const response = await fetch(`${API_BASE}/admin/tools/hook-script`);
  if (!response.ok) throw new ApiError(`获取 Hook 脚本失败（HTTP ${response.status}）`);
  const text = await response.text();
  if (text.trim() === '') throw new ApiError('Hook 脚本内容为空');
  return text;
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
