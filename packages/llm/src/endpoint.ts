import { MODEL_PROVIDERS } from '@ai-review/shared';
import type { HttpProviderKind } from './types.js';

/**
 * 模型端点的单一解析点（HTTP transport 与 AI SDK transport 共用）。
 * 约定：显式 baseUrl > AI_REVIEW_<PROVIDER>_BASE_URL > 目录默认端点。
 */
export function endpointFor(provider: HttpProviderKind, baseUrl?: string): string {
  if (baseUrl !== undefined && baseUrl !== '') return baseUrl;
  const info = MODEL_PROVIDERS[provider];
  if (info !== undefined) {
    const envBase = process.env[info.envVarName];
    if (envBase !== undefined && envBase !== '') return envBase;
    return info.defaultEndpoint;
  }
  // 防御性兜底：枚举新增但目录未同步时退回本地 Ollama 默认端点。
  return process.env.AI_REVIEW_OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434/v1';
}

/** 去掉末尾斜杠，避免与 SDK 自行拼接的路径形成双斜杠 */
export function trimEndpoint(value: string): string {
  return value.replace(/\/$/, '');
}
