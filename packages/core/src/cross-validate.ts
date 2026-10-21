import { SEVERITY_RANK, ensureFindingFingerprint, resolveFindingOrigin } from '@ai-review/shared';
import type { CodeContext, Finding } from '@ai-review/shared';

/** 静态分析发现的确定性来源决定高基础置信度（方案 3.6 阶段 2） */
const STATIC_BASE_CONFIDENCE = 0.9;
/** LLM 语义发现的基础置信度上限：语义判断本质不确定（方案 3.6 阶段 2） */
const LLM_BASE_CONFIDENCE = 0.6;
/** 多源交叉确认加成：另一维度 Agent 在同文件同区间给出发现（方案 3.6 阶段 2） */
const CROSS_SOURCE_BONUS = 0.2;

function overlaps(a: Finding, b: Finding): boolean {
  return a.lineStart <= b.lineEnd && b.lineStart <= a.lineEnd;
}

function isStaticFinding(finding: Finding): boolean {
  // 来源优先于 agent 字段：即使 agent 被外部改写，静态来源仍按静态基线计分
  return resolveFindingOrigin(finding) === 'static';
}

/**
 * 阶段 1：严重度重分类（方案 3.6）。
 * 测试/文档文件中的高危发现降级为 NIT——例如测试文件中的硬编码值。
 */
export function reclassifySeverity(findings: readonly Finding[], context: CodeContext): Finding[] {
  const lowStakesPaths = new Set(
    context.files
      .filter((file) => file.changeType === 'test' || file.changeType === 'docs')
      .map((file) => file.diff.path),
  );
  return findings.map((finding) => {
    if (
      !lowStakesPaths.has(finding.filePath) ||
      SEVERITY_RANK[finding.severity] <= SEVERITY_RANK.NIT
    ) {
      return finding;
    }
    return {
      ...finding,
      severity: 'NIT' as const,
      description: `${finding.description} (severity reclassified: finding is in a test or docs file)`,
    };
  });
}

/**
 * 阶段 2：置信度评分（方案 3.6）。
 * 按确定性来源设定基准：静态分析 0.9、LLM 语义 0.6；多源交叉确认在基准上 +0.2；
 * 无交叉确认时不超过 Provider 给出的置信度且不超过基准——既压制 LLM 过度自信，
 * 又保留其 LOW_CONFIDENCE 低分信号（自愈回退依赖低置信度触发）。
 */
export function scoreConfidence(findings: readonly Finding[]): Finding[] {
  return findings.map((finding) => {
    const base = isStaticFinding(finding) ? STATIC_BASE_CONFIDENCE : LLM_BASE_CONFIDENCE;
    // 只有“确定性来源”的确认才给 LLM 发现提分：两个 LLM 维度基于同一段上下文互相附和，
    // 不构成独立证据；若据此提分，会把模型自己标注的 lowConfidence(0.4) 抬到 0.8，
    // 自愈回退永远不会触发（历史缺陷）。静态发现本身可被任意来源进一步确认。
    const crossConfirmed = findings.some(
      (other) =>
        other !== finding &&
        other.filePath === finding.filePath &&
        overlaps(other, finding) &&
        (isStaticFinding(finding) || isStaticFinding(other)),
    );
    const confidence = crossConfirmed
      ? Math.min(1, base + CROSS_SOURCE_BONUS)
      : Math.min(finding.confidence, base);
    return { ...finding, confidence };
  });
}

/**
 * 阶段 5：去重（方案 3.6）。
 * 按“问题指纹”（文件 + 规则/维度 + 归一化标题 + 行区间）聚类，**跨维度合并**：
 * 同一缺陷被正确性/安全/性能同时命中时，报告只保留一条并记录 agents 列表，
 * 而不是按 agent 分成三条（历史缺陷：三个维度报告同一问题三遍）。
 * 同簇保留置信度更高者；置信度相同时保留后写入的版本（自愈/交叉验证修正覆盖原始结论）。
 */
export function dedupeFindings(findings: readonly Finding[]): Finding[] {
  const clusters = new Map<string, Finding>();
  for (const raw of findings) {
    const finding = ensureFindingFingerprint(raw);
    const key =
      finding.fingerprint ??
      `${finding.filePath}\u0000${finding.agent}\u0000${finding.title}\u0000${finding.lineStart}\u0000${finding.lineEnd}`;
    const existing = clusters.get(key);
    if (existing === undefined) {
      clusters.set(key, finding);
      continue;
    }
    const agents = [
      ...new Set([
        existing.agent,
        finding.agent,
        ...(existing.agents ?? []),
        ...(finding.agents ?? []),
      ]),
    ];
    // 后写覆盖：交叉验证/自愈产出的修正版本必须能覆盖原始结论（即使置信度更低，
    // 例如复核后把 0.8 修正为 0.4）。若按“取更高置信度”，修正永远无法生效。
    clusters.set(key, { ...finding, agents });
  }
  return [...clusters.values()];
}

/**
 * 阶段 5：排序（方案 3.6）。
 * 按"严重度 × 置信度"降序，同分按文件与行号升序保证输出确定性。
 */
export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
    const byConfidence = b.confidence - a.confidence;
    if (byConfidence !== 0) return byConfidence;
    const byPath = a.filePath.localeCompare(b.filePath);
    if (byPath !== 0) return byPath;
    const byLine = a.lineStart - b.lineStart;
    if (byLine !== 0) return byLine;
    return (a.fingerprint ?? a.title).localeCompare(b.fingerprint ?? b.title);
  });
}

/**
 * 交叉验证入口（方案 3.6）：阶段 1 重分类 → 阶段 2 置信度 → 阶段 5 去重排序。
 * 阶段 3（跨文件分析）与阶段 4（自动修复建议）依赖 ts-morph 编译级核对与
 * ESLint 规则元数据，在后续里程碑接入；接入后插入本组合序列。
 */
export function crossValidate(findings: readonly Finding[], context: CodeContext): Finding[] {
  return sortFindings(dedupeFindings(scoreConfidence(reclassifySeverity(findings, context))));
}
