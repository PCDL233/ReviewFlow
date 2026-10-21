import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createGitRunner, GitReader } from '@ai-review/diff';
import type { RepoBranch, RepoCommit, RepoStatus, Repository } from '@ai-review/shared/api';

/** 目录扫描深度上限：够覆盖 `<root>/<group>/<repo>`，同时避免遍历整个磁盘 */
const MAX_SCAN_DEPTH = 3;
/** 单次扫描返回的仓库上限（防止超大工作区把响应撑爆） */
const MAX_REPOSITORIES = 200;
/** 分支/提交列表默认上限 */
const DEFAULT_LIST_LIMIT = 50;

/** 扫描时跳过的目录：VCS 内部、依赖与构建产物 */
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.turbo',
  '.next',
  'target',
  'vendor',
]);

function isGitRepo(path: string): boolean {
  return existsSync(join(path, '.git'));
}

/**
 * 在允许根目录内发现 git 仓库（有界深度遍历）。
 * 只读操作，仅使用同步文件 API——扫描范围由 allowedRoots 限定，量级可控。
 * @param roots 允许的根目录
 * @returns 去重后的仓库列表
 */
function scanRoots(roots: readonly string[]): Repository[] {
  const found = new Map<string, Repository>();

  const walk = (dir: string, depth: number): void => {
    if (found.size >= MAX_REPOSITORIES || depth > MAX_SCAN_DEPTH) return;
    if (isGitRepo(dir)) {
      const path = resolve(dir);
      found.set(path, { path, name: basename(path), isGitRepo: true, reviewed: false });
      return;
    }
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      // 权限不足或目录已删除：跳过该分支，不影响其余根目录
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') && entry !== '.') continue;
      if (SKIPPED_DIRECTORIES.has(entry)) continue;
      const child = join(dir, entry);
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      walk(child, depth + 1);
    }
  };

  for (const root of roots) {
    if (existsSync(root)) walk(root, 0);
  }
  return [...found.values()];
}

/**
 * 仓库发现与只读元信息查询。
 * 所有入口都要求调用方已完成 allowedRoots 校验——本类不做鉴权，
 * 只负责把 git 输出映射为 API 契约（职责分离：鉴权在路由层统一处理）。
 */
export class RepoService {
  /**
   * 列出可用于发起审查的仓库：历史审查记录优先，其后补齐扫描结果。
   * @param roots 允许的根目录
   * @param reviewedPaths 历史审查中出现过的仓库路径
   * @returns 仓库列表（历史仓库在前，按路径去重）
   */
  public list(roots: readonly string[], reviewedPaths: readonly string[]): Repository[] {
    const result = new Map<string, Repository>();
    for (const path of reviewedPaths) {
      if (!existsSync(path)) continue;
      const absolute = resolve(path);
      result.set(absolute, {
        path: absolute,
        name: basename(absolute),
        isGitRepo: isGitRepo(absolute),
        reviewed: true,
      });
    }
    for (const repo of scanRoots(roots)) {
      if (result.has(repo.path)) continue;
      if (result.size >= MAX_REPOSITORIES) break;
      result.set(repo.path, repo);
    }
    return [...result.values()];
  }

  /**
   * 读取仓库工作区状态（分支、HEAD、暂存/未暂存/未跟踪文件数）。
   * @param repoPath 仓库绝对路径
   * @returns 工作区状态；非 git 仓库时 isGitRepo=false 且计数为 0
   */
  public async status(repoPath: string): Promise<RepoStatus> {
    if (!isGitRepo(repoPath)) {
      return {
        path: repoPath,
        isGitRepo: false,
        branch: '',
        headCommit: null,
        headMessage: null,
        stagedFiles: 0,
        unstagedFiles: 0,
        untrackedFiles: 0,
      };
    }
    const reader = new GitReader(createGitRunner(repoPath), repoPath);
    const [counts, headCommit, headMeta] = await Promise.all([
      reader.readStatus(),
      reader.readHeadCommit(),
      reader.readCommitMeta('HEAD'),
    ]);
    return {
      path: repoPath,
      isGitRepo: true,
      branch: counts.branch,
      headCommit,
      headMessage: headMeta?.subject ?? null,
      stagedFiles: counts.stagedFiles,
      unstagedFiles: counts.unstagedFiles,
      untrackedFiles: counts.untrackedFiles,
    };
  }

  /**
   * 列出分支（本地分支，按最近提交时间排序）。
   * @param repoPath 仓库绝对路径
   * @param limit 返回上限
   * @returns 分支列表
   */
  public async branches(repoPath: string, limit = DEFAULT_LIST_LIMIT): Promise<RepoBranch[]> {
    const git = createGitRunner(repoPath);
    const [current, output] = await Promise.all([
      new GitReader(git, repoPath).readBranch(),
      git(
        'for-each-ref',
        '--sort=-committerdate',
        `--count=${Math.max(1, Math.min(limit, MAX_REPOSITORIES))}`,
        '--format=%(refname:short)%09%(objectname:short)',
        'refs/heads',
      ),
    ]);
    const branch = current.trim();
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => {
        const [name = '', commit = ''] = line.split('\t');
        return { name, current: name === branch, commit: commit === '' ? null : commit };
      });
  }

  /**
   * 列出提交（默认从 HEAD 回溯）。
   * @param repoPath 仓库绝对路径
   * @param limit 返回上限
   * @param ref 起点引用
   * @returns 提交列表
   */
  public async commits(
    repoPath: string,
    limit = DEFAULT_LIST_LIMIT,
    ref = 'HEAD',
  ): Promise<RepoCommit[]> {
    const git = createGitRunner(repoPath);
    const count = Math.max(1, Math.min(limit, MAX_REPOSITORIES));
    const output = await git(
      'log',
      `-n${count}`,
      '--format=%H%x09%h%x09%s%x09%an%x09%aI',
      ref,
      '--',
    );
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => {
        const [hash = '', shortHash = '', subject = '', author = '', date = ''] = line.split('\t');
        return { hash, shortHash, subject, author, date };
      });
  }
}

/**
 * 收集历史审查中出现过的仓库路径（去重，最多 100 条）。
 * @param paths 数据库返回的 repoPath 列表
 * @returns 去重后的绝对路径
 */
export function uniqueRepoPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))].slice(0, 100);
}
