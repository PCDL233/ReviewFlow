import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Finding } from '@ai-review/shared';
import type { LlmUsage, ReviewProvider, ReviewRequest, ReviewResult } from './types.js';

/**
 * 录制/回放 Provider（方案 4.1 集成测试：LLM 调用以录制/回放模式替换，
 * 首次真实调用时持久化响应为 fixture，此后回放——测试确定性且零 token 消耗）。
 * 缓存键只含审查输入的语义内容（维度 + 文件路径 + 新侧内容 + 变更行），排除时间戳等噪声字段。
 */

/** 请求缓存键：跨会话稳定，相同代码块复用同一 fixture */
function fixtureKey(request: ReviewRequest): string {
  const semanticInput = {
    dimension: request.dimension,
    files: request.context.files.map((file) => ({
      path: file.diff.path,
      stagedContent: file.stagedContent,
      changedLines: file.diff.changedLines,
      ragHits: file.ragHits.map((hit) => hit.id),
    })),
  };
  return createHash('sha256').update(JSON.stringify(semanticInput)).digest('hex').slice(0, 32);
}

/** fixture 结构：保留 findings 兼容旧录制文件，新增 usage/model/provider 用于断言成本 */
type Fixture = {
  key: string;
  /** 录制时的输入摘要，便于人工审阅 fixture（不参与键计算） */
  summary: string;
  findings: Finding[];
  usage?: LlmUsage;
  model?: string;
  provider?: string;
};

function fixturePath(fixtureDir: string, key: string): string {
  return join(fixtureDir, `${key}.json`);
}

function replayResult(fixture: Fixture): ReviewResult {
  return {
    findings: fixture.findings,
    usage: fixture.usage ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimated: false,
    },
    model: fixture.model ?? 'replay',
    provider: fixture.provider ?? 'replay',
    latencyMs: 0,
    fallbackUsed: false,
    status: 'ok',
    attempts: [],
  };
}

/**
 * 包装真实 Provider：每次 review 结果落盘为 fixture。
 * 用于首次录制（可连真实模型），录制产物提交进仓库供回放测试使用。
 */
export function createRecordingProvider(inner: ReviewProvider, fixtureDir: string): ReviewProvider {
  return {
    async review(request, signal): Promise<ReviewResult> {
      const result = await inner.review(request, signal);
      mkdirSync(fixtureDir, { recursive: true });
      const key = fixtureKey(request);
      const fixture: Fixture = {
        key,
        summary: `${request.dimension} · ${request.context.metadata.totalFiles} file(s)`,
        findings: result.findings,
        usage: result.usage,
        model: result.model,
        provider: result.provider,
      };
      writeFileSync(fixturePath(fixtureDir, key), JSON.stringify(fixture, null, 2));
      return result;
    },
  };
}

/**
 * 只读回放 Provider：命中 fixture 时原样返回录制结果；未命中立即失败——
 * 集成测试覆盖到未录制的输入时快速报错，而不是静默放行（规范 §7.4）。
 */
export function createReplayProvider(fixtureDir: string): ReviewProvider {
  return {
    async review(request): Promise<ReviewResult> {
      const path = fixturePath(fixtureDir, fixtureKey(request));
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      } catch (e) {
        throw new Error(`no recorded fixture for review request: ${path}`, { cause: e });
      }
      // 旧录制文件直接存 findings 数组；新格式存完整 fixture 对象
      if (Array.isArray(parsed)) {
        const findings = parsed as Finding[];
        return replayResult({ key: '', summary: 'legacy', findings });
      }
      return replayResult(parsed as Fixture);
    },
  };
}
