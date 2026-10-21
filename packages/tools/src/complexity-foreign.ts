import Parser from 'tree-sitter';
import Python from 'tree-sitter-python';
import Go from 'tree-sitter-go';
import Java from 'tree-sitter-java';
import type { FunctionMetrics } from './complexity.js';

/** 非 JS/TS 语言（当前支持 Python/Go/Java 的近似复杂度） */
export type ForeignLanguage = 'python' | 'go' | 'java';

const FUNCTION_NODE_KINDS: Readonly<Record<ForeignLanguage, readonly string[]>> = {
  python: ['function_definition'],
  go: ['function_declaration', 'method_declaration'],
  java: ['method_declaration', 'constructor_declaration'],
};

const DECISION_NODE_KINDS = new Set([
  'if_statement',
  'for_statement',
  'while_statement',
  'do_statement',
  'catch_clause',
  'except_clause',
  'switch_statement',
  'switch_expression',
  'expression_switch_statement',
  'type_switch_statement',
  'expression_case',
  'default_case',
  'switch_case',
  'case_statement',
  'conditional_expression',
  'ternary_expression',
]);

const LANGUAGE_BINDINGS: Readonly<Record<ForeignLanguage, Parser.Language>> = {
  // 语法包官方 d.ts 声明与 tree-sitter 的 Language 接口结构不兼容，
  // 运行时即原生绑定；此处为唯一边界断言（与 packages/diff 的处理一致）
  python: Python as unknown as Parser.Language,
  go: Go as unknown as Parser.Language,
  java: Java as unknown as Parser.Language,
};

/**
 * 按文件扩展名识别非 JS/TS 语言。
 * 只对明确支持的三种语言返回结果，其余交给 ts-morph（或跳过）。
 */
export function languageOf(path: string): ForeignLanguage | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith('.py')) return 'python';
  if (lower.endsWith('.go')) return 'go';
  if (lower.endsWith('.java')) return 'java';
  return undefined;
}

