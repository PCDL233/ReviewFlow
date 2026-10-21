import { MockLanguageModelV2 } from 'ai/test';
import type { CodeContext, ReviewToolDescriptor } from '@ai-review/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createAiSdkProvider } from '../src/index.js';
import type { ReviewRequest } from '../src/index.js';

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
    generatedAt: '2026-01-01T00:00:00.000Z',
  },
} satisfies CodeContext;

const request: ReviewRequest = {
  dimension: 'security',
  system: '你是代码审查专家。',
  prompt: '请审查下面的变更。',
  context,
};

function modelWith(text: string): MockLanguageModelV2 {
  return new MockLanguageModelV2({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      warnings: [],
    }),
  });
}

function makeProvider(
  model: MockLanguageModelV2,
  toolTimeoutMs?: number,
  structuredOutput = false,
): ReturnType<typeof createAiSdkProvider> {
  return createAiSdkProvider({
    provider: 'deepseek',
    model: 'deepseek-chat',
    apiKey: 'sk-test',
    temperature: 0.1,
    maxTokens: 100,
    timeoutMs: 1_000,
    retries: 0,
    ...(toolTimeoutMs === undefined ? {} : { toolTimeoutMs }),
    ...(structuredOutput ? { structuredOutput: true } : {}),
    languageModel: model,
  });
}

describe('AI SDK transport', () => {
  it('uses native usage and forces the dimension as agent', async () => {
    const findings = [
      {
        severity: 'WARNING',
        confidence: 0.8,
        filePath: 'src/run.ts',
        lineStart: 3,
        lineEnd: 3,
        title: 'Unsafe execution',
        description: 'Review input.',
      },
    ];
    const result = await makeProvider(modelWith(JSON.stringify(findings))).review(request);

    expect(result.findings[0]).toMatchObject({ agent: 'security', origin: 'llm' });
    expect(result.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      estimated: false,
    });
    expect(result.status).toBe('ok');
    expect(result.attempts[0]).toMatchObject({ kind: 'primary', status: 'succeeded' });
  });

  it('surfaces malformed model output as a bad-response error', async () => {
    await expect(makeProvider(modelWith('not a json array')).review(request)).rejects.toThrow(
      'JSON findings array',
    );
  });

  it('runs a ReAct tool loop and sums usage across steps', async () => {
    let step = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'read_file',
                input: '{"path":"src/run.ts"}',
              },
            ],
            finishReason: 'tool-calls',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            warnings: [],
          };
        }
        return {
          content: [{ type: 'text', text: '[]' }],
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          warnings: [],
        };
      },
    });
    let toolCalls = 0;
    const readFile: ReviewToolDescriptor = {
      name: 'read_file',
      description: 'read a file',
      inputSchema: z.object({ path: z.string() }),
      execute: async (input) => {
        toolCalls += 1;
        return `content for ${JSON.stringify(input)}`;
      },
    };

    const result = await makeProvider(model).review({
      ...request,
      tools: [readFile],
      maxSteps: 3,
    });

    expect(toolCalls).toBe(1);
    expect(step).toBe(2);
    expect(result.findings).toEqual([]);
    expect(result.usage).toEqual({
      promptTokens: 20,
      completionTokens: 10,
      totalTokens: 30,
      estimated: false,
    });
  });

  it('uses structured object output when enabled', async () => {
    const model = new MockLanguageModelV2({
      doGenerate: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              findings: [
                {
                  severity: 'WARNING',
                  confidence: 0.7,
                  filePath: 'src/run.ts',
                  lineStart: 3,
                  lineEnd: 3,
                  title: 'Unsafe eval',
                  description: 'eval on untrusted input',
                },
              ],
            }),
          },
        ],
        finishReason: 'stop',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        warnings: [],
      }),
    });
    const result = await makeProvider(model, undefined, true).review(request);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      agent: 'security',
      origin: 'llm',
      title: 'Unsafe eval',
      isFalsePositive: false,
    });
    expect(result.usage.totalTokens).toBe(15);
  });

  it('bounds a hanging tool with the configured timeout', async () => {
    let step = 0;
    const model = new MockLanguageModelV2({
      doGenerate: async () => {
        step += 1;
        if (step === 1) {
          return {
            content: [
              {
                type: 'tool-call',
                toolCallId: 'call-slow',
                toolName: 'read_file',
                input: '{"path":"src/run.ts"}',
              },
            ],
            finishReason: 'tool-calls',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            warnings: [],
          };
        }
        return {
          content: [{ type: 'text', text: '[]' }],
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          warnings: [],
        };
      },
    });
    const hanging: ReviewToolDescriptor = {
      name: 'read_file',
      description: 'never resolves',
      inputSchema: z.object({ path: z.string() }),
      execute: () => new Promise<string>(() => {}),
    };
    const startedAt = Date.now();
    const result = await makeProvider(model, 20).review({
      ...request,
      tools: [hanging],
      maxSteps: 2,
    });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(result.findings).toEqual([]);
  });
});
