import type { CodeContext, Finding } from '@ai-review/shared';

/**
 * 审查载荷构造（方案 3.3/3.4）。
 * 与旧实现的区别：模型输入不再只有“前 8 行摘要 + 变更行”，而是包含
 * 函数级片段、AST 签名、RAG 命中、静态分析证据、命中规则与项目约定——
 * 这是“证据驱动的审查”与“盲猜式分类”的分界线。
 */

/** 单文件源码片段上限：避免超大函数挤占其余文件 */
const MAX_SNIPPET_CHARS = 6_000;
/** 单文件变更行上限（超出时显式标注截断，不静默丢弃） */
const MAX_CHANGED_LINES_PER_FILE = 400;
/** 单条 RAG 命中文本上限 */
const MAX_RAG_TEXT_CHARS = 600;
/** 项目约定文本上限 */
const MAX_CONVENTIONS_CHARS = 4_000;
/** 整份 prompt 字符上限：超出时依次舍弃 RAG、片段，保留变更行与证据 */
const MAX_PROMPT_CHARS = 120_000;

export type ReviewPromptInput = {
  context: CodeContext;
  /** 静态工具产出的确定性证据（已按文件归组前） */
  evidence?: readonly Finding[];
  /** 自愈轮次的上一轮发现 */
  priorFindings?: readonly Finding[];
  /** 项目约定（AGENTS.md / CLAUDE.md / 规则说明）摘要 */
  conventions?: string;
  /** 是否为自愈复核轮次 */
  strict?: boolean;
};

type SerializedFinding = {
  severity: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  title: string;
  description: string;
  suggestion?: string;
  cweId?: string;
};

function serializeFinding(finding: Finding): SerializedFinding {
  return {
    severity: finding.severity,
    filePath: finding.filePath.replaceAll('\\', '/'),
    lineStart: finding.lineStart,
    lineEnd: finding.lineEnd,
    title: finding.title,
    description: finding.description.slice(0, 400),
    ...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion.slice(0, 300) }),
    ...(finding.cweId === undefined ? {} : { cweId: finding.cweId }),
  };
}

function groupByFile(
  findings: readonly Finding[] | undefined,
): ReadonlyMap<string, readonly Finding[]> {
  const map = new Map<string, Finding[]>();
  for (const finding of findings ?? []) {
    const key = finding.filePath.replaceAll('\\', '/');
    const group = map.get(key) ?? [];
    group.push(finding);
    map.set(key, group);
  }
  return map;
}

type FilePayload = {
  path: string;
  changeType: string;
  additions: number;
  deletions: number;
  summary: string;
  signature: unknown;
  changedLines: Array<{
    type: string;
    oldLineNo: number | null;
    newLineNo: number | null;
    content: string;
  }>;
  changedLinesTruncated: boolean;
  snippet?: string;
  ragHits?: Array<{ path: string; kind: string; text: string }>;
  staticEvidence?: SerializedFinding[];
  priorFindings?: SerializedFinding[];
};

function buildFilePayload(
  context: CodeContext,
  evidenceByFile: ReadonlyMap<string, readonly Finding[]>,
  priorByFile: ReadonlyMap<string, readonly Finding[]>,
  includeSnippet: boolean,
  includeRag: boolean,
): FilePayload[] {
  return context.files.map((file) => {
    const path = file.diff.path.replaceAll('\\', '/');
    const relatedEvidence = evidenceByFile.get(path);
    const relatedPrior = priorByFile.get(path);
    const changedLines = file.diff.changedLines.slice(0, MAX_CHANGED_LINES_PER_FILE);
    return {
      path,
      changeType: file.changeType,
      additions: file.diff.additions,
      deletions: file.diff.deletions,
      summary: file.diff.summary,
      signature: file.signature,
      changedLines: changedLines.map((line) => ({
        type: line.type,
        oldLineNo: line.oldLineNo,
        newLineNo: line.newLineNo,
        content: line.content,
      })),
      changedLinesTruncated: file.diff.changedLines.length > MAX_CHANGED_LINES_PER_FILE,
      ...(includeSnippet && file.snippet !== ''
        ? { snippet: file.snippet.slice(0, MAX_SNIPPET_CHARS) }
        : {}),
      ...(includeRag && file.ragHits.length > 0
        ? {
            ragHits: file.ragHits.slice(0, 5).map((hit) => ({
              path: hit.path,
              kind: hit.kind,
              text: hit.text.slice(0, MAX_RAG_TEXT_CHARS),
            })),
          }
        : {}),
      ...(relatedEvidence === undefined
        ? {}
        : { staticEvidence: relatedEvidence.map(serializeFinding) }),
      ...(relatedPrior === undefined ? {} : { priorFindings: relatedPrior.map(serializeFinding) }),
    };
  });
}

/**
 * 构造审查用户载荷（不含维度 system prompt）。
 * 体积超限时按“RAG → 片段”的顺序降级，变更行与静态证据永不丢弃。
 * @param input 上下文、证据与约定
 * @returns 可直接作为 user message 的文本
 */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  const evidenceByFile = groupByFile(input.evidence);
  const priorByFile = groupByFile(input.priorFindings);
  const header = [
    '下面是一次真实的代码变更审查任务。请只基于提供的内容推理；',
    '未提供的代码不要假设存在，也不要编造文件路径、行号或外部漏洞编号。',
    input.strict === true
      ? '本轮是复核轮次：请优先处理 priorFindings，并给出最终结论。'
      : '请聚焦本次变更引入的问题；上下文行中的历史问题只有在被本次变更影响时才报告。',
  ].join('\n');

  const conventions =
    input.conventions === undefined || input.conventions.trim() === ''
      ? ''
      : `\n## 项目约定（仅作背景，与代码事实冲突时以代码为准）\n${input.conventions.slice(0, MAX_CONVENTIONS_CHARS)}\n`;

  const attempt = (includeSnippet: boolean, includeRag: boolean): string => {
    const files = buildFilePayload(
      input.context,
      evidenceByFile,
      priorByFile,
      includeSnippet,
      includeRag,
    );
    return [
      header,
      conventions,
      '## 变更文件',
      JSON.stringify({ metadata: input.context.metadata, files }, null, 2),
      '',
      '现在输出 JSON 数组。',
    ].join('\n');
  };

  let prompt = attempt(true, true);
  if (prompt.length > MAX_PROMPT_CHARS) prompt = attempt(true, false);
  if (prompt.length > MAX_PROMPT_CHARS) prompt = attempt(false, false);
  return prompt;
}
