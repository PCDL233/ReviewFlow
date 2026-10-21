import type { AiReviewConfig, Finding } from '@ai-review/shared';
import { endpointFor, trimEndpoint } from './endpoint.js';
import { parseFindings } from './parse.js';
import { createAiSdkProvider } from './ai-sdk-provider.js';
import type { AiSdkProviderOptions } from './ai-sdk-provider.js';
import {
  LlmError,
  LlmUnavailableError,
  normalizeUsage,
  type HttpProviderOptions,
  type LlmAttempt,
  type ReviewDimension,
  type ReviewProvider,
  type ReviewRequest,
  type ReviewResult,
} from './types.js';

/** 可重试的错误类型：鉴权/请求格式错误重试没有意义，只会放大延迟与成本 */
const RETRYABLE_ERROR_KINDS = new Set(['rate-limit', 'timeout', 'network', 'http']);

function isEnvPlaceholder(value: string): boolean {
  return /^\$\{[A-Z0-9_]+\}$/.test(value);
}

function abortError(): DOMException {
  return new DOMException('The review was cancelled', 'AbortError');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 把底层异常归一化为带分类的 LlmError。
 * 取消与超时必须区分：取消要继续向上传播（停止流水线），超时按可重试错误处理。
 */
function toLlmError(
  error: unknown,
  external: AbortSignal | undefined,
  timedOut: boolean,
): LlmError {
  if (error instanceof LlmError) return error;
  if (external?.aborted === true) {
    return new LlmError('request aborted by caller', 'cancelled', { cause: error });
  }
  if (timedOut) {
    return new LlmError('request timed out', 'timeout', { cause: error });
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return new LlmError('request timed out', 'timeout', { cause: error });
  }
  return new LlmError(error instanceof Error ? error.message : String(error), 'network', {
    cause: error,
  });
}

function classifyHttpError(status: number, body: string): LlmError {
  const message = `LLM request failed (${status}): ${body.slice(0, 500)}`;
  if (status === 401 || status === 403) return new LlmError(message, 'auth');
  if (status === 429) return new LlmError(message, 'rate-limit');
  if (status >= 500) return new LlmError(message, 'http');
  return new LlmError(message, 'http');
}

function responseText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new LlmError('LLM response is not an object', 'bad-response');
  }
  const value = payload as {
    choices?: Array<{ message?: { content?: unknown } }>;
    content?: Array<{ type?: string; text?: unknown }>;
  };
  const openAiContent = value.choices?.[0]?.message?.content;
  if (typeof openAiContent === 'string') return openAiContent;
  if (Array.isArray(openAiContent)) {
    return openAiContent
      .map((part) =>
        typeof part === 'object' && part !== null && 'text' in part
          ? String((part as { text: unknown }).text)
          : '',
      )
      .join('');
  }
  if (Array.isArray(value.content)) {
    return value.content
      .filter((part) => part.type === 'text')
      .map((part) => String(part.text ?? ''))
      .join('');
  }
  throw new LlmError('LLM response did not contain text content', 'bad-response');
}

/**
 * 发送一次模型请求（含超时与可重试错误的重试）。
 * @throws {LlmError} 分类后的调用错误；调用方取消时 kind='cancelled'
 */
async function requestJson(
  options: HttpProviderOptions,
  request: ReviewRequest,
  signal?: AbortSignal,
): Promise<unknown> {
  const endpoint = trimEndpoint(endpointFor(options.provider, options.baseUrl));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  let url = `${endpoint}/chat/completions`;
  let body: Record<string, unknown> = {
    model: options.model,
    temperature: request.temperature ?? options.temperature,
    max_tokens: request.maxOutputTokens ?? options.maxTokens,
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: request.prompt },
    ],
  };
  if (options.provider === 'anthropic') {
    url = `${endpoint}/messages`;
    headers['x-api-key'] = options.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = {
      model: options.model,
      max_tokens: request.maxOutputTokens ?? options.maxTokens,
      temperature: request.temperature ?? options.temperature,
      system: request.system,
      messages: [{ role: 'user', content: request.prompt }],
    };
  } else {
    headers.authorization = `Bearer ${options.apiKey}`;
  }

  let lastError: LlmError | undefined;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    if (signal?.aborted === true) throw abortError();
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const combined =
      signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: combined,
      });
      const responseBody = await response.text();
      if (!response.ok) throw classifyHttpError(response.status, responseBody);
      try {
        return JSON.parse(responseBody) as unknown;
      } catch (error) {
        throw new LlmError(`${options.provider} returned invalid JSON`, 'bad-response', {
          cause: error,
        });
      }
    } catch (error) {
      const normalized = toLlmError(error, signal, timeoutSignal.aborted);
      lastError = normalized;
      if (normalized.kind === 'cancelled') throw abortError();
      if (!RETRYABLE_ERROR_KINDS.has(normalized.kind) || attempt === options.retries) {
        throw normalized;
      }
      // 指数退避：250ms、500ms、1s…；取消信号在下一轮循环开头检查
      await delay(250 * 2 ** attempt);
    }
  }
  throw lastError ?? new LlmError('LLM request failed', 'network');
}

