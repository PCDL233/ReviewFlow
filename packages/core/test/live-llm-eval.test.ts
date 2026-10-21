import { ReviewAgent } from '@ai-review/agents';
import { createConfiguredProvider } from '@ai-review/llm';
import { loadConfig } from '@ai-review/shared';
import type { CodeContext } from '@ai-review/shared';
import { describe, expect, it } from 'vitest';

/**
 * 真实模型评估入口（默认跳过，零 token）。
 * 用法：
 *   AI_REVIEW_LIVE_EVAL=1 AI_REVIEW_CONFIG=apps/server/.ai-review.yml \
 *   pnpm --filter @ai-review/core exec vitest run test/live-llm-eval.test.ts
 * CI 不设置该环境变量，因此不会产生外部调用；需要真实模型召回数据时手动运行。
 */

const CONTENT = 'eval(userInput);';
const context: CodeContext = {
  files: [
    {
      diff: {
        path: 'src/live-eval.ts',
        oldPath: null,
        binary: false,
        additions: 1,
        deletions: 0,
        hunks: [],
        removedLines: [],
        changedLines: [{ type: 'added', oldLineNo: null, newLineNo: 1, content: CONTENT }],
        summary: CONTENT,
      },
      stagedContent: CONTENT,
      snippet: CONTENT,
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
    generatedAt: new Date().toISOString(),
  },
};

const enabled = process.env.AI_REVIEW_LIVE_EVAL === '1';
const configPath = process.env.AI_REVIEW_CONFIG ?? 'apps/server/.ai-review.yml';

describe.skipIf(!enabled)('live LLM evaluation', () => {
  it('detects the seeded eval defect with the configured provider', async () => {
    const provider = createConfiguredProvider(loadConfig(configPath));
    const agent = new ReviewAgent(provider, 'security');
    const result = await agent.review({ context });
    const matched = result.findings.some((finding) =>
      /eval/i.test(`${finding.title} ${finding.description}`),
    );
    expect(matched).toBe(true);
  }, 120_000);
});
