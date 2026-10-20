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

function getLineWindow(
  content: string,
  changedLines: FileDiff['changedLines'],
  radius: number,
): string {
  const lines = content.split(/\r?\n/);
  const lineNumbers = changedLines
    .map((line) => line.newLineNo)
    .filter((line): line is number => line !== null);
  const start = Math.max(1, Math.min(...lineNumbers, 1) - radius);
  const end = Math.min(lines.length, Math.max(...lineNumbers, 1) + radius);
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
  ) {}

  /**
   * 读取、过滤并并行构建文件级上下文。
   * 同时返回原始 diff，使流水线无需重复执行一次 `git diff`。
   * @returns 审查上下文包与原始 unified diff
   */
  public async build(): Promise<{ context: CodeContext; rawDiff: string }> {
    const rawDiff = await this.gitReader.readDiff(this.source);
    const diffs = filterMeaningfulDiffs(parseUnifiedDiff(rawDiff), this.ignores);
    const contexts = await pMap(diffs, (diff) => this.buildFileContext(diff), { concurrency: 8 });
    return { context: { files: contexts, metadata: buildMetadata(contexts) }, rawDiff };
  }

  private async buildFileContext(diff: FileDiff): Promise<FileContext> {
    const newSideContent = await this.gitReader.readFileAt(diff.path, this.source);
    const language = getLanguage(diff.path);
    const astContext =
      language === 'typescript' || language === 'javascript'
        ? getTypeScriptContext(newSideContent, diff.changedLines)
        : language !== null && TREE_SITTER_LANGUAGES.has(language)
          ? getTreeSitterContext(newSideContent, diff.changedLines, language)
          : { snippet: '', signature: null };
    const snippet =
      astContext.snippet || getLineWindow(newSideContent, diff.changedLines, this.contextRadius);
    const ragHits = await this.rag.query({
      query: diff.summary,
      topK: this.ragTopK,
      filter: { path: diff.path },
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
