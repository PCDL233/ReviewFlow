import { describe, expect, it } from 'vitest';
import type { ReviewSource } from '@ai-review/shared';
import { GitReader, resolveSource } from '../src/index.js';

/** 记录 git 调用参数的假执行器 */
function makeGit(
  outputs: Record<string, string>,
  calls: string[][] = [],
): {
  git: (...args: string[]) => Promise<string>;
  calls: string[][];
} {
  return {
    calls,
    git: async (...args: string[]) => {
      calls.push(args);
      const key = args[0] ?? '';
      const value = outputs[key];
      if (value === undefined) throw new Error(`unexpected git invocation: ${args.join(' ')}`);
      return value;
    },
  };
}

describe('resolveSource', () => {
  it('maps staged to a cached diff over the index', () => {
    expect(resolveSource({ target: 'staged' })).toEqual({
      diffArgs: ['--cached'],
      content: { kind: 'index' },
      commitRef: 'HEAD',
    });
  });

  it('maps worktree to an unstaged diff read from disk', () => {
    expect(resolveSource({ target: 'worktree' })).toEqual({
      diffArgs: [],
      content: { kind: 'worktree' },
      commitRef: 'HEAD',
    });
  });

  it('expands a single commit with <sha>^! and reads that commit contents', () => {
    expect(resolveSource({ target: 'commit', commit: 'abc1234' })).toEqual({
      diffArgs: ['abc1234^!'],
      content: { kind: 'ref', ref: 'abc1234' },
      commitRef: 'abc1234',
    });
  });

  it('defaults the range head to HEAD', () => {
    expect(resolveSource({ target: 'range', base: 'origin/main' })).toEqual({
      diffArgs: ['origin/main...HEAD'],
      content: { kind: 'ref', ref: 'HEAD' },
      commitRef: 'HEAD',
    });
  });

  it('honors an explicit range head', () => {
    expect(resolveSource({ target: 'range', base: 'main', head: 'feature' }).diffArgs).toEqual([
      'main...feature',
    ]);
  });
});

describe('GitReader.readDiff', () => {
  const cases: Array<{ source: ReviewSource; expected: string[]; revList?: string }> = [
    { source: { target: 'staged' }, expected: ['diff', '--cached', '--unified=50'] },
    { source: { target: 'worktree' }, expected: ['diff', '--unified=50'] },
    {
      source: { target: 'commit', commit: 'abc1234' },
      expected: ['diff', 'abc1234^!', '--unified=50'],
      revList: 'abc1234 parent\n',
    },
    {
      source: { target: 'range', base: 'origin/main' },
      expected: ['diff', 'origin/main...HEAD', '--unified=50'],
    },
  ];

  for (const { source, expected, revList } of cases) {
    it(`passes the right arguments for ${source.target}`, async () => {
      const { git, calls } = makeGit({
        diff: '',
        ...(revList === undefined ? {} : { 'rev-list': revList }),
      });
      await new GitReader(git).readDiff(source);
      expect(calls[calls.length - 1]).toEqual(expected);
    });
  }

  it('falls back to git show for a root commit without a parent', async () => {
    const { git, calls } = makeGit({ 'rev-list': 'abc1234\n', show: 'root diff' });
    await expect(
      new GitReader(git).readDiff({ target: 'commit', commit: 'abc1234' }),
    ).resolves.toBe('root diff');
    expect(calls).toEqual([
      ['rev-list', '--parents', '-n', '1', 'abc1234'],
      ['show', '--format=', '--unified=50', 'abc1234'],
    ]);
  });
});

describe('GitReader.readFileAt', () => {
  it('reads the index blob for the staged target', async () => {
    const { git, calls } = makeGit({ show: 'index content' });
    await expect(new GitReader(git).readFileAt('src/a.ts', { target: 'staged' })).resolves.toBe(
      'index content',
    );
    expect(calls[0]).toEqual(['show', ':src/a.ts']);
  });

  it('reads the commit blob for a single-commit target', async () => {
    const { git, calls } = makeGit({ show: 'commit content' });
    await expect(
      new GitReader(git).readFileAt('src/a.ts', { target: 'commit', commit: 'abc1234' }),
    ).resolves.toBe('commit content');
    expect(calls[0]).toEqual(['show', 'abc1234:src/a.ts']);
  });

  it('returns an empty string when the blob does not exist (deleted file)', async () => {
    const git = async (): Promise<string> => {
      throw new Error('fatal: path does not exist');
    };
    await expect(new GitReader(git).readFileAt('gone.ts', { target: 'staged' })).resolves.toBe('');
  });

  it('returns an empty string for the worktree target when no repo path is injected', async () => {
    const git = async (): Promise<string> => '';
    await expect(new GitReader(git).readFileAt('src/a.ts', { target: 'worktree' })).resolves.toBe(
      '',
    );
  });
});

describe('GitReader.readStatus', () => {
  it('counts staged, unstaged and untracked entries', async () => {
    const porcelain = ['M  staged.ts', ' M unstaged.ts', 'MM both.ts', '?? new.ts', ''].join('\n');
    const git = async (...args: string[]): Promise<string> => {
      if (args[0] === 'status') return porcelain;
      if (args[0] === 'branch') return 'feature/x\n';
      throw new Error(`unexpected git invocation: ${args.join(' ')}`);
    };
    await expect(new GitReader(git).readStatus()).resolves.toEqual({
      branch: 'feature/x',
      stagedFiles: 2,
      unstagedFiles: 2,
      untrackedFiles: 1,
    });
  });
});

describe('GitReader.readHeadCommit', () => {
  it('returns null for an empty repository', async () => {
    const git = async (): Promise<string> => {
      throw new Error('fatal: ambiguous argument HEAD');
    };
    await expect(new GitReader(git).readHeadCommit()).resolves.toBeNull();
  });

  it('trims the hash output', async () => {
    const git = async (): Promise<string> => 'abc1234\n';
    await expect(new GitReader(git).readHeadCommit()).resolves.toBe('abc1234');
  });
});
