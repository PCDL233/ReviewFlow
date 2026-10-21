import { APICallError, generateObject, generateText, stepCountIs, tool } from 'ai';
import type { LanguageModel, ToolSet } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { FindingsOutputSchema } from '@ai-review/shared';
import type {
  Finding,
  FindingsOutput,
  ReviewToolDescriptor,
} from '@ai-review/shared';
import { endpointFor } from './endpoint.js';
import { parseFindings } from './parse.js';
import {
  LlmError,
  type HttpProviderOptions,
  type ReviewDimension,
  type ReviewProvider,
  type ReviewResult,
} from './types.js';

/**
 * AI SDK transport（方案 3.3/3.4 的运行时对齐）。
 * 与手写 HTTP 的差异：请求/重试/usage/错误分类由 AI SDK 承担，
 * 后续接入 tool calling 与 structured output 时不需要再改业务层。
 */
export type AiSdkProviderOptions = HttpProviderOptions & {
  /** 测试注入模型；生产按 provider 构造 */
  languageModel?: LanguageModel;
  /** 工具执行超时（毫秒）；缺省不限制 */
  toolTimeoutMs?: number;
  /** 结构化输出（需模型支持 JSON schema；有工具时自动回退文本模式） */
  structuredOutput?: boolean;
};

function buildModel(options: AiSdkProviderOptions): LanguageModel {
  if (options.languageModel !== undefined) return options.languageModel;
  const baseURL = endpointFor(options.provider, options.baseUrl);
  if (options.provider === 'anthropic') {
    return createAnthropic({ apiKey: options.apiKey, baseURL })(options.model);
  }
  // .chat() 强制使用 chat/completions（OpenAI 兼容端点，含 Ollama/国内厂商）
  return createOpenAI({ apiKey: options.apiKey, baseURL }).chat(options.model);
}

function abortError(): DOMException {
  return new DOMException('The review was cancelled', 'AbortError');
}

/** 把平台无关的工具描述适配为 AI SDK ToolSet（execute 已由组合根绑定仓库访问） */
function toToolSet(
  tools?: readonly ReviewToolDescriptor[],
  timeoutMs?: number,
): ToolSet | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  const set: ToolSet = {};
  for (const descriptor of tools) {
    set[descriptor.name] = tool({
      description: descriptor.description,
      inputSchema: descriptor.inputSchema,
      execute: async (input: unknown) => {
        const work = descriptor.execute(input);
        if (timeoutMs === undefined) return work;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            work,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(
                () => reject(new Error(`tool ${descriptor.name} timed out after ${timeoutMs}ms`)),
                timeoutMs,
              );
            }),
          ]);
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      },
    });
  }
  return set;
}

/**
 * 把 AI SDK 的异常归类为 LlmError。
 * 鉴权/请求格式错误不重试；429/5xx/网络错误由 AI SDK 的 maxRetries 处理。
 */
function classifyError(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    const kind =
      status === 401 || status === 403
        ? 'auth'
        : status === 429
          ? 'rate-limit'
          : status !== undefined && status >= 500
            ? 'http'
            : 'network';
    return new LlmError(error.message, kind, { cause: error });
  }
  if (error instanceof DOMException) {
    if (error.name === 'TimeoutError') {
      return new LlmError('request timed out', 'timeout', { cause: error });
    }
    if (error.name === 'AbortError') {
      return new LlmError('request aborted', 'cancelled', { cause: error });
    }
  }
  return new LlmError(error instanceof Error ? error.message : String(error), 'network', {
    cause: error,
  });
}

/** 结构化输出 → Finding：agent/origin/误报等平台字段由维度注入，不接受模型自报 */
function toStructuredFindings(output: FindingsOutput, dimension: ReviewDimension): Finding[] {
  return output.findings.map((finding) => ({
    agent: dimension,
    origin: 'llm',
    severity: finding.severity,
    confidence: finding.confidence,
    filePath: finding.filePath,
    lineStart: finding.lineStart,
    lineEnd: finding.lineEnd,
    title: finding.title,
    description: finding.description,
    ...(finding.suggestion === undefined ? {} : { suggestion: finding.suggestion }),
    ...(finding.cweId === undefined ? {} : { cweId: finding.cweId }),
    ...(finding.lowConfidence === undefined ? {} : { lowConfidence: finding.lowConfidence }),
    isFalsePositive: false,
  }));
}

/** 创建基于 AI SDK 的 Provider（usage 原生解析，重试由 SDK 承担）。 */
export function createAiSdkProvider(options: AiSdkProviderOptions): ReviewProvider {
  const model = buildModel(options);
  return {
    async review(request, signal): Promise<ReviewResult> {
      if (signal?.aborted === true) throw abortError();
      const startedAt = Date.now();
      const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
      const abortSignal =
        signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]);
      try {
        // 结构化输出与 ReAct 工具互斥：有工具时保留文本模式（模型需要多步推理）
        const useStructured =
          options.structuredOutput === true &&
          (request.tools === undefined || request.tools.length === 0);
        if (useStructured) {
          const structured = await generateObject({
            model,
            system: request.system,
            prompt: request.prompt,
            schema: FindingsOutputSchema,
            temperature: request.temperature ?? options.temperature,
            maxOutputTokens: request.maxOutputTokens ?? options.maxTokens,
            maxRetries: options.retries,
            abortSignal,
          });
          const findings = toStructuredFindings(structured.object, request.dimension);
          const usage = structured.usage;
          const inputTokens = usage.inputTokens;
          const outputTokens = usage.outputTokens;
          const promptTokens =
            inputTokens ?? Math.ceil((request.system.length + request.prompt.length) / 4);
          const completionTokens = outputTokens ?? Math.ceil(JSON.stringify(findings).length / 4);
          const totalTokens = usage.totalTokens ?? promptTokens + completionTokens;
          const latencyMs = Date.now() - startedAt;
          return {
            findings,
            usage: {
              promptTokens,
              completionTokens,
              totalTokens,
              estimated: inputTokens === undefined || outputTokens === undefined,
            },
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
        }
        const toolSet = toToolSet(request.tools, options.toolTimeoutMs);
        const result = await generateText({
          model,
          system: request.system,
          prompt: request.prompt,
          temperature: request.temperature ?? options.temperature,
          maxOutputTokens: request.maxOutputTokens ?? options.maxTokens,
          maxRetries: options.retries,
          abortSignal,
          // 有工具时启用 ReAct 循环：模型可多次调用只读工具后再给出结论
          ...(toolSet === undefined
            ? {}
            : { tools: toolSet, stopWhen: stepCountIs(request.maxSteps ?? 6) }),
        });
        const text = result.text;
        const findings = parseFindings(text, request.dimension);
        // totalUsage 汇总全部 ReAct 步骤；单轮时与 usage 相同
        const usage = result.totalUsage;
        const inputTokens = usage.inputTokens;
        const outputTokens = usage.outputTokens;
        const promptTokens =
          inputTokens ?? Math.ceil((request.system.length + request.prompt.length) / 4);
        const completionTokens = outputTokens ?? Math.ceil(text.length / 4);
        const totalTokens = usage.totalTokens ?? promptTokens + completionTokens;
        const latencyMs = Date.now() - startedAt;
        return {
          findings,
          usage: {
            promptTokens,
            completionTokens,
            totalTokens,
            estimated: inputTokens === undefined || outputTokens === undefined,
          },
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
      } catch (error) {
        if (timeoutSignal.aborted) {
          throw new LlmError('request timed out', 'timeout', { cause: error });
        }
        throw classifyError(error);
      }
    },
  };
}
