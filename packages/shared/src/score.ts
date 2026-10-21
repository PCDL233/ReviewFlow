import type { Finding } from './finding.js';
import type { AgentDimension, Severity } from './severity.js';

/**
 * 审查结论评分与发现指纹（跨 core / server / db / report 共用的唯一实现）。
 * 本文件保持浏览器安全：不引用 node 内置模块，供前端展示同一套口径。
 */

/** 严重度权重：单条 BLOCKER 即可把 reviewScore 推入高风险区间 */
const SEVERITY_WEIGHTS: Record<Severity, number> = {
  BLOCKER: 40,
  WARNING: 15,
  NIT: 4,
  PRAISE: 0,
};

/** 非变更行（上下文相关）发现的折扣：它们无法直接阻断本次提交 */
const CONTEXT_FINDING_FACTOR = 0.5;
/** 饱和常数：分数随加权和单调递增并渐近 100，避免线性叠加轻易打满 */
const SCORE_SATURATION = 60;
/** 存在 BLOCKER 时的分数下限：避免“低风险文件里的阻断问题”显示为 0 分 */
const BLOCKER_FLOOR = 70;

/**
 * 计算审查结论分（0-100）。
 * 与“变更风险分”（RiskPlanner 的文件风险）语义分离：
 * 本函数只回答“这次审查到底发现了多严重的问题”，不掺入文件热度/路径风险。
 * @param findings 已去重、已交叉验证的发现
 * @returns 0-100 的整数分数
 */
export function computeReviewScore(findings: readonly Finding[]): number {
  let raw = 0;
  let hasBlocker = false;
  for (const finding of findings) {
    if (finding.isFalsePositive) continue;
    if (finding.status === 'ignored' || finding.status === 'false_positive') continue;
    const weight = SEVERITY_WEIGHTS[finding.severity];
    if (weight === 0) continue;
    const factor = finding.lineScope === 'context' ? CONTEXT_FINDING_FACTOR : 1;
    const confidence = Number.isFinite(finding.confidence)
      ? Math.min(1, Math.max(0, finding.confidence))
      : 0;
    raw += weight * confidence * factor;
    if (finding.severity === 'BLOCKER' && finding.lineScope !== 'context') hasBlocker = true;
  }
  const score = Math.round(100 * (1 - Math.exp(-raw / SCORE_SATURATION)));
  return hasBlocker ? Math.max(score, BLOCKER_FLOOR) : score;
}

/** 指纹哈希的种子（四个独立 32 位车道，拼成 128 位十六进制） */
const HASH_SEEDS = [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35] as const;

function hash32(value: string, seed: number): number {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * 归一化发现标题：忽略大小写、标点与多余空白，
 * 使同一问题被不同维度/不同轮次表述时仍能落到同一指纹簇。
 * @param title 原始标题
 * @returns 归一化标题（截断 160 字符控制指纹长度）
 */
export function normalizeFindingTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s`'"“”‘’]+/g, ' ')
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .trim()
    .slice(0, 160);
}

/** 指纹输入：只依赖“问题在哪里、是什么”的稳定字段，不依赖置信度与轮次 */
export type FindingFingerprintInput = {
  filePath: string;
  title: string;
  lineStart: number;
  lineEnd: number;
  /** 规则 ID 优先于维度：同一规则命中即视为同一问题 */
  ruleId?: string | undefined;
  agent: AgentDimension;
};

/**
 * 计算发现指纹（跨维度/跨轮次/跨缓存复用的问题身份）。
 * 身份刻意**不包含维度**：同一缺陷被正确性/安全/性能同时命中时必须落到同一指纹，
 * 否则报告会把一个问题的三份表述各列一条。规则命中优先用 ruleId 作为身份。
 * 行区间参与键：同一标题在不同位置是不同问题。
 * @param input 指纹输入
 * @returns 32 位十六进制指纹
 */
export function fingerprintFinding(input: FindingFingerprintInput): string {
  const normalizedPath = input.filePath.replaceAll('\\', '/');
  const identity = input.ruleId ?? 'issue';
  const key = [
    normalizedPath,
    identity,
    normalizeFindingTitle(input.title),
    String(input.lineStart),
    String(input.lineEnd),
  ].join('\u0000');
  return HASH_SEEDS.map((seed) => hash32(key, seed).toString(16).padStart(8, '0')).join('');
}

/**
 * 为缺少指纹的发现补齐指纹（DB 存量行、缓存回放、第三方构造的发现）。
 * @param finding 发现
 * @returns 带指纹的新对象；已有指纹时原样返回
 */
export function ensureFindingFingerprint(finding: Finding): Finding {
  if (finding.fingerprint !== undefined && finding.fingerprint !== '') return finding;
  return {
    ...finding,
    fingerprint: fingerprintFinding({
      filePath: finding.filePath,
      title: finding.title,
      lineStart: finding.lineStart,
      lineEnd: finding.lineEnd,
      agent: finding.agent,
      ruleId: finding.ruleId,
    }),
  };
}