/**
 * 创建无网络、确定性的 Mock Provider。
 * @returns 根据变更内容生成审查结果的 Provider（status=mock，usage 为 0）
 */
export function createMockProvider(): ReviewProvider {
  return {
    async review(request: ReviewRequest, signal?: AbortSignal): Promise<ReviewResult> {
      if (signal?.aborted === true) throw abortError();
      const startedAt = Date.now();
      const findings = request.context.files.flatMap((file) => {
        const suspiciousLine = file.diff.changedLines.find((line) =>
          /eval\(|exec\(|child_process/.test(line.content),
        );
        if (suspiciousLine?.newLineNo === null || suspiciousLine === undefined) {
          return [];
        }

        return [
          {
            agent: 'security',
            severity: 'WARNING',
            confidence: 0.8,
            filePath: file.diff.path,
            lineStart: suspiciousLine.newLineNo,
            lineEnd: suspiciousLine.newLineNo,
            title: 'Potential unsafe command or code execution',
            description:
              'The changed code invokes a dynamic execution primitive and requires a trusted-input review.',
            suggestion:
              'Prefer a constrained API and validate all external input before execution.',
            codeSnippet: suspiciousLine.content,
            lowConfidence: false,
            isFalsePositive: false,
            origin: 'llm',
          } satisfies Finding,
        ];
      });
      return {
        findings,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, estimated: false },
        model: 'mock',
        provider: 'mock',
        latencyMs: Date.now() - startedAt,
        fallbackUsed: false,
        status: 'mock',
        attempts: [
          { kind: 'mock', provider: 'mock', model: 'mock', status: 'succeeded', latencyMs: 0 },
        ],
      };
    },
  };
}

/** 创建一个直接调用 OpenAI/Anthropic/国内厂商/Ollama HTTP API 的 Provider。 */
export function createHttpProvider(options: HttpProviderOptions): ReviewProvider {
  return {
    async review(request, signal): Promise<ReviewResult> {
      if (signal?.aborted === true) throw abortError();
      const startedAt = Date.now();
      const payload = await requestJson(options, request, signal);
      const text = responseText(payload);
      const findings = parseFindings(text, request.dimension);
      const usage = normalizeUsage(
        payload,
        request.system.length + request.prompt.length,
        text.length,
      );
      const latencyMs = Date.now() - startedAt;
      return {
        findings,
        usage,
        model: options.model,
        provider: options.provider,
        latencyMs,
        fallbackUsed: false,
        status: 'ok',
        attempts: [
          {
            kind: 'primary',
            provider: options.provider,
            model: options.model,
            status: 'succeeded',
            latencyMs,
          },
        ],
      };
    },
  };
}

type Candidate = {
  kind: 'primary' | 'fallback';
  provider: ReviewProvider;
  providerName: string;
  model: string;
};

function attemptFrom(candidate: Candidate, result: ReviewResult): LlmAttempt {
  return {
    kind: candidate.kind,
    provider: candidate.providerName,
    model: candidate.model,
    status: 'succeeded',
    latencyMs: result.latencyMs,
  };
}

function failedAttempt(candidate: Candidate, latencyMs: number, error: unknown): LlmAttempt {
  const normalized =
    error instanceof LlmError
      ? error
      : new LlmError(error instanceof Error ? error.message : String(error), 'network');
  return {
    kind: candidate.kind,
    provider: candidate.providerName,
    model: candidate.model,
    status: 'failed',
    latencyMs,
    errorKind: normalized.kind,
    message: normalized.message.slice(0, 300),
  };
}

/**
 * 根据 .ai-review.yml 装配真实 Provider，并在服务不可用时按配置退回本地 Ollama / mock。
 * 与旧实现的区别：每一次尝试都会被记录，`status` 明确区分正常、降级与不可用；
 * `llm.onUnavailable='fail'` 时直接抛错，不再静默产出 mock 结果。
 */
export function createConfiguredProvider(config: AiReviewConfig): ReviewProvider {
  const llm = config.llm;
  const mock = createMockProvider();
  if (llm.provider === 'mock') return mock;
  // 运行时切换：ai-sdk 由 SDK 负责重试/usage/错误分类；http 保留手写传输作兼容回退
  const makeProvider = (options: AiSdkProviderOptions): ReviewProvider =>
    llm.runtime === 'ai-sdk' ? createAiSdkProvider(options) : createHttpProvider(options);

  const primary: Candidate | undefined =
    llm.provider !== 'ollama' && isEnvPlaceholder(llm.apiKey)
      ? undefined
      : {
          kind: 'primary',
          providerName: llm.provider,
          model: llm.model,
          provider: makeProvider({
            provider: llm.provider,
            model: llm.model,
            apiKey: llm.provider === 'ollama' ? 'ollama' : llm.apiKey,
            ...(llm.baseUrl !== undefined && llm.baseUrl !== '' ? { baseUrl: llm.baseUrl } : {}),
            temperature: llm.temperature,
            maxTokens: llm.maxTokensPerReview,
            timeoutMs: llm.timeoutMs,
            retries: llm.retries,
            toolTimeoutMs: config.review.toolTimeoutMs,
            structuredOutput: llm.structuredOutput,
          }),
        };
  const fallback: Candidate | undefined =
    llm.provider === 'ollama'
      ? undefined
      : {
          kind: 'fallback',
          providerName: 'ollama',
          model: process.env.AI_REVIEW_OLLAMA_MODEL ?? config.server.ollamaModel,
          provider: makeProvider({
            provider: 'ollama',
            model: process.env.AI_REVIEW_OLLAMA_MODEL ?? config.server.ollamaModel,
            apiKey: 'ollama',
            ...(process.env.AI_REVIEW_OLLAMA_BASE_URL !== undefined &&
            process.env.AI_REVIEW_OLLAMA_BASE_URL !== ''
              ? { baseUrl: process.env.AI_REVIEW_OLLAMA_BASE_URL }
              : {}),
            temperature: llm.temperature,
            maxTokens: llm.maxTokensPerReview,
            timeoutMs: llm.timeoutMs,
            retries: llm.retries,
            toolTimeoutMs: config.review.toolTimeoutMs,
            structuredOutput: llm.structuredOutput,
          }),
        };

  return {
    async review(request, signal): Promise<ReviewResult> {
      const attempts: LlmAttempt[] = [];
      let lastError: unknown;
      const candidates: Candidate[] = [primary, fallback].filter(
        (candidate): candidate is Candidate => candidate !== undefined,
      );
      for (const candidate of candidates) {
        const startedAt = Date.now();
        try {
          const result = await candidate.provider.review(request, signal);
          attempts.push(attemptFrom(candidate, result));
          // 是否降级由候选角色决定，而不是数组下标：主模型可能因占位密钥被跳过
          const usedFallback = candidate.kind === 'fallback';
          return {
            ...result,
            fallbackUsed: usedFallback,
            status: usedFallback ? 'degraded' : 'ok',
            attempts,
          };
        } catch (error) {
          if (signal?.aborted === true) throw abortError();
          lastError = error;
          attempts.push(failedAttempt(candidate, Date.now() - startedAt, error));
        }
      }

      if (llm.onUnavailable === 'fail') {
        throw new LlmUnavailableError('all configured LLM providers are unavailable', attempts, {
          cause: lastError,
        });
      }

      // degrade：保留静态分析结论，但状态必须是 unavailable，报告不得宣称模型正常。
      const mockResult = await mock.review(request, signal);
      return {
        ...mockResult,
        status: 'unavailable',
        fallbackUsed: true,
        attempts: [
          ...attempts,
          {
            kind: 'mock',
            provider: 'mock',
            model: 'mock',
            status: 'succeeded',
            latencyMs: mockResult.latencyMs,
          },
        ],
      };
    },
  };
}

/** 为三个审查维度装配同一份配置（维度差异由 agents 的评审标准承担）。 */
export function createConfiguredProviders(
  config: AiReviewConfig,
): Record<ReviewDimension, ReviewProvider> {
  return {
    correctness: createConfiguredProvider(config),
    security: createConfiguredProvider(config),
    performance: createConfiguredProvider(config),
  };
}
