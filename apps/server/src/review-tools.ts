import { z } from 'zod';
import type { ReviewSource, ReviewToolDescriptor } from '@ai-review/shared';
import type { GitReader } from '@ai-review/diff';
import { analyzeAst } from '@ai-review/tools';

/**
 * 只读仓库工具（ReAct）。
 * 设计约束：
 * - 只能读取仓库内相对路径，拒绝绝对路径、盘符与 `..`；
 * - 单次读取有行数/字符上限，避免模型把整仓库拉进上下文；
 * - 工具在组合根绑定 GitReader 与审查来源，llm/agents 不直接接触文件系统。
 */

const MAX_TOOL_LINES = 200;
const MAX_TOOL_CHARS = 60_000;

const READ_FILE_SCHEMA = z.object({
  path: z.string().min(1).describe('仓库内相对路径，例如 src/auth/login.ts'),
  startLine: z.number().int().min(1).optional().describe('起始行（1 基，可选）'),
  endLine: z.number().int().min(1).optional().describe('结束行（1 基，可选）'),
});

const LIST_SYMBOLS_SCHEMA = z.object({
  path: z.string().min(1).describe('仓库内相对路径'),
});

const SEARCH_SCHEMA = z.object({
  query: z.string().min(1).max(200).describe('要搜索的文本（字面量，非正则）'),
  maxResults: z.number().int().min(1).max(100).optional().describe('每个文件最多匹配数'),
});

const SYMBOL_SCHEMA = z.object({
  symbol: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z_$][\w$]*$/, '需要合法标识符')
    .describe('标识符，例如 loginUser'),
});

/** 归一化并校验仓库内相对路径；非法路径返回 null */
function normalizeRepoPath(input: string): string | null {
  const path = input.replaceAll('\\', '/').trim();
  if (path === '') return null;
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return null;
  if (path.split('/').includes('..')) return null;
  return path;
}

/**
 * 创建审查期只读工具。
 * @param options gitReader（读取审查来源的新侧内容）与审查来源
 * @returns 工具描述列表；关闭 toolCalling 时不会传入流水线
 */
export function createReviewTools(options: {
  gitReader: GitReader;
  source: ReviewSource;
  /** 本次审查所有工具输出的累计字符预算 */
  charBudget?: number;
}): ReviewToolDescriptor[] {
  // 闭包内计数：同一次审查的多个维度/轮次共享同一预算，避免“每次调用都重新给满额”
  let remaining = options.charBudget ?? MAX_TOOL_CHARS * 2;
  const consume = (text: string): string => {
    if (remaining <= 0) return '工具调用预算已用完，请基于已有上下文继续。';
    const allowed = Math.min(MAX_TOOL_CHARS, remaining);
    remaining -= Math.min(allowed, text.length);
    return text.length > allowed ? `${text.slice(0, allowed)}\n…（工具预算已截断）` : text;
  };
  return [
    {
      name: 'read_file',
      description:
        '读取被审查仓库中某个文件的新侧内容（可指定行范围，最多 200 行）。只读，路径必须在仓库内。',
      inputSchema: READ_FILE_SCHEMA,
      execute: async (input) => {
        const parsed = READ_FILE_SCHEMA.safeParse(input);
        if (!parsed.success) return '参数不合法：需要 path，可选 startLine/endLine。';
        const path = normalizeRepoPath(parsed.data.path);
        if (path === null) return '拒绝访问：路径必须位于仓库内。';
        const content = await options.gitReader.readFileAt(path, options.source);
        if (content === '') return '文件不存在或为空。';
        const lines = content.split(/\r?\n/);
        const start = Math.max(1, parsed.data.startLine ?? 1);
        const end = Math.min(
          lines.length,
          parsed.data.endLine ?? start + MAX_TOOL_LINES - 1,
          start + MAX_TOOL_LINES - 1,
        );
        return consume(lines.slice(start - 1, end).join('\n'));
      },
    },
    {
      name: 'list_symbols',
      description:
        '列出文件中的函数/类/导入（JS/TS 走 AST，其它语言返回文件级摘要）。只读，路径必须在仓库内。',
      inputSchema: LIST_SYMBOLS_SCHEMA,
      execute: async (input) => {
        const parsed = LIST_SYMBOLS_SCHEMA.safeParse(input);
        if (!parsed.success) return '参数不合法：需要 path。';
        const path = normalizeRepoPath(parsed.data.path);
        if (path === null) return '拒绝访问：路径必须位于仓库内。';
        if (!/\.[cm]?[jt]sx?$/i.test(path)) return '仅支持 JS/TS 文件的符号列表。';
        const content = await options.gitReader.readFileAt(path, options.source);
        if (content === '') return '文件不存在或为空。';
        const summary = analyzeAst(content, path);
        return consume(
          JSON.stringify({
            functions: summary.functions.slice(0, 50),
            classes: summary.classes.slice(0, 50),
            imports: summary.imports.slice(0, 50),
            diagnostics: summary.diagnostics.slice(0, 10),
          }),
        );
      },
    },
    {
      name: 'search_repo',
      description:
        '在仓库内搜索文本（git grep，只读；最多 100 条/文件），用于查找调用方、配置项或相似实现。',
      inputSchema: SEARCH_SCHEMA,
      execute: async (input) => {
        const parsed = SEARCH_SCHEMA.safeParse(input);
        if (!parsed.success) return '参数不合法：需要 1-200 字符的 query。';
        const output = await options.gitReader.search(
          parsed.data.query,
          parsed.data.maxResults ?? 50,
        );
        return output === '' ? '未找到匹配。' : consume(output);
      },
    },
    {
      name: 'symbol_refs',
      description: '查找某个标识符在仓库中的引用位置（git grep -w，只读），用于评估改动影响面。',
      inputSchema: SYMBOL_SCHEMA,
      execute: async (input) => {
        const parsed = SYMBOL_SCHEMA.safeParse(input);
        if (!parsed.success) return '参数不合法：需要合法标识符。';
        const output = await options.gitReader.searchSymbol(parsed.data.symbol);
        return output === '' ? '未找到引用。' : consume(output);
      },
    },
  ];
}
