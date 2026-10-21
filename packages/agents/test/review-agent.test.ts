import type { CodeContext, Finding } from '@ai-review/shared';
import { describe, expect, it } from 'vitest';
import type { ReviewProvider, ReviewRequest } from '@ai-review/llm';
import { DIMENSION_PROFILES, ReviewAgent, REVIEW_PROMPT_VERSION } from '../src/index.js';

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
      stagedContent: ['const a = 1;', 'const b = 2;', 'eval(input);'].join('\n'),
      snippet: ['const a = 1;', 'const b = 2;', 'eval(input);'].join('\n'),
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
} satisfies CodeContext;

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    agent: 'security',
    severity: 'WARNING',
    confidence: 0.8,
    filePath: 'src/run.ts',
    lineStart: 3,
    lineEnd: 3,
    title: 'Unsafe execution',
    description: 'Review input.',
    isFalsePositive: false,
    ...overrides,
  };
}

function fakeProvider(
  findings: Finding[],
  capture?: (request: ReviewRequest) => void,
): ReviewProvider {
  return {
    review: async (request) => {
      capture?.(request);
      return {
        findings,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15, estimated: false },
        model: 'fake-model',
        provider: 'fake',
        latencyMs: 1,
        fallbackUsed: false,
        status: 'ok',
        attempts: [],
      };
    },
  };
}

describe('ReviewAgent', () => {
  it('keeps findings that point to changed lines and forces the dimension as agent', async () => {
    const agent = new ReviewAgent(fakeProvider([makeFinding()]), 'security');
    const result = await agent.review({ context });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      agent: 'security',
      lineScope: 'changed',
      origin: 'llm',
    });
    expect(result.findings[0]?.fingerprint).toHaveLength(32);
    expect(result.usage.totalTokens).toBe(15);
  });

  it('rejects findings outside the file instead of silently inventing a location', async () => {
    const agent = new ReviewAgent(
      fakeProvider([makeFinding({ lineStart: 9, lineEnd: 9, title: 'Unchanged line' })]),
      'security',
    );
    const result = await agent.review({ context });
    expect(result.findings).toEqual([]);
    expect(result.rejected).toBe(1);
    expect(result.rejectionReasons).toMatchObject({ 'out-of-range': 1 });
  });

  it('keeps context-line findings as lineScope=context and downgrades BLOCKER', async () => {
    const multiLineContext: CodeContext = {
      ...context,
      files: [
        {
          ...context.files[0],
          diff: {
            ...context.files[0].diff,
            changedLines: [
              { type: 'added', oldLineNo: null, newLineNo: 3, content: 'const value = 1;' },
            ],
          },
          stagedContent: ['line one', 'line two', 'const value = 1;'].join('\n'),
        },
      ],
    };
    const agent = new ReviewAgent(
      fakeProvider([
        makeFinding({ severity: 'BLOCKER', lineStart: 2, lineEnd: 2, title: 'Context issue' }),
      ]),
      'correctness',
    );
    const result = await agent.review({ context: multiLineContext });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      agent: 'correctness',
      severity: 'WARNING',
      lineScope: 'context',
      lowConfidence: true,
    });
    expect(result.contextFindings).toBe(1);
  });

  it('injects static evidence, prior findings and conventions into the prompt', async () => {
    let captured: ReviewRequest | undefined;
    const agent = new ReviewAgent(
      fakeProvider([], (request) => {
        captured = request;
      }),
      'security',
    );
    await agent.review({
      context,
      evidence: [makeFinding({ agent: 'static', title: 'static evidence marker' })],
      priorFindings: [makeFinding({ title: 'prior finding marker' })],
      conventions: 'convention marker',
      strict: true,
    });
    expect(captured?.prompt).toContain('static evidence marker');
    expect(captured?.prompt).toContain('prior finding marker');
    expect(captured?.prompt).toContain('convention marker');
    expect(captured?.system).toContain('复核轮次');
  });
});

describe('dimension profiles', () => {
  it('uses genuinely different review rubrics per dimension', () => {
    const prompts = Object.values(DIMENSION_PROFILES).map((profile) => profile.systemPrompt);
    expect(new Set(prompts).size).toBe(prompts.length);
    expect(DIMENSION_PROFILES.correctness.systemPrompt).toContain('边界条件');
    expect(DIMENSION_PROFILES.security.systemPrompt).toContain('注入');
    expect(DIMENSION_PROFILES.performance.systemPrompt).toContain('N+1');
    expect(REVIEW_PROMPT_VERSION).toBe('v2');
  });
});
