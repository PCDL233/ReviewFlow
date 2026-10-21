import { describe, expect, it } from 'vitest';
import { GitReader } from '@ai-review/diff';
import type { ReviewToolDescriptor } from '@ai-review/shared';
import { createReviewTools } from '../src/review-tools.js';

function makeReader(files: Record<string, string>): GitReader {
  return new GitReader(async (...args: string[]) => {
    if (args[0] === 'show') {
      const ref = args[1] ?? '';
      const path = ref.slice(ref.indexOf(':') + 1);
      return files[path] ?? '';
    }
    if (args[0] === 'grep') return 'src/a.ts:1:line one';
    return '';
  });
}

function toolNamed(tools: ReviewToolDescriptor[], name: string): ReviewToolDescriptor {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`missing tool ${name}`);
  return tool;
}

describe('review tools', () => {
  const tools = createReviewTools({
    gitReader: makeReader({
      'src/a.ts': ['line one', 'line two', 'line three'].join('\n'),
      'src/symbols.ts': ['export function login() {}', 'export class User {}'].join('\n'),
    }),
    source: { target: 'staged' },
  });

  it('reads a bounded line range from the repo', async () => {
    const read = toolNamed(tools, 'read_file');
    await expect(read.execute({ path: 'src/a.ts', startLine: 2, endLine: 2 })).resolves.toBe(
      'line two',
    );
    await expect(read.execute({ path: 'src/a.ts', startLine: 2 })).resolves.toContain('line three');
  });

  it('rejects absolute paths and parent traversal', async () => {
    const read = toolNamed(tools, 'read_file');
    await expect(read.execute({ path: '../secret' })).resolves.toContain('拒绝访问');
    await expect(read.execute({ path: '/etc/passwd' })).resolves.toContain('拒绝访问');
    await expect(read.execute({ path: 'C:/secret' })).resolves.toContain('拒绝访问');
  });

  it('lists JS/TS symbols for a file', async () => {
    const list = toolNamed(tools, 'list_symbols');
    const output = await list.execute({ path: 'src/symbols.ts' });
    const parsed = JSON.parse(output) as {
      functions: Array<{ name: string }>;
      classes: Array<{ name: string }>;
    };
    expect(parsed.functions[0]?.name).toBe('login');
    expect(parsed.classes[0]?.name).toBe('User');
  });

  it('does not expose non-JS/TS symbol parsing', async () => {
    const list = toolNamed(tools, 'list_symbols');
    await expect(list.execute({ path: 'README.md' })).resolves.toContain('仅支持 JS/TS');
  });

  it('searches the repo with git grep and rejects oversized queries', async () => {
    const search = toolNamed(tools, 'search_repo');
    await expect(search.execute({ query: 'line' })).resolves.toContain('src/a.ts');
    await expect(search.execute({ query: 'x'.repeat(201) })).resolves.toContain('参数不合法');
  });

  it('finds identifier references and rejects invalid symbols', async () => {
    const refs = toolNamed(tools, 'symbol_refs');
    await expect(refs.execute({ symbol: 'login' })).resolves.toContain('src/a.ts');
    await expect(refs.execute({ symbol: 'foo-bar' })).resolves.toContain('参数不合法');
  });

  it('caps cumulative tool output by the char budget', async () => {
    const budgetTools = createReviewTools({
      gitReader: makeReader({ 'src/a.ts': 'abcdefghijklmnop' }),
      source: { target: 'staged' },
      charBudget: 10,
    });
    const read = toolNamed(budgetTools, 'read_file');
    const first = await read.execute({ path: 'src/a.ts' });
    expect(first.startsWith('abcdefghij')).toBe(true);
    expect(first).toContain('截断');
    await expect(read.execute({ path: 'src/a.ts' })).resolves.toContain('预算已用完');
  });
});
