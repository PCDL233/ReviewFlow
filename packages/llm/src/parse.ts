import { FindingSchema } from '@ai-review/shared';
import type { Finding } from '@ai-review/shared';
import { LlmError, type ReviewDimension } from './types.js';

/**
 * 模型输出解析（HTTP 与 AI SDK 两条 transport 共用）。
 * 关键约束：agent 永远由调用方维度决定，绝不信任模型自报的 agent——
 * 否则模型输出 agent=static 就能拿到静态分析的 0.9 置信度基线（历史缺陷）。
 */

/** 从可能包含 Markdown 围栏/前后缀的文本中提取 JSON 数组 */
export function extractJson(text: string): unknown {
  const candidates = [
    text.trim(),
    text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim(),
  ];
  const firstArray = text.indexOf('[');
  const lastArray = text.lastIndexOf(']');
  if (firstArray >= 0 && lastArray > firstArray) {
    candidates.push(text.slice(firstArray, lastArray + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed;
      if (typeof parsed === 'object' && parsed !== null && 'findings' in parsed) {
        const findings = (parsed as { findings?: unknown }).findings;
        if (Array.isArray(findings)) return findings;
      }
    } catch {
      // 尝试下一个候选片段；最终由调用方给出明确的响应格式错误。
    }
  }
  throw new LlmError('LLM response did not contain a JSON findings array', 'bad-response');
}

/**
 * 解析模型输出为发现数组。
 * @param text 模型原始文本
 * @param dimension 当前审查维度
 * @returns 通过 schema 校验的发现（行号校验在 agents 层）
 */
export function parseFindings(text: string, dimension: ReviewDimension): Finding[] {
  const raw = extractJson(text);
  if (!Array.isArray(raw)) throw new LlmError('LLM findings must be an array', 'bad-response');
  const findings = raw.flatMap((value): Finding[] => {
    if (typeof value !== 'object' || value === null) return [];
    const normalized = {
      ...(value as Record<string, unknown>),
      agent: dimension,
      origin: 'llm',
      isFalsePositive: false,
    };
    const parsed = FindingSchema.safeParse(normalized);
    return parsed.success ? [parsed.data] : [];
  });
  if (raw.length > 0 && findings.length === 0) {
    throw new LlmError('LLM response contained no valid findings', 'bad-response');
  }
  return findings;
}
