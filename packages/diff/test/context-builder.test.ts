import type { RagHit } from '@ai-review/shared';
import { describe, expect, it } from 'vitest';
import { DiffContextBuilder, GitReader } from '../src/index.js';

const FILE_PATH = 'src/auth/login.ts';

const DIFF = [
  `diff --git a/${FILE_PATH} b/${FILE_PATH}`,
  'index 1111111..2222222 100644',
  `--- a/${FILE_PATH}`,
  `+++ b/${FILE_PATH}`,
  '@@ -1,2 +1,3 @@',
  ' const config = loadConfig();',
  '+export function login(user: string) { return authorize(user); }',
  ' export function logout() {}',
].join('\n');

const SOURCE = [
  'const config = loadConfig();',
  'export function login(user: string) { return authorize(user); }',
  'export function logout() {}',
].join('\n');

function makeGit(): GitReader {
  return new GitReader(async (...args: string[]) => {
    if (args[0] === 'diff') return DIFF;
    if (args[0] === 'show') return SOURCE;
    return '';
  });
}

describe('DiffContextBuilder RAG wiring', () => {
  it('queries cross-file context instead of filtering to the current file', async () => {
    const queries: Array<{ query: string; topK?: number; filter?: { path?: string } }> = [];
    const hits: RagHit[] = [
      {
        id: 'docs/conventions.md#0',
        path: 'docs/conventions.md',
        kind: 'doc',
        text: 'All handlers must call requireUser().',
        score: 0.9,
      },
    ];
    const builder = new DiffContextBuilder(
      makeGit(),
      {
        query: async (query) => {
          queries.push(query);
          return hits;
        },
      },
      { allows: () => true },
      50,
      { target: 'staged' },
      5,
    );

    const { context } = await builder.build();
    expect(queries).toHaveLength(1);
    expect(queries[0]?.filter).toBeUndefined();
    expect(queries[0]?.query).toContain(FILE_PATH);
    expect(context.files[0]?.ragHits).toEqual(hits);
  });
});
