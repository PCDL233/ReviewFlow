import { Node, Project, SyntaxKind } from 'ts-morph';
import type { FileContext, Finding } from '@ai-review/shared';
import { analyzeForeignComplexity, languageOf } from './complexity-foreign.js';

/** 函数级复杂度指标（方案 3.4 complexity_check 的输出结构） */
export type FunctionMetrics = {
  name: string;
  line: number;
  endLine: number;
  /** 1 + 分支/循环/异常/短路表达式节点数（方案 3.4） */
  complexity: number;
  params: string[];
  isAsync: boolean;
};

/** 圈复杂度判定节点：决策点各计 1（与规范 §3.1 的复杂度 ≤15 阈值配套） */
const DECISION_KINDS = [
  SyntaxKind.IfStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.CatchClause,
  SyntaxKind.CaseClause,
  SyntaxKind.ConditionalExpression,
] as const;

/**
 * 计算 TS/JS 源码中复杂度达到阈值的函数列表（方案 3.4 analyzeComplexity）。
 * 源码含语法错误时 ts-morph 容错解析，按可得节点统计，不抛出。
 * @param source 文件源码
 * @param threshold 圈复杂度阈值（配置 staticAnalysis.complexityThreshold，默认 15）
 * @returns 复杂度达标的函数指标
 */
export function analyzeComplexity(source: string, threshold = 15): FunctionMetrics[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile('reviewed.ts', source);
  const functions = [
    ...file.getDescendantsOfKind(SyntaxKind.FunctionDeclaration),
    ...file.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
    ...file.getDescendantsOfKind(SyntaxKind.ArrowFunction),
  ];

  return functions
    .map((fn) => {
      let complexity = 1;
      for (const node of fn.getDescendants()) {
        if (DECISION_KINDS.includes(node.getKind() as (typeof DECISION_KINDS)[number])) {
          complexity++;
        }
        if (Node.isBinaryExpression(node)) {
          const op = node.getOperatorToken().getKind();
          if (
            op === SyntaxKind.AmpersandAmpersandToken ||
            op === SyntaxKind.BarBarToken ||
            op === SyntaxKind.QuestionQuestionToken
          ) {
            complexity++;
          }
        }
      }
      const name = Node.isArrowFunction(fn) ? '(anonymous)' : (fn.getName() ?? '(anonymous)');
      return {
        name,
        line: fn.getStartLineNumber(),
        endLine: fn.getEndLineNumber(),
        complexity,
        params: fn.getParameters().map((p) => p.getName()),
        isAsync: fn.isAsync(),
      };
    })
    .filter((m) => m.complexity >= threshold);
}

/** 静态分析的确定性来源决定高基础置信度（方案 3.6 阶段 2：静态分析 0.9） */
const STATIC_CONFIDENCE = 0.9;

/**
 * 对上下文中全部文件执行复杂度检查，产出 static 维度的发现。
 * 删除文件 stagedContent 为空串，跳过解析。
 * @param files 上下文文件列表
 * @param threshold 圈复杂度阈值
 * @returns 复杂度超标发现
 */
export function complexityFindings(files: readonly FileContext[], threshold = 15): Finding[] {
  return files.flatMap((file) => {
    const changed = new Set(
      file.diff.changedLines.flatMap((line) => (line.newLineNo === null ? [] : [line.newLineNo])),
    );
    if (changed.size === 0) return [];
    const language = languageOf(file.diff.path);
    const metrics =
      language === undefined
        ? analyzeComplexity(file.stagedContent, threshold)
        : analyzeForeignComplexity(file.stagedContent, language, threshold);
    return metrics
      .filter((functionMetrics) => {
        for (let line = functionMetrics.line; line <= functionMetrics.endLine; line += 1) {
          if (changed.has(line)) return true;
        }
        return false;
      })
      .map((functionMetrics): Finding => ({
        agent: 'static',
        severity: 'WARNING',
        confidence: STATIC_CONFIDENCE,
        filePath: file.diff.path,
        lineStart: functionMetrics.line,
        lineEnd: functionMetrics.endLine,
        title: `Function "${functionMetrics.name}" has cyclomatic complexity ${functionMetrics.complexity}`,
        description: `Cyclomatic complexity ${functionMetrics.complexity} exceeds the configured threshold ${threshold}. High-complexity functions are hard to test and review.`,
        suggestion: 'Extract guard clauses and split the function into smaller named helpers.',
        isFalsePositive: false,
      }));
  });
}
