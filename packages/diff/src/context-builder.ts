import pMap from 'p-map';
import { Node, Project, SyntaxKind } from 'ts-morph';
import type {
  CodeContext,
  FileContext,
  FileDiff,
  FunctionSignature,
  IgnoreRules,
  RagRetriever,
  ReviewSource,
} from '@ai-review/shared';
import { getTreeSitterContext } from './ast-foreign.js';
import { createIgnoreRules, filterMeaningfulDiffs } from './filter.js';
import { GitReader } from './git-reader.js';
import { parseUnifiedDiff } from './parser.js';

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java',
};

/** 走 Tree-sitter 语法包的语言（Phase 4 多语言扩展）；JS/TS 由 ts-morph 覆盖 */
const TREE_SITTER_LANGUAGES: ReadonlySet<string> = new Set(['python', 'go', 'java']);

function getLanguage(path: string): string | null {
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension] ?? null;
}

/** 单文件行窗口上限：防止超大文件因窗口计算失控而挤占其余文件与 token 预算 */
const MAX_LINE_WINDOW = 400;

function getLineWindow(
  content: string,
  changedLines: FileDiff['changedLines'],
  radius: number,
): string {
  const lines = content.split(/\r?\n/);
  const lineNumbers = changedLines
    .map((line) => line.newLineNo)
    .filter((line): line is number => line !== null);
  // 历史缺陷：Math.min(...lineNumbers, 1) 恒为 1，窗口总是从文件头开始。
  // 正确语义是“首个变更行 − radius”到“最后一个变更行 + radius”，并限制最大行数。
  if (lineNumbers.length === 0) return '';
  const first = Math.min(...lineNumbers);
  const last = Math.max(...lineNumbers);
  const start = Math.max(1, first - radius);
  const end = Math.min(lines.length, Math.min(last + radius, start - 1 + MAX_LINE_WINDOW));
  return lines.slice(start - 1, end).join('\n');
}

function getTypeScriptContext(
  content: string,
  changedLines: FileDiff['changedLines'],
): { snippet: string; signature: FunctionSignature } {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('reviewed.ts', content);
  const changedLineNumbers = new Set(
    changedLines.flatMap((line) => (line.newLineNo === null ? [] : [line.newLineNo])),
  );
  const candidates = [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.ClassDeclaration),
  ];
  const candidate = candidates.find((node) => {
    const startLine = node.getStartLineNumber();
    const endLine = node.getEndLineNumber();
    return [...changedLineNumbers].some((line) => line >= startLine && line <= endLine);
  });

  if (candidate === undefined) {
    return { snippet: '', signature: null };
  }

  const startLine = candidate.getStartLineNumber();
  const endLine = candidate.getEndLineNumber();
  const snippet = sourceFile
    .getFullText()
    .split(/\r?\n/)
    .slice(startLine - 1, endLine)
    .join('\n');
  if (
    !Node.isFunctionDeclaration(candidate) &&
    !Node.isMethodDeclaration(candidate) &&
    !Node.isArrowFunction(candidate)
  ) {
    return { snippet, signature: null };
  }

  return {
    snippet,
    signature: {
      name: Node.isArrowFunction(candidate)
        ? '(anonymous)'
        : (candidate.getName() ?? '(anonymous)'),
      params: candidate.getParameters().map((parameter) => parameter.getName()),
      isAsync: candidate.isAsync(),
      range: { startLine, endLine },
    },
  };
}

