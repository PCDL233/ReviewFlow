/** 审查历史的 URL 查询参数：筛选与分页全部以 URL 为准，刷新/后退/分享可复现。 */

export type ReviewStatusFilter = 'completed' | 'failed' | 'cancelled';
export type ReviewModeFilter = 'fast' | 'full';
export type ReviewSeverityFilter = 'BLOCKER' | 'WARNING' | 'NIT';

export type ReviewSearch = {
  q?: string;
  status?: ReviewStatusFilter;
  mode?: ReviewModeFilter;
  severity?: ReviewSeverityFilter;
  repo?: string;
  branch?: string;
  /** 缺省表示第 1 页 / 默认每页条数（默认值不写入 URL）。 */
  page?: number;
  pageSize?: number;
};

export type ReviewFilterPatch = {
  q?: string | undefined;
  repo?: string | undefined;
  branch?: string | undefined;
  status?: ReviewStatusFilter | undefined;
  mode?: ReviewModeFilter | undefined;
  severity?: ReviewSeverityFilter | undefined;
};

export const REVIEW_DEFAULT_PAGE = 1;
export const REVIEW_DEFAULT_PAGE_SIZE = 20;
export const REVIEW_PAGE_SIZES: readonly number[] = [10, 20, 50, 100];

const STATUS_VALUES: readonly ReviewStatusFilter[] = ['completed', 'failed', 'cancelled'];
const MODE_VALUES: readonly ReviewModeFilter[] = ['fast', 'full'];
const SEVERITY_VALUES: readonly ReviewSeverityFilter[] = ['BLOCKER', 'WARNING', 'NIT'];

/** 读取页码（缺省 1）。 */
export function pageOf(search: ReviewSearch): number {
  return search.page ?? REVIEW_DEFAULT_PAGE;
}

/** 读取每页条数（缺省 20）。 */
export function pageSizeOf(search: ReviewSearch): number {
  return search.pageSize ?? REVIEW_DEFAULT_PAGE_SIZE;
}

function pickString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const candidate = pickString(value);
  if (candidate === undefined) return undefined;
  return allowed.find((allowedValue) => allowedValue === candidate);
}

function pickPage(value: unknown): number {
  if (value === undefined || value === null || value === '') return REVIEW_DEFAULT_PAGE;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return REVIEW_DEFAULT_PAGE;
  return parsed;
}

function pickPageSize(value: unknown): number {
  if (value === undefined || value === null || value === '') return REVIEW_DEFAULT_PAGE_SIZE;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || !REVIEW_PAGE_SIZES.includes(parsed)) {
    return REVIEW_DEFAULT_PAGE_SIZE;
  }
  return parsed;
}

/** 校验并规范化 `/reviews` 的 search；非法值静默丢弃（回落到默认值）。 */
export function parseReviewSearch(raw: Record<string, unknown>): ReviewSearch {
  const q = pickString(raw.q);
  const repo = pickString(raw.repo);
  const branch = pickString(raw.branch);
  const status = pickEnum(raw.status, STATUS_VALUES);
  const mode = pickEnum(raw.mode, MODE_VALUES);
  const severity = pickEnum(raw.severity, SEVERITY_VALUES);
  const page = pickPage(raw.page);
  const pageSize = pickPageSize(raw.pageSize);
  return {
    ...(q === undefined ? {} : { q }),
    ...(status === undefined ? {} : { status }),
    ...(mode === undefined ? {} : { mode }),
    ...(severity === undefined ? {} : { severity }),
    ...(repo === undefined ? {} : { repo }),
    ...(branch === undefined ? {} : { branch }),
    ...(page === REVIEW_DEFAULT_PAGE ? {} : { page }),
    ...(pageSize === REVIEW_DEFAULT_PAGE_SIZE ? {} : { pageSize }),
  };
}

/** 序列化为 URL search 对象；默认值不写入 URL，保持链接简短。 */
export function serializeReviewSearch(search: ReviewSearch): ReviewSearch {
  const result: ReviewSearch = {};
  if (search.q !== undefined && search.q !== '') result.q = search.q;
  if (search.status !== undefined) result.status = search.status;
  if (search.mode !== undefined) result.mode = search.mode;
  if (search.severity !== undefined) result.severity = search.severity;
  if (search.repo !== undefined && search.repo !== '') result.repo = search.repo;
  if (search.branch !== undefined && search.branch !== '') result.branch = search.branch;
  const page = pageOf(search);
  const pageSize = pageSizeOf(search);
  if (page !== REVIEW_DEFAULT_PAGE) result.page = page;
  if (pageSize !== REVIEW_DEFAULT_PAGE_SIZE) result.pageSize = pageSize;
  return result;
}

/** 变更筛选条件时回到第 1 页；只有 patch 中出现的键才会被修改。 */
export function withFilters(current: ReviewSearch, patch: ReviewFilterPatch): ReviewSearch {
  const next: ReviewSearch = { ...current };
  delete next.page;
  const assignString = (key: 'q' | 'repo' | 'branch', value: string | undefined): void => {
    if (value === undefined || value.trim() === '') delete next[key];
    else next[key] = value.trim();
  };
  if ('q' in patch) assignString('q', patch.q);
  if ('repo' in patch) assignString('repo', patch.repo);
  if ('branch' in patch) assignString('branch', patch.branch);
  if ('status' in patch) {
    if (patch.status === undefined) delete next.status;
    else next.status = patch.status;
  }
  if ('mode' in patch) {
    if (patch.mode === undefined) delete next.mode;
    else next.mode = patch.mode;
  }
  if ('severity' in patch) {
    if (patch.severity === undefined) delete next.severity;
    else next.severity = patch.severity;
  }
  return next;
}

/** 是否存在任何一个生效筛选（用于区分「暂无数据」与「无匹配结果」）。 */
export function hasActiveFilters(search: ReviewSearch): boolean {
  return (
    search.q !== undefined ||
    search.status !== undefined ||
    search.mode !== undefined ||
    search.severity !== undefined ||
    search.repo !== undefined ||
    search.branch !== undefined
  );
}
