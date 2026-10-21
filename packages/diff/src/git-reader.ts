import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GitRunner, ReviewSource } from '@ai-review/shared';

const execFileAsync = promisify(execFile);

/** 审查来源对应的新侧内容定位方式 */
type ContentRef = { kind: 'index' } | { kind: 'ref'; ref: string } | { kind: 'worktree' };

/**
 * 创建限定仓库目录的 Git 命令执行器。
 * @param repoPath Git 仓库路径
 * @returns 使用参数数组执行 Git 命令的函数
 * @throws {Error} Git 命令失败时透传底层错误
 */
export function createGitRunner(repoPath: string): GitRunner {
  return async (...args: string[]): Promise<string> => {
    const result = await execFileAsync('git', args, {
      cwd: repoPath,
      maxBuffer: 64 * 1024 * 1024,
    });
    return result.stdout;
  };
}

/**
 * 审查来源 → git diff 参数与"新侧内容"定位。
 * 集中在一处，避免调用方各自拼装 git 参数导致语义漂移。
 * @param source 审查来源
 * @returns diff 参数数组、新侧内容定位与报告用的提交引用
 */
export function resolveSource(source: ReviewSource): {
  diffArgs: string[];
  content: ContentRef;
  commitRef: string;
} {
  switch (source.target) {
    case 'staged':
      return { diffArgs: ['--cached'], content: { kind: 'index' }, commitRef: 'HEAD' };
    case 'worktree':
      return { diffArgs: [], content: { kind: 'worktree' }, commitRef: 'HEAD' };
    case 'commit':
      // <sha>^! 只展开该提交自身的变更（父提交 → 该提交）
      return {
        diffArgs: [`${source.commit}^!`],
        content: { kind: 'ref', ref: source.commit },
        commitRef: source.commit,
      };
    case 'range':
      return {
        diffArgs: [`${source.base}...${source.head ?? 'HEAD'}`],
        content: { kind: 'ref', ref: source.head ?? 'HEAD' },
        commitRef: source.head ?? 'HEAD',
      };
  }
}

/** 工作区状态计数（git status --porcelain=v1 的口径，Hook/Web/报告共用） */
export type GitStatusCounts = {
  branch: string;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
};

/**
 * 读取暂存区/区间 diff 与文件内容。
 * 所有 git 调用显式传参数组（规范 §6.2，规避 Windows shell 转义差异）。
 */
export class GitReader {
  constructor(
    private readonly git: GitRunner,
    /** worktree 目标读取磁盘内容所需；缺省时该目标降级为仅 diff 审查 */
    private readonly repoPath?: string,
  ) {}

  /**
   * 读取审查来源对应的 unified diff。
   * @param source 审查来源
   * @param unified unified 上下文行数
   * @returns diff 文本
   */
  public readDiff(source: ReviewSource, unified = 50): Promise<string> {
    return this.git('diff', ...resolveSource(source).diffArgs, `--unified=${unified}`);
  }

  /**
   * 读取暂存区快照的 unified diff（保持既有调用方兼容）。
   * @returns 暂存区 diff 文本
   */
  public readStagedDiff(): Promise<string> {
    return this.readDiff({ target: 'staged' });
  }

  /**
   * 读取 base...HEAD 区间的 unified diff（CI 模式）。
   * 三点语法取 merge-base 起算的变更，PR 分支上对 base 的最新提交不产生噪音 diff。
   * @param base 起始引用（分支名 / SHA）
   * @returns 区间 diff 文本
   */
  public readRangeDiff(base: string): Promise<string> {
    return this.readDiff({ target: 'range', base });
  }

  /**
   * 读取审查来源下某文件的新侧完整内容。
   * @param path 仓库内相对路径
   * @param source 审查来源
   * @returns 新侧内容；文件不存在（删除）时返回空串
   */
  public async readFileAt(path: string, source: ReviewSource): Promise<string> {
    const { content } = resolveSource(source);
    if (content.kind === 'worktree') {
      if (this.repoPath === undefined) return '';
      try {
        return await readFile(join(this.repoPath, path), 'utf8');
      } catch {
        // 磁盘上不存在（已删除或仅存在于索引）时降级为仅 diff 审查
        return '';
      }
    }
    try {
      return await this.git(
        'show',
        `${content.kind === 'index' ? ':' : `${content.ref}:`}${path}`,
      );
    } catch {
      return '';
    }
  }