function classifyChange(diff: FileDiff): FileContext['changeType'] {
  const text = `${diff.path}\n${diff.summary}`.toLowerCase();
  if (/(^|[./])test|spec|__tests__/.test(text)) return 'test';
  if (/(^|[./])docs?\//.test(text) || /\.md$/.test(diff.path)) return 'docs';
  if (/fix|bug|patch/.test(text)) return 'bugfix';
  if (/refactor|rename|move/.test(text)) return 'refactor';
  if (/format|prettier|eslint/.test(text)) return 'formatting';
  return 'feature';
}

function buildMetadata(contexts: FileContext[]): CodeContext['metadata'] {
  return {
    totalFiles: contexts.length,
    totalAdditions: contexts.reduce((total, context) => total + context.diff.additions, 0),
    totalDeletions: contexts.reduce((total, context) => total + context.diff.deletions, 0),
    languages: [
      ...new Set(
        contexts
          .map((context) => getLanguage(context.diff.path))
          .filter((language): language is string => language !== null),
      ),
    ],
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 从 diff 源构建 AI 审查上下文。
 * 审查来源由 ReviewSource 描述（暂存区 / 工作区 / 单提交 / 区间）——
 * 四条路径共享同一套过滤与上下文构建，仅"取哪份 diff 与新侧内容"不同：
 * staged 以 index 为唯一事实源（git show :path），commit/range 以对应提交为新侧事实源，
 * worktree 直接读取磁盘文件（HEAD 与工作区的差异）。
 * @throws {Error} diff 读取失败时透传 Git 错误
 */
export class DiffContextBuilder {
  constructor(
    private readonly gitReader: GitReader,
    private readonly rag: RagRetriever,
    private readonly ignores: IgnoreRules = createIgnoreRules([]),
    private readonly contextRadius = 50,
    /** 审查来源；缺省为暂存区（与既有行为一致） */
    private readonly source: ReviewSource = { target: 'staged' },
    /** RAG 召回数量；由 .ai-review.yml 的 rag.topK 注入 */
    private readonly ragTopK = 5,
    /** 仓库根：RAG 按仓库隔离索引 */
    private readonly repoPath: string | undefined = undefined,
  ) {}

  /**
   * 只读取并解析 diff，不构建文件内容/AST/RAG 上下文（规模上限前置的第一步）。
   * 返回的 FileContext 带 diff 与变更类型，足以支撑风险规划；`stagedContent` 为空串。
   * @returns 浅上下文与原始 unified diff
   */
  public async readShallow(): Promise<{ context: CodeContext; rawDiff: string }> {
    const rawDiff = await this.gitReader.readDiff(this.source);
    const diffs = filterMeaningfulDiffs(parseUnifiedDiff(rawDiff), this.ignores);
    const files = diffs.map((diff) => this.shallowFileContext(diff));
    return { context: { files, metadata: buildMetadata(files) }, rawDiff };
  }

  /**
   * 为已入选的文件构建内容上下文。
   * `fullPaths` 内的文件构建 AST + RAG 上下文；其余文件只读取内容与行窗口
   * （静态工具仍可工作，但省去最贵的 AST 解析与向量检索）。
   * @param diffs 已通过规模上限的文件 diff
   * @param options.fullPaths 需要完整 LLM 上下文的文件；缺省表示全部完整
   * @param options.metadata 保留 parse 阶段基于“全部变更文件”计算的元信息
   * @returns 文件级上下文
   */
  public async buildContexts(
    diffs: readonly FileDiff[],
    options: {
      fullPaths?: ReadonlySet<string>;
      metadata: CodeContext['metadata'];
    },
  ): Promise<CodeContext> {
    const fullPaths = options.fullPaths;
    const files = await pMap(
      diffs,
      (diff) =>
        this.buildFileContext(
          diff,
          fullPaths === undefined || fullPaths.has(diff.path),
        ),
      { concurrency: 8 },
    );
    return { files, metadata: { ...options.metadata, totalFiles: diffs.length } };
  }

  /**
   * 读取、过滤并并行构建全部文件的完整上下文（保留给测试与既有调用方）。
   * 生产流水线使用 readShallow + buildContexts，以便先做规模上限再付上下文的成本。
   * @returns 审查上下文包与原始 unified diff
   */
  public async build(): Promise<{ context: CodeContext; rawDiff: string }> {
    const shallow = await this.readShallow();
    const context = await this.buildContexts(
      shallow.context.files.map((file) => file.diff),
      { metadata: shallow.context.metadata },
    );
    return { context, rawDiff: shallow.rawDiff };
  }

  /** 浅上下文：只带 diff 与变更类型，不读文件内容 */
  private shallowFileContext(diff: FileDiff): FileContext {
    return {
      diff,
      stagedContent: '',
      snippet: '',
      signature: null,
      ragHits: [],
      changeType: classifyChange(diff),
    };
  }

  private async buildFileContext(diff: FileDiff, full: boolean): Promise<FileContext> {
    const newSideContent = await this.gitReader.readFileAt(diff.path, this.source);
    if (!full) {
      return {
        diff,
        stagedContent: newSideContent,
        snippet: getLineWindow(newSideContent, diff.changedLines, this.contextRadius),
        signature: null,
        ragHits: [],
        changeType: classifyChange(diff),
      };
    }
    const language = getLanguage(diff.path);
    const astContext =
      language === 'typescript' || language === 'javascript'
        ? getTypeScriptContext(newSideContent, diff.changedLines)
        : language !== null && TREE_SITTER_LANGUAGES.has(language)
          ? getTreeSitterContext(newSideContent, diff.changedLines, language)
          : { snippet: '', signature: null };
    const snippet =
      astContext.snippet || getLineWindow(newSideContent, diff.changedLines, this.contextRadius);
    // 跨文件检索：不能再按当前文件路径过滤——那会把“同文件相似函数”之外的项目约定/相似实现
    // 全部排除，导致 RAG 实际恒为空（历史缺陷）。查询词由路径、摘要与变更标识符组成。
    const queryText = [
      diff.path,
      diff.summary,
      ...diff.changedLines
        .filter((line) => line.type === 'added')
        .map((line) => line.content.trim())
        .filter((line) => line.length > 0)
        .slice(0, 12),
    ].join('\n');
    const ragHits = await this.rag.query({
      query: queryText,
      topK: this.ragTopK,
      ...(this.repoPath === undefined ? {} : { repoPath: this.repoPath }),
    });
    return {
      diff,
      stagedContent: newSideContent,
      snippet,
      signature: astContext.signature,
      ragHits,
      changeType: classifyChange(diff),
    };
  }
}
