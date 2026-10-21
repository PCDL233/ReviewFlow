import type { ChangeType, FileDiff } from './diff.js';

/** git 子进程执行器：显式传参数组（规范 §6.2，规避 Windows shell 转义差异） */
export type GitRunner = (...args: string[]) => Promise<string>;

/** —— RAG 检索相关（方案 3.5）—— */

export type RagQuery = {
  query: string;
  topK?: number;
  /** 可选路径过滤（与 RagHit.path 等值匹配） */
  filter?: { path?: string };
  /** 仓库根：服务端按仓库隔离索引，缺省使用服务进程工作目录 */
  repoPath?: string;
};

export type RagHit = {
  id: string;
  path: string;
  kind: string;
  text: string;
  score: number;
};

/** 知识库切块：按 AST 边界（函数/类）或文档段落切分 */
export type Chunk = {
  id: string;
  path: string;
  kind: string;
  text: string;
  /** 增量索引键：内容哈希去重（方案 3.5） */
  contentHash: string;
};

/**
 * RAG 检索器接口（规范 §4.1：依赖面向接口而非实现）。
 * 生产实现为 @ai-review/rag 的 KnowledgeBase；rag.enabled=false 时注入 no-op 实现。
 */
export type RagRetriever = {
  query(query: RagQuery): Promise<RagHit[]>;
};

/** 忽略规则（picomatch 语义：*.lock、dist/** 等） */
export type IgnoreRules = {
  allows(path: string): boolean;
};

/** 文件热度来源（方案 3.2 风险评估维度 ④） */
export type FileHistory = {
  /** 近 days 天内该文件的修改次数 */
  changeFrequency(path: string, days: number): Promise<number>;
};

/** —— 上下文包（方案 3.1）—— */

/** 函数/类 AST 签名；无法解析（非 JS/TS 或解析失败降级）时为 null */
export type FunctionSignature = {
  name: string;
  params: string[];
  isAsync: boolean;
  range: { startLine: number; endLine: number };
} | null;

export type FileContext = {
  diff: FileDiff;
  /**
   * 待审文件的"新侧"全文：staged 来自 index blob（`git show :path`），
   * commit/range 来自对应提交，worktree 来自工作区磁盘。
   * 核心正确性约定：审查对象是提交内容而非未暂存改动（方案 3.1）。
   * 删除文件为空串（无新侧内容），降级为仅 diff 审查。
   */
  stagedContent: string;
  /** 变更行所在函数/类的完整源码片段；无 AST 能力时为空串 */
  snippet: string;
  signature: FunctionSignature;
  ragHits: RagHit[];
  changeType: ChangeType;
};

export type CodeContextMetadata = {
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  languages: string[];
  generatedAt: string;
};

export type CodeContext = {
  files: FileContext[];
  metadata: CodeContextMetadata;
};
