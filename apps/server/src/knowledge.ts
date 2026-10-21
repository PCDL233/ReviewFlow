import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createOpenAI } from '@ai-sdk/openai';
import { KnowledgeBase } from '@ai-review/rag';
import type { AiReviewConfig, KnowledgeStatus, RagHit, RagQuery } from '@ai-review/shared';
import type { KnowledgeManager } from './app.js';

/** 单个仓库的索引实例与状态 */
type RepoIndex = {
  repoPath: string;
  indexDir: string;
  knowledgeBase: KnowledgeBase;
  status: KnowledgeStatus;
  ready: Promise<void>;
};

/**
 * 服务端知识库管理器（按仓库隔离）。
 * 为什么按仓库：审查服务会面对多个仓库，进程级单索引会把 A 项目的约定召回进 B 项目，
 * 也无法回答“这个仓库索引到哪一步了”。索引目录为 `<indexDir>/<repoHash>`，
 * 检索时按 `RagQuery.repoPath` 选择对应索引；未建索引的仓库直接返回空召回。
 * 索引任务后台执行，检索/嵌入失败自动降级为空结果，不阻断审查。
 */
export class ServerKnowledgeManager implements KnowledgeManager {
  private readonly indexes = new Map<string, RepoIndex>();
  private readonly embeddingModel: ConstructorParameters<typeof KnowledgeBase>[1];
  private readonly defaultRepoPath: string;
  private lastRepoPath: string | undefined;

  constructor(private readonly config: AiReviewConfig) {
    this.defaultRepoPath = process.cwd();
    const embeddingConfig = config.rag.embedding;
    const embedBaseUrl =
      embeddingConfig.baseUrl ??
      process.env.AI_REVIEW_EMBEDDING_BASE_URL ??
      'http://127.0.0.1:11434/v1';
    const embedApiKey =
      embeddingConfig.apiKey ??
      (config.llm.apiKey === '${AI_REVIEW_API_KEY}' ? 'ollama' : config.llm.apiKey);
    const embedding = createOpenAI({ baseURL: embedBaseUrl, apiKey: embedApiKey });
    this.embeddingModel = embedding.textEmbeddingModel(
      embeddingConfig.model !== ''
        ? embeddingConfig.model
        : (process.env.AI_REVIEW_EMBEDDING_MODEL ?? 'nomic-embed-text'),
    );
  }

  /** 仓库索引目录：同一仓库路径得到稳定目录，避免多仓库互相覆盖 */
  private indexDirFor(repoPath: string): string {
    const hash = createHash('sha256').update(resolve(repoPath)).digest('hex').slice(0, 12);
    return join(this.config.rag.indexDir, hash);
  }

  /** 索引路径按仓库根解析；不存在的路径跳过，避免整个重建因一个缺失目录失败 */
  private resolvePaths(repoPath: string): string[] {
    return this.config.rag.knowledgeBasePaths
      .map((path) => resolve(repoPath, path))
      .filter((path) => existsSync(path));
  }

  private getOrCreateIndex(repoPath: string): RepoIndex {
    const key = resolve(repoPath);
    const existing = this.indexes.get(key);
    if (existing !== undefined) return existing;
    const indexDir = this.indexDirFor(key);
    const entry: RepoIndex = {
      repoPath: key,
      indexDir,
      knowledgeBase: new KnowledgeBase(indexDir, this.embeddingModel),
      status: {
        status: this.config.rag.enabled ? 'idle' : 'disabled',
        indexDir,
        chunkCount: 0,
        paths: this.resolvePaths(key),
        lastIndexedAt: existsSync(indexDir) ? statSync(indexDir).mtime.toISOString() : null,
        error: null,
        repoPath: key,
      },
      ready: Promise.resolve(),
    };
    entry.ready = this.loadIndex(entry);
    this.indexes.set(key, entry);
    return entry;
  }

  /** 打开磁盘上已有索引并重建内存 BM25；不触发嵌入服务 */
  private async loadIndex(entry: RepoIndex): Promise<void> {
    if (!this.config.rag.enabled || !existsSync(entry.indexDir)) return;
    try {
      const chunkCount = await entry.knowledgeBase.open();
      entry.status = {
        ...entry.status,
        status: chunkCount > 0 ? 'ready' : 'idle',
        chunkCount,
      };
    } catch (error) {
      entry.status = {
        ...entry.status,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 查询索引状态。
   * @param repoPath 仓库路径；缺省为最近一次重建的仓库，再缺省为服务进程工作目录
   */
  public async getStatus(repoPath?: string): Promise<KnowledgeStatus> {
    const target = repoPath ?? this.lastRepoPath ?? this.defaultRepoPath;
    const entry = this.getOrCreateIndex(target);
    await entry.ready;
    return entry.status;
  }

  /**
   * 重建指定仓库的知识库索引（异步，状态可查询）。
   * @param repoPath 仓库路径；缺省为最近一次重建的仓库，再缺省为服务进程工作目录
   */
  public async reindex(repoPath?: string): Promise<void> {
    const target = repoPath ?? this.lastRepoPath ?? this.defaultRepoPath;
    const entry = this.getOrCreateIndex(target);
    await entry.ready;
    if (!this.config.rag.enabled || entry.status.status === 'running') return;
    this.lastRepoPath = entry.repoPath;
    entry.status = { ...entry.status, status: 'running', error: null };
    try {
      const summary = await entry.knowledgeBase.build(entry.status.paths);
      entry.status = {
        ...entry.status,
        status: 'ready',
        chunkCount: summary.totalChunks,
        lastIndexedAt: new Date().toISOString(),
        error: null,
      };
    } catch (error) {
      entry.status = {
        ...entry.status,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * RagRetriever 适配：按 query.repoPath 选择索引。
   * 未建索引/未启用/嵌入服务不可用时返回空召回（审查继续，报告不标注虚假命中）。
   */
  public readonly retriever = {
    query: async (query: RagQuery): Promise<RagHit[]> => {
      if (!this.config.rag.enabled) return [];
      const target = query.repoPath ?? this.lastRepoPath ?? this.defaultRepoPath;
      const key = resolve(target);
      let entry = this.indexes.get(key);
      if (entry === undefined) {
        // 不隐式创建空索引：只有磁盘上已有索引目录时才打开（避免每次审查都新建目录）
        if (!existsSync(this.indexDirFor(key))) return [];
        entry = this.getOrCreateIndex(key);
      }
      await entry.ready;
      if (entry.status.status !== 'ready') return [];
      try {
        return await entry.knowledgeBase.query(query);
      } catch {
        return [];
      }
    },
  };
}

export function createKnowledgeManager(config: AiReviewConfig): ServerKnowledgeManager {
  return new ServerKnowledgeManager(config);
}
