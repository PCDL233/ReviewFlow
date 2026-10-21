import { AiReviewConfigSchema } from '@ai-review/shared';
import type { AiReviewConfig, CodeContext } from '@ai-review/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredProvider, createMockProvider } from '../src/index.js';
import type { ReviewDimension, ReviewRequest } from '../src/index.js';

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
    generatedAt: new Date().toISOString(),
  },
} satisfies CodeContext;

/** 传输层只关心 system/prompt/context；维度由调用方传入 */
function makeRequest(dimension: ReviewDimension = 'security'): ReviewRequest {
  return {
    dimension,
    system: '你是代码审查专家。',
    prompt: '请审查下面的变更。',
    context,
  };
}

/** 构造完整的 OpenAI chat/completions 响应：AI SDK transport 会做严格 schema 校验 */
function openAiBody(
  content: string,
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number },
): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    ...(usage === undefined
      ? {}
      : {
          usage: {
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
            total_tokens: usage.totalTokens,
          },
        }),
  });
}

describe('createMockProvider', () => {
  it('reports dynamic execution primitives and marks itself as mock', async () => {
    const result = await createMockProvider().review(makeRequest());
    expect(result.findings[0]).toMatchObject({ agent: 'security', filePath: 'src/run.ts', lineStart: 3 });
    expect(result.status).toBe('mock');
  });

  it('honors an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createMockProvider().review(makeRequest(), controller.signal)).rejects.toThrow(
      'cancelled',
    );
  });
});

describe('createConfiguredProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_REVIEW_OLLAMA_BASE_URL;
  });

  it('tries local Ollama before mock when the cloud key is still a placeholder', async () => {
    process.env.AI_REVIEW_OLLAMA_BASE_URL = 'http://ollama.test/v1';
    const fetchMock = vi.fn(
      async () =>
        new Response(openAiBody('[]'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const config = AiReviewConfigSchema.parse({
      llm: { provider: 'anthropic', apiKey: '${AI_REVIEW_API_KEY}' },
    });
    const result = await createConfiguredProvider(config).review(makeRequest());

    expect(result.findings).toEqual([]);
    // 主模型因占位密钥被跳过，实际走 Ollama 备用模型 → 明确标记为 degraded
    expect(result.status).toBe('degraded');
    expect(result.attempts).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://ollama.test/v1/chat/completions');
  });

  it('parses provider usage instead of leaving token accounting at zero', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(openAiBody('[]', { promptTokens: 120, completionTokens: 30, totalTokens: 150 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const config = AiReviewConfigSchema.parse({ llm: { provider: 'deepseek', apiKey: 'sk-test' } });
    const result = await createConfiguredProvider(config).review(makeRequest());
    expect(result.usage).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      totalTokens: 150,
      estimated: false,
    });
    expect(result.status).toBe('ok');
  });
});

describe('domestic provider endpoint resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_REVIEW_DEEPSEEK_BASE_URL;
  });

  const cases: ReadonlyArray<{
    provider: AiReviewConfig['llm']['provider'];
    endpoint: string;
  }> = [
    { provider: 'deepseek', endpoint: 'https://api.deepseek.com/v1' },
    { provider: 'zhipu', endpoint: 'https://open.bigmodel.cn/api/paas/v4' },
    { provider: 'moonshot', endpoint: 'https://api.moonshot.cn/v1' },
    { provider: 'dashscope', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
    { provider: 'volcengine', endpoint: 'https://ark.cn-beijing.volces.com/api/v3' },
    { provider: 'minimax', endpoint: 'https://api.minimax.chat/v1' },
  ];

  for (const { provider, endpoint } of cases) {
    it(`uses the catalog default endpoint for ${provider}`, async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(openAiBody('[]'), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      );
      vi.stubGlobal('fetch', fetchMock);

      const config = AiReviewConfigSchema.parse({ llm: { provider, apiKey: 'sk-test' } });
      const result = await createConfiguredProvider(config).review(makeRequest());

      expect(result.findings).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(`${endpoint}/chat/completions`);
    });
  }

  it('honors the generalized AI_REVIEW_<PROVIDER>_BASE_URL override', async () => {
    process.env.AI_REVIEW_DEEPSEEK_BASE_URL = 'http://deepseek.test/v1';
    const fetchMock = vi.fn(
      async () =>
        new Response(openAiBody('[]'), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const config = AiReviewConfigSchema.parse({ llm: { provider: 'deepseek', apiKey: 'sk-test' } });
    await createConfiguredProvider(config).review(makeRequest());

    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://deepseek.test/v1/chat/completions');
  });
});

describe('degradation visibility', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_REVIEW_OLLAMA_BASE_URL;
  });

  it('marks the review unavailable when every provider fails (degrade mode)', async () => {
    process.env.AI_REVIEW_OLLAMA_BASE_URL = 'http://ollama.test/v1';
    const fetchMock = vi.fn(
      async () => new Response('upstream down', { status: 503 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const config = AiReviewConfigSchema.parse({
      llm: { provider: 'anthropic', apiKey: 'sk-live', retries: 0 },
    });
    const result = await createConfiguredProvider(config).review(makeRequest());

    expect(result.status).toBe('unavailable');
    expect(result.provider).toBe('mock');
    expect(result.attempts.map((attempt) => attempt.status)).toEqual(['failed', 'failed', 'succeeded']);
    expect(result.findings).toHaveLength(1);
  });

  it('fails fast when onUnavailable=fail instead of silently returning mock results', async () => {
    process.env.AI_REVIEW_OLLAMA_BASE_URL = 'http://ollama.test/v1';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream down', { status: 503 })),
    );

    const config = AiReviewConfigSchema.parse({
      llm: {
        provider: 'anthropic',
        apiKey: 'sk-live',
        retries: 0,
        onUnavailable: 'fail',
      },
    });
    await expect(
      createConfiguredProvider(config).review(makeRequest()),
    ).rejects.toThrow('all configured LLM providers are unavailable');
  });
});
