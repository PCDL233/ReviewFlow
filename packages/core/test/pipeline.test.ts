import { GitReader } from '@ai-review/diff';
import { createMockProvider, TokenBudget } from '@ai-review/llm';
import type { ReviewProvider, ReviewRequest, ReviewResult } from '@ai-review/llm';
import { FindingSchema } from '@ai-review/shared';
import type { Finding, GitRunner, ReviewToolDescriptor } from '@ai-review/shared';
import { buildDefaultRegistry } from '@ai-review/tools';
import { describe, expect, it } from 'vitest';
import { createReviewCheckpointer, runReviewPipeline } from '../src/index.js';
import type { PipelineDeps } from '../src/index.js';

const FILE_PATH = 'src/auth/login.ts';

/** 构造合法的 unified diff：前 1 行上下文 + 可选删除行 + N 行新增 + 后 1 行上下文 */
function makeStagedDiff(path: string, addedCount: number, removedLine?: string): string {
  const oldCount = 2 + (removedLine === undefined ? 0 : 1);
  const newCount = 2 + addedCount;
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldCount} +1,${newCount} @@`,
    ' const config = loadConfig();',
    ...(removedLine === undefined ? [] : [`-${removedLine}`]),
    ...Array.from({ length: addedCount }, (_, i) => `+const value${i} = ${i};`),
    ' export function login() {}',
  ].join('\n');
}

/** deep 分流（路径 30 + 规模 25 + 删除守卫 20 = 75） */
const DEEP_DIFF = makeStagedDiff(FILE_PATH, 101, '  } catch (error) {');
/** quick 分流（路径 30 + 规模 15 = 45） */
const QUICK_DIFF = makeStagedDiff(FILE_PATH, 50);

function makeFakeGit(diff: string): GitRunner {
  return async (...args: string[]) => {
    const [command, second] = args;
    if (command === 'diff' && second === '--cached') return diff;
    if (command === 'show' && second !== undefined) {
      return 'const config = loadConfig();\nexport function login() {}\n';
    }
    if (command === 'branch') return 'main\n';
    throw new Error(`unexpected git invocation: ${args.join(' ')}`);
  };
}

function makeDeps(overrides: Partial<PipelineDeps> & { diff: string }): PipelineDeps {
  const mock = createMockProvider();
  return {
    gitReader: new GitReader(makeFakeGit(overrides.diff)),
    rag: { query: async () => [] },
    ignores: { allows: () => true },
    history: { changeFrequency: async () => 0 },
    providers: { correctness: mock, security: mock, performance: mock },
    registry: buildDefaultRegistry(),
    mode: 'fast',
    ...overrides,
  };
}

/** 构造一次带真实用量的 Provider 结果 */
function reviewResult(findings: Finding[], totalTokens = 120): ReviewResult {
  return {
    findings,
    usage: {
      promptTokens: Math.max(0, totalTokens - 20),
      completionTokens: Math.min(20, totalTokens),
      totalTokens,
      estimated: false,
    },
    model: 'fake-model',
    provider: 'fake',
    latencyMs: 1,
    fallbackUsed: false,
    status: 'ok',
    attempts: [
      { kind: 'primary', provider: 'fake', model: 'fake-model', status: 'succeeded', latencyMs: 1 },
    ],
  };
}

/** 只在拿到文件时产出发现的 Provider：区分"未分到文件"与"审查无发现" */
function llmMarkerProvider(
  calls: { count: number },
  capture?: (request: ReviewRequest) => void,
): ReviewProvider {
  return {
    review: async (request: ReviewRequest): Promise<ReviewResult> => {
      calls.count += 1;
      capture?.(request);
      const findings = request.context.files.flatMap((file): Finding[] => {
        const line = file.diff.changedLines[0];
        return [
          {
            agent: 'security',
            severity: 'WARNING',
            confidence: 0.8,
            filePath: file.diff.path,
            lineStart: line?.newLineNo ?? 1,
            lineEnd: line?.newLineNo ?? 1,
            title: 'llm marker finding',
            description: 'produced only when the agent received files',
            isFalsePositive: false,
          },
        ];
      });
      return reviewResult(findings);
    },
  };
}

describe('runReviewPipeline', () => {
  it('runs static analysis end to end without triggering self-heal', async () => {
    const deps = makeDeps({
      diff: [
        `diff --git a/${FILE_PATH} b/${FILE_PATH}`,
        'index 1111111..2222222 100644',
        `--- a/${FILE_PATH}`,
        `+++ b/${FILE_PATH}`,
        '@@ -1,2 +1,4 @@',
        ' const config = loadConfig();',
        "+const accessKey = 'AKIAIOSFODNN7EXAMPLE';",
        '+const value = 1;',
        ' export function login() {}',
      ].join('\n'),
    });
    const state = await runReviewPipeline(deps, { reviewId: 'test-static-only' });

    expect(state.findings).toHaveLength(1);
    expect(state.findings[0]).toMatchObject({
      agent: 'static',
      severity: 'BLOCKER',
      filePath: FILE_PATH,
      confidence: 0.9,
    });
    expect(state.metrics.healRounds).toBe(0);
    expect(state.metrics.filesStaticOnly).toBe(1);
    expect(state.metrics.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('self-heals low-confidence blockers up to three rounds', async () => {
    const lowConfidence: ReviewProvider = {
      review: async (request: ReviewRequest): Promise<ReviewResult> =>
        reviewResult(
          request.context.files.flatMap((file): Finding[] => {
            const line = file.diff.changedLines.find((l) => l.type === 'added');
            if (line?.newLineNo === undefined || line.newLineNo === null) return [];
            return [
              {
                agent: 'security',
                severity: 'BLOCKER',
                confidence: 0.4,
                filePath: file.diff.path,
                lineStart: line.newLineNo,
                lineEnd: line.newLineNo,
                title: 'low confidence blocker',
                description: 'needs re-review',
                isFalsePositive: false,
              },
            ];
          }),
        ),
    };
    const deps = makeDeps({
      diff: DEEP_DIFF,
      providers: {
        correctness: lowConfidence,
        security: lowConfidence,
        performance: lowConfidence,
      },
    });
    const seenNodes: string[] = [];
    const state = await runReviewPipeline(deps, {
      reviewId: 'test-self-heal',
      onNodeUpdate: (node) => seenNodes.push(node),
    });

    expect(state.metrics.healRounds).toBe(3);
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0]).toMatchObject({ severity: 'BLOCKER', confidence: 0.4 });
    expect(state.metrics.healIneffective).toBe(true);
    expect(seenNodes).toContain('heal');
    expect(seenNodes.lastIndexOf('heal')).toBeLessThan(seenNodes.lastIndexOf('report'));
  });

  it('degrades files to static-only when the token budget is exhausted', async () => {
    const deps = makeDeps({ diff: DEEP_DIFF, budget: new TokenBudget(0) });
    const state = await runReviewPipeline(deps, { reviewId: 'test-budget' });

    expect(state.metrics.degradedToStatic).toEqual([FILE_PATH]);
    expect(state.plan.deep).toEqual([]);
    expect(state.plan.staticOnly.map((file) => file.diff.path)).toEqual([FILE_PATH]);
  });

  it('applies size limits before building expensive AST/RAG context', async () => {
    const first = makeStagedDiff('src/auth/a.ts', 101, '  } catch (error) {');
    const second = makeStagedDiff('src/auth/b.ts', 101, '  } catch (error) {');
    let ragQueries = 0;
    const state = await runReviewPipeline(
      makeDeps({
        diff: [first, second].join('\n'),
        maxFiles: 1,
        rag: {
          query: async () => {
            ragQueries += 1;
            return [];
          },
        },
      }),
      { reviewId: 'test-pre-limit' },
    );

    expect(state.metrics.truncatedFiles).toHaveLength(1);
    // 只有入选 LLM 审查的文件才构建完整上下文；被截断文件保留轻量上下文供静态工具使用
    expect(ragQueries).toBe(1);
    expect(state.context.files).toHaveLength(2);
  });

  it('reviews quick files only in full mode', async () => {
    const calls = { count: 0 };
    const marker = llmMarkerProvider(calls);
    const fastState = await runReviewPipeline(
      makeDeps({
        diff: QUICK_DIFF,
        providers: { correctness: marker, security: marker, performance: marker },
      }),
      {
        reviewId: 'test-fast',
      },
    );
    expect(fastState.metrics.filesQuick).toBe(1);
    expect(fastState.findings).toEqual([]);

    const fullState = await runReviewPipeline(
      makeDeps({
        diff: QUICK_DIFF,
        providers: { correctness: marker, security: marker, performance: marker },
        mode: 'full',
      }),
      { reviewId: 'test-full' },
    );

    expect(fullState.metrics.filesQuick).toBe(1);
    expect(fullState.findings).toHaveLength(1);
    expect(fullState.findings[0]).toMatchObject({ title: 'llm marker finding', confidence: 0.6 });
    expect(calls.count).toBeGreaterThan(0);
  });

  it('propagates git failures from the parse node', async () => {
    const failingGit: GitRunner = async () => {
      throw new Error('not a git repository');
    };
    const deps = makeDeps({ diff: DEEP_DIFF, gitReader: new GitReader(failingGit) });
    await expect(runReviewPipeline(deps, { reviewId: 'test-failure' })).rejects.toThrow(
      'not a git repository',
    );
  });

  it('reuses cached findings on identical content and skips the LLM (方案 3.0 内容哈希去重)', async () => {
    const cache = new Map<string, { findings: Finding[]; tokenSaved: number }>();
    const reviewCache = {
      get: async (key: string) => cache.get(key)?.findings,
      set: async (key: string, findings: Finding[], tokenSaved: number) => {
        cache.set(key, { findings, tokenSaved });
      },
    };
    const calls = { count: 0 };
    const marker = llmMarkerProvider(calls);
    const deps = makeDeps({
      diff: DEEP_DIFF,
      providers: { correctness: marker, security: marker, performance: marker },
      reviewCache,
      mode: 'full',
    });

    const firstState = await runReviewPipeline(deps, { reviewId: 'test-cache-1' });
    expect(firstState.metrics.cacheHits).toBe(0);
    const firstCalls = calls.count;
    expect(firstCalls).toBeGreaterThan(0);

    const secondState = await runReviewPipeline(deps, { reviewId: 'test-cache-2' });
    expect(secondState.metrics.cacheHits).toBeGreaterThan(0);
    expect(calls.count).toBe(firstCalls); // LLM 零调用：命中文件不再进入 Provider
    expect(secondState.findings).toHaveLength(firstState.findings.length);
    expect(secondState.findings[0]?.origin).toBe('cache');
  });

  it('records real provider usage in metrics (tokenUsed 不再恒为 0)', async () => {
    const calls = { count: 0 };
    const marker = llmMarkerProvider(calls);
    const state = await runReviewPipeline(
      makeDeps({
        diff: DEEP_DIFF,
        providers: { correctness: marker, security: marker, performance: marker },
        mode: 'full',
      }),
      { reviewId: 'test-usage' },
    );
    expect(state.metrics.totalTokens).toBe(360);
    expect(state.metrics.promptTokens).toBe(300);
    expect(state.metrics.completionTokens).toBe(60);
    expect(state.metrics.llmStatus).toBe('ok');
    // 每个维度一条调用记录：provider/model/usage/attempts 可追溯
    expect(state.metrics.llmCalls).toHaveLength(3);
    expect(state.metrics.llmCalls?.every((call) => call.round === 0)).toBe(true);
    expect(state.metrics.llmCalls?.[0]).toMatchObject({
      provider: 'fake',
      model: 'fake-model',
      totalTokens: 120,
      status: 'ok',
      fallbackUsed: false,
    });
    expect(state.metrics.llmCalls?.[0]?.attempts[0]).toMatchObject({
      kind: 'primary',
      status: 'succeeded',
    });
  });

  it('merges the same defect reported by multiple dimensions instead of counting it three times', async () => {
    const calls = { count: 0 };
    const marker = llmMarkerProvider(calls);
    const state = await runReviewPipeline(
      makeDeps({
        diff: DEEP_DIFF,
        providers: { correctness: marker, security: marker, performance: marker },
        mode: 'full',
      }),
      { reviewId: 'test-dedupe' },
    );
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0]?.agents?.sort()).toEqual(['correctness', 'performance', 'security']);
    expect(calls.count).toBe(3);
  });

  it('passes read-only tools and the ReAct step budget to the agent request', async () => {
    const requests: ReviewRequest[] = [];
    const marker = llmMarkerProvider({ count: 0 }, (request) => requests.push(request));
    const readFile: ReviewToolDescriptor = {
      name: 'read_file',
      description: 'read a file',
      inputSchema: FindingSchema,
      execute: async () => 'content',
    };
    await runReviewPipeline(
      makeDeps({
        diff: DEEP_DIFF,
        tools: [readFile],
        providers: { correctness: marker, security: marker, performance: marker },
        mode: 'full',
      }),
      { reviewId: 'test-tools' },
    );
    expect(requests[0]?.tools).toHaveLength(1);
    expect(requests[0]?.maxSteps).toBe(6);
  });

  it('resumes from the last checkpoint after a retryable failure', async () => {
    let attempts = 0;
    const flaky: ReviewProvider = {
      async review() {
        attempts += 1;
        if (attempts === 1) throw new Error('fetch failed');
        return reviewResult([], 10);
      },
    };
    const deps = makeDeps({
      diff: DEEP_DIFF,
      providers: { correctness: flaky, security: flaky, performance: flaky },
      checkpointer: createReviewCheckpointer(),
    });
    await expect(runReviewPipeline(deps, { reviewId: 'resume-test' })).rejects.toThrow(
      'fetch failed',
    );
    const state = await runReviewPipeline(deps, { reviewId: 'resume-test' });
    expect(state.metrics.totalTokens).toBeGreaterThan(0);
  });

  it('injects static evidence into the LLM payload', async () => {
    const prompts: string[] = [];
    const marker = llmMarkerProvider({ count: 0 }, (request) => prompts.push(request.prompt));
    const diff = makeStagedDiff(FILE_PATH, 101, '  } catch (error) {').replace(
      '+const value0 = 0;',
      "+const accessKey = 'AKIAIOSFODNN7EXAMPLE';",
    );
    await runReviewPipeline(
      makeDeps({
        diff,
        providers: { correctness: marker, security: marker, performance: marker },
        mode: 'full',
      }),
      { reviewId: 'test-evidence' },
    );
    expect(prompts.some((prompt) => prompt.includes('Possible AWS access key id'))).toBe(true);
  });

  it('re-reviews with prior findings and a stricter prompt during heal', async () => {
    const requests: ReviewRequest[] = [];
    const lowConfidence: ReviewProvider = {
      review: async (request: ReviewRequest): Promise<ReviewResult> => {
        requests.push(request);
        return reviewResult(
          request.context.files.flatMap((file): Finding[] => {
            const line = file.diff.changedLines.find((l) => l.type === 'added');
            if (line?.newLineNo === undefined || line.newLineNo === null) return [];
            return [
              {
                agent: 'security',
                severity: 'BLOCKER',
                confidence: 0.4,
                filePath: file.diff.path,
                lineStart: line.newLineNo,
                lineEnd: line.newLineNo,
                title: 'low confidence blocker',
                description: 'needs re-review',
                isFalsePositive: false,
              },
            ];
          }),
        );
      },
    };
    await runReviewPipeline(
      makeDeps({
        diff: DEEP_DIFF,
        providers: {
          correctness: lowConfidence,
          security: lowConfidence,
          performance: lowConfidence,
        },
      }),
      { reviewId: 'test-heal-prompt' },
    );
    const healRequest = requests.find((request) => request.system.includes('复核轮次'));
    expect(healRequest).toBeDefined();
    expect(healRequest?.prompt).toContain('low confidence blocker');
    expect(healRequest?.prompt).toContain('priorFindings');
  });
});