  /**
   * 读取文件在 index 中的完整内容。
   * @param path 仓库内相对路径
   * @returns index blob 内容；删除文件没有 blob 时返回空串
   */
  public readStagedFile(path: string): Promise<string> {
    return this.readFileAt(path, { target: 'staged' });
  }

  /**
   * 读取文件在 HEAD 提交中的完整内容。
   * @param path 仓库内相对路径
   * @returns HEAD blob 内容；文件不存在（被删除）时返回空串
   */
  public readHeadFile(path: string): Promise<string> {
    return this.readFileAt(path, { target: 'range', base: 'HEAD' });
  }

  /**
   * 读取当前分支名称。
   * @returns 当前分支名称
   */
  public readBranch(): Promise<string> {
    return this.git('branch', '--show-current');
  }

  /**
   * 读取 HEAD 完整哈希（报告 meta.commitHash 的数据源）。
   * @returns HEAD 哈希；仓库尚无提交时返回 null
   */
  public async readHeadCommit(): Promise<string | null> {
    try {
      return (await this.git('rev-parse', 'HEAD')).trim() || null;
    } catch {
      // 空仓库（无任何提交）时 rev-parse HEAD 会失败；审查仍可继续
      return null;
    }
  }

  /**
   * 读取提交元信息（作者与标题），填充报告的 author 字段。
   * @param ref 提交引用
   * @returns 作者与标题；读取失败时返回 null
   */
  public async readCommitMeta(ref: string): Promise<{ author: string; subject: string } | null> {
    try {
      const output = await this.git('show', '-s', '--format=%an%n%s', ref);
      const [author = '', subject = ''] = output.split(/\r?\n/);
      return { author, subject };
    } catch {
      // 引用无效/存在歧义时不阻断审查，报告 author 留空
      return null;
    }
  }

  /**
   * 在仓库内搜索文本（ReAct 工具用，只读）。
   * 参数经数组传递，`-e` 后的查询不会被当作 git 选项；无匹配/非 git 仓库返回空串。
   * @param query 查询文本（≤200 字符，不以 `-` 开头）
   * @param maxResults 每个文件的最大匹配数
   * @returns `git grep -n` 的原始输出；无结果或错误时为空串
   */
  public async search(query: string, maxResults = 50): Promise<string> {
    const trimmed = query.trim();
    if (trimmed === '' || trimmed.length > 200 || trimmed.startsWith('-')) return '';
    try {
      return await this.git(
        'grep',
        '-n',
        '-I',
        '-m',
        String(Math.max(1, Math.min(100, maxResults))),
        '-e',
        trimmed,
        '--',
        '.',
      );
    } catch {
      // “没有匹配”与“非 git 仓库”都按空结果降级：工具调用不应因此失败
      return '';
    }
  }

  /**
   * 查找标识符的引用位置（`git grep -w`，只读）。
   * @param symbol 合法标识符（字母/下划线/$ 开头）
   * @param maxResults 每个文件的最大匹配数
   * @returns `git grep -n` 原始输出；非法标识符/无匹配/错误时为空串
   */
  public async searchSymbol(symbol: string, maxResults = 50): Promise<string> {
    if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) return '';
    try {
      return await this.git(
        'grep',
        '-n',
        '-I',
        '-w',
        '-m',
        String(Math.max(1, Math.min(100, maxResults))),
        '-e',
        symbol,
        '--',
        '.',
      );
    } catch {
      // 无匹配或非 git 仓库：按空结果降级
      return '';
    }
  }

  /**
   * 读取工作区状态计数，供 Web 在发起审查前做即时校验。
   * @returns 分支名与暂存/未暂存/未跟踪文件数
   * @throws {Error} 非 git 仓库或命令失败
   */
  public async readStatus(): Promise<GitStatusCounts> {
    const [porcelain, branch] = await Promise.all([
      this.git('status', '--porcelain=v1', '--untracked-files=normal'),
      this.readBranch(),
    ]);
    let stagedFiles = 0;
    let unstagedFiles = 0;
    let untrackedFiles = 0;
    for (const line of porcelain.split(/\r?\n/)) {
      if (line.length < 3) continue;
      const index = line[0] ?? ' ';
      const worktree = line[1] ?? ' ';
      if (index === '?' && worktree === '?') {
        untrackedFiles += 1;
        continue;
      }
      if (index !== ' ' && index !== '?') stagedFiles += 1;
      if (worktree !== ' ' && worktree !== '?') unstagedFiles += 1;
    }
    return { branch: branch.trim(), stagedFiles, unstagedFiles, untrackedFiles };
  }
}
