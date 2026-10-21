#!/usr/bin/env node
/**
 * 录制一次真实模型输出为 fixture（默认 Ollama 本地模型）。
 * 用法：
 *   node scripts/record-llm-fixture.mjs
 *   OLLAMA_MODEL=deepseek-r1:1.5b node scripts/record-llm-fixture.mjs
 * 需要先构建 workspace（pnpm build）并启动 Ollama。
 */
import { writeFileSync } from 'node:fs';
import { AiReviewConfigSchema } from '../packages/shared/dist/index.js';
import { createConfiguredProvider } from '../packages/llm/dist/index.js';
import { ReviewAgent } from '../packages/agents/dist/index.js';

const model = process.env.OLLAMA_MODEL ?? 'qwen3.5:0.8b';
const baseUrl = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1';
const config = AiReviewConfigSchema.parse({
  llm: {
    provider: 'ollama',
    model,
    runtime: 'ai-sdk',
    apiKey: 'ollama',
    baseUrl,
    maxTokensPerReview: 2_000,
    timeoutMs: 180_000,
    retries: 0,
  },
  review: { dimensions: ['security'] },
});

const content = 'eval(userInput);';
const context = {
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
        changedLines: [{ type: 'added', oldLineNo: null, newLineNo: 1, content }],
        summary: content,
      },
      stagedContent: content,
      snippet: content,
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

const agent = new ReviewAgent(createConfiguredProvider(config), 'security');
const result = await agent.review({ context });
if (result.findings.length === 0) {
  console.error('model produced no findings; fixture not written');
  process.exit(1);
}
const fixture = {
  id: 'security-eval',
  source: `ollama:${model}`,
  dimension: 'security',
  expectedTitles: result.findings.map((finding) => finding.title),
  findings: result.findings,
};
const target = new URL('../packages/core/test/fixtures/llm/security-eval.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
console.log(`wrote ${result.findings.length} finding(s) to ${target.pathname}`);