/** 去除注释与字符串字面量，避免把文本里的 if/for 计入复杂度 */
function stripNoise(source: string, language: ForeignLanguage): string {
  let text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  if (language === 'python') text = text.replace(/#[^\n]*/g, '');
  return text
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

/** 计决策点：关键字按词边界计数，`&&`/`||` 短路各计 1 */
function countDecisions(block: string, keywords: readonly string[]): number {
  let count = 0;
  for (const keyword of keywords) {
    count += (block.match(new RegExp(`\\b${keyword}\\b`, 'g')) ?? []).length;
  }
  count += (block.match(/&&|\|\|/g) ?? []).length;
  return count;
}

/** 从函数声明行开始按花括号配对找到函数结束行；找不到闭合返回 undefined */
function braceBlockEnd(lines: readonly string[], start: number): number | undefined {
  let depth = 0;
  let opened = false;
  for (let index = start; index < lines.length; index += 1) {
    for (const char of lines[index] ?? '') {
      if (char === '{') {
        depth += 1;
        opened = true;
      } else if (char === '}') {
        depth -= 1;
        if (opened && depth === 0) return index;
      }
    }
  }
  return undefined;
}

function pythonMetrics(source: string, threshold: number): FunctionMetrics[] {
  const lines = source.split('\n');
  const metrics: FunctionMetrics[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const signature = lines[index] ?? '';
    const match = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(signature);
    if (match === null) continue;
    const baseIndent = (match[1] ?? '').replaceAll('\t', '    ').length;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const line = lines[cursor] ?? '';
      if (line.trim() === '') continue;
      const indent = (line.match(/^\s*/)?.[0] ?? '').replaceAll('\t', '    ').length;
      if (indent <= baseIndent) {
        end = cursor;
        break;
      }
    }
    const block = lines.slice(index, end).join('\n');
    const complexity =
      1 + countDecisions(block, ['if', 'elif', 'for', 'while', 'except', 'case', 'and', 'or']);
    if (complexity >= threshold) {
      metrics.push({
        name: match[2] ?? '(anonymous)',
        line: index + 1,
        endLine: end,
        complexity,
        params: [],
        isAsync: /^\s*async\s+def\b/.test(signature),
      });
    }
  }
  return metrics;
}

const BRACE_DECLARATIONS: Record<'go' | 'java', RegExp> = {
  go: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/,
  java:
    /^\s*(?:(?:public|private|protected|static|final|synchronized|abstract|native|default)\s+)*[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*(?:throws[^{]+)?\{/,
};

function braceMetrics(
  source: string,
  language: 'go' | 'java',
  threshold: number,
): FunctionMetrics[] {
  const lines = source.split('\n');
  const metrics: FunctionMetrics[] = [];
  const declaration = BRACE_DECLARATIONS[language];
  for (let index = 0; index < lines.length; index += 1) {
    const match = declaration.exec(lines[index] ?? '');
    if (match === null) continue;
    const end = braceBlockEnd(lines, index);
    if (end === undefined) continue;
    const block = lines.slice(index, end + 1).join('\n');
    // Go/Java 的 switch 只计 case；catch 计 1；三元表达式在 Java 中另计 1
    const complexity =
      1 +
      countDecisions(block, ['if', 'for', 'while', 'case', 'catch']) +
      (language === 'java' ? (block.match(/\?/g) ?? []).length : 0);
    if (complexity >= threshold) {
      metrics.push({
        name: match[1] ?? '(anonymous)',
        line: index + 1,
        endLine: end + 1,
        complexity,
        params: [],
        isAsync: false,
      });
    }
  }
  return metrics;
}

/**
 * 非 JS/TS 的 AST 级圈复杂度（tree-sitter）。
 * 解析失败或含 ERROR 节点时返回 undefined，由调用方回退到启发式。
 */
function astMetrics(
  source: string,
  language: ForeignLanguage,
  threshold: number,
): FunctionMetrics[] | undefined {
  let tree: Parser.Tree;
  try {
    const parser = new Parser();
    parser.setLanguage(LANGUAGE_BINDINGS[language]);
    tree = parser.parse(source);
  } catch {
    return undefined;
  }
  if (tree.rootNode.hasError) return undefined;

  const functionKinds = FUNCTION_NODE_KINDS[language];
  const metrics: FunctionMetrics[] = [];
  const countDecisions = (node: Parser.SyntaxNode): number => {
    let count = 0;
    for (const child of node.namedChildren) {
      // 嵌套函数单独统计，不计入外层函数复杂度
      if (functionKinds.includes(child.type)) continue;
      if (DECISION_NODE_KINDS.has(child.type)) count += 1;
      if (child.type === 'binary_expression' && /&&|\|\||\band\b|\bor\b/.test(child.text)) {
        count += 1;
      }
      count += countDecisions(child);
    }
    return count;
  };

  const visit = (node: Parser.SyntaxNode): void => {
    if (functionKinds.includes(node.type)) {
      const nameNode =
        node.childForFieldName('name') ??
        node.namedChildren.find((child) => child.type === 'identifier');
      const complexity = 1 + countDecisions(node);
      if (complexity >= threshold) {
        metrics.push({
          name: nameNode?.text ?? '(anonymous)',
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          complexity,
          params: [],
          isAsync: language === 'python' && node.text.startsWith('async'),
        });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(tree.rootNode);
  return metrics;
}

/**
 * 非 JS/TS 的圈复杂度。
 * 优先使用 tree-sitter AST；语法错误/解析失败时回退到“去注释/字符串 + 缩进或花括号配对”的启发式，
 * 保证任何输入都能给出一致、可解释的结果，而不是抛异常。
 * @param source 文件源码
 * @param language 由 `languageOf` 识别出的语言
 * @param threshold 圈复杂度阈值
 * @returns 达到阈值的函数指标
 */
export function analyzeForeignComplexity(
  source: string,
  language: ForeignLanguage,
  threshold = 15,
): FunctionMetrics[] {
  const ast = astMetrics(source, language, threshold);
  if (ast !== undefined) return ast;
  const cleaned = stripNoise(source, language);
  return language === 'python'
    ? pythonMetrics(cleaned, threshold)
    : braceMetrics(cleaned, language, threshold);
}
