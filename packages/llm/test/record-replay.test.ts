import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeContext } from '@ai-review/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createMockProvider } from '../src/provider.js';
import { createRecordingProvider, createReplayProvider } from '../src/record-replay.js';
import type { ReviewRequest } from '../src/types.js';

let tempDir: string | undefined;

afterAll(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
});

const context = {
  files: [
    {
      diff: {
        path: 'src/run.ts',
        oldPath: null,
        binary: false,
        additions: 1,
        deletions: 0,
        hunks: [],
        changedLines: [{ type: 'added', oldLineNo: null, newLineNo: 3, content: 'eval(input);' }],
        removedLines: [],
        summary: 'eval(input);',
      },
      stagedContent: 'eval(input);',
      snippet: 'eval(input);',
      signature: null,
      ragHits: [],
      changeType: 'feature',
    },
  ],
  metadata: {
    totalFiles: 1,
    totalAdditions: 1,
    totalDeletions: 0,
    languages: ['typescript'],
    // generatedAt 会随时间变化，录制/回放键必须排除该噪声字段
    generatedAt: new Date().toISOString(),
  },
} satisfies CodeContext;

const request: ReviewRequest = {
  dimension: 'security',
  system: '你是代码审查专家。',
  prompt: '请审查下面的变更。',
  context,
};

describe('record/replay providers (方案 4.1 录制回放基建)', () => {
  it('records once and replays identical findings with zero provider calls', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ai-review-llm-'));
    const fixtureDir = join(tempDir, 'fixtures');
    const mock = createMockProvider();
    const recorded = await createRecordingProvider(mock, fixtureDir).review(request);

    const replay = createReplayProvider(fixtureDir);
    const replayed = await replay.review(request);
    expect(replayed.findings).toEqual(recorded.findings);
    expect(replayed.usage).toEqual(recorded.usage);
    // 第二次录制（同输入）覆盖写同一 fixture，键稳定
    await expect(createReplayProvider(fixtureDir).review(request)).resolves.toMatchObject({
      findings: recorded.findings,
    });
  });

  it('fails fast on inputs without a recorded fixture', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ai-review-llm-'));
    const fixtureDir = join(tempDir, 'fixtures');
    await createRecordingProvider(createMockProvider(), fixtureDir).review(request);

    const modified: ReviewRequest = {
      ...request,
      context: {
        ...context,
        files: [
          {
            ...context.files[0],
            stagedContent: 'eval(differentInput);',
          },
        ],
      },
    };
    await expect(createReplayProvider(fixtureDir).review(modified)).rejects.toThrow(
      'no recorded fixture',
    );
  });

  it('treats identical inputs with different timestamps as the same fixture', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ai-review-llm-'));
    const fixtureDir = join(tempDir, 'fixtures');
    await createRecordingProvider(createMockProvider(), fixtureDir).review(request);

    // 仅 metadata.generatedAt 不同的同一输入，键不受噪声字段影响
    const shifted: ReviewRequest = {
      ...request,
      context: {
        ...context,
        metadata: { ...context.metadata, generatedAt: '2000-01-01T00:00:00.000Z' },
      },
    };
    const replayed = await createReplayProvider(fixtureDir).review(shifted);
    expect(replayed.findings).toHaveLength(1);
  });
});
