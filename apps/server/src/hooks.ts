import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import type { HookScript } from '@ai-review/shared/api';

/** husky v9 入口脚本：只负责把控制权交给 Node 运行器（跨平台一致的审查调用） */
const SHELL_SCRIPT = [
  '#!/bin/sh',
  '# ai-review pre-commit hook — 由 Web 管理后台安装，请勿手工编辑',
  '# 实际逻辑在 .ai-review/hooks/pre-commit.mjs（Node，Windows/macOS/Linux 通用）',
  'exec node "$(dirname "$0")/../.ai-review/hooks/pre-commit.mjs"',
  '',
].join('\n');

/** 令牌文件相对路径（随 .ai-review-cache 一起 gitignore，绝不提交） */
export const HOOK_TOKEN_FILE = '.ai-review-cache/hook-token';
/** 运行器脚本相对路径 */
const RUNNER_PATH = '.ai-review/hooks/pre-commit.mjs';

/**
 * 安装时必须存在于仓库 .gitignore 的条目。
 * 令牌写入仓库目录后若未被忽略，`git add -A` 会把凭据一起提交——
 * 这是"服务端写盘"引入的新风险，因此在安装环节强制维护忽略规则。
 */
const REQUIRED_IGNORE_ENTRIES = ['.ai-review-cache/', '.ai-review/'];

/**
 * 生成 Node 运行器脚本。
 * 为什么不直接在 hook 里 curl：pre-commit 必须可靠地把退出码传回 git，
 * 而 shell 下解析 JSON 与处理超时各平台差异大；Node 已是本项目的运行时前提。
 * @param options 服务端地址与默认审查参数
 * @returns 脚本文本
 */
function buildRunnerScript(options: {
  serverUrl: string;
  target: string;
  mode: string;
  blockOn: string;
}): string {
  return `#!/usr/bin/env node
// ai-review pre-commit runner — 由 Web 管理后台生成
// 退出码契约：0 通过 / 1 阻断 / 2 配置环境错误 / 3 超时（不阻断）
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SERVER_URL = process.env.AI_REVIEW_SERVER_URL ?? ${JSON.stringify(options.serverUrl)};
const TOKEN_FILE = process.env.AI_REVIEW_TOKEN_FILE ?? ${JSON.stringify(HOOK_TOKEN_FILE)};
const TARGET = process.env.AI_REVIEW_TARGET ?? ${JSON.stringify(options.target)};
const MODE = process.env.AI_REVIEW_MODE ?? ${JSON.stringify(options.mode)};
const BLOCK_ON = process.env.AI_REVIEW_BLOCK_ON ?? ${JSON.stringify(options.blockOn)};

function exitWith(code, message) {
  if (message) process.stderr.write(message + '\\n');
  process.exit(code);
}

let token;
try {
  token = readFileSync(resolve(process.cwd(), TOKEN_FILE), 'utf8').trim();
} catch {
  exitWith(2, 'ai-review: 未找到 Hook 令牌（' + TOKEN_FILE + '）。请在管理后台「Git Hook 与 CI」重新安装。');
}
if (!token) exitWith(2, 'ai-review: Hook 令牌为空，请在管理后台重新安装。');

let response;
try {
  response = await fetch(SERVER_URL.replace(/\\/$/, '') + '/api/hooks/review', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({
      repoPath: process.cwd(),
      target: TARGET,
      mode: MODE,
      blockOn: BLOCK_ON,
    }),
  });
} catch (error) {
  // 服务端不可达时不阻断本地提交（避免基础设施故障冻结团队开发）
  exitWith(3, 'ai-review: 无法连接审查服务（' + SERVER_URL + '），已跳过本次审查。');
}

if (!response.ok) {
  const text = await response.text().catch(() => '');
  exitWith(2, 'ai-review: 审查请求失败（HTTP ' + response.status + '） ' + text);
}

let body;
try {
  body = await response.json();
} catch {
  exitWith(2, 'ai-review: 审查响应不是合法 JSON');
}

if (body.summary) process.stdout.write(body.summary + '\\n');
exitWith(typeof body.exitCode === 'number' ? body.exitCode : 2);
`;
}

/**
 * 组装安装所需的两份脚本内容。
 * @param serverUrl 服务端基地址
 * @param options 默认审查参数
 * @returns 脚本契约（含相对路径）
 */
export function buildHookScripts(
  serverUrl: string,
  options: { target?: string; mode?: string; blockOn?: string } = {},
): HookScript {
  return {
    shell: SHELL_SCRIPT,
    runner: buildRunnerScript({
      serverUrl,
      target: options.target ?? 'staged',
      mode: options.mode ?? 'fast',
      blockOn: options.blockOn ?? 'BLOCKER',
    }),
    paths: { shell: '.husky/pre-commit', runner: RUNNER_PATH },
  };
}

/** 安装结果（写入失败时由调用方转译为 4xx/5xx） */
export type HookInstallResult = {
  files: string[];
  skipped: string[];
};

/**
 * 校验目标路径必须落在仓库根内（防 `../` 与符号链接逃逸）。
 * @throws {Error} 路径越界
 */
function assertInsideRepo(repoPath: string, relative: string): string {
  const repoRoot = resolve(repoPath);
  const target = resolve(repoRoot, relative);
  const boundary = repoRoot.endsWith(sep) ? repoRoot : repoRoot + sep;
  if (target !== repoRoot && !target.startsWith(boundary)) {
    throw new Error(`安装目标越界：${relative}`);
  }
  return target;
}

/**
 * 把 hook 与运行器写入仓库，并将令牌写入已被 gitignore 的缓存目录。
 * 只写两个固定相对路径，不执行仓库内的任何脚本——降低服务端写盘的风险面。
 * @param input 仓库路径、脚本文本、令牌明文与覆盖开关
 * @returns 实际写入的文件与因已存在而跳过的文件
 */
export function installHookFiles(input: {
  repoPath: string;
  scripts: HookScript;
  plainText: string | null;
  overwrite: boolean;
}): HookInstallResult {
  const files: string[] = [];
  const skipped: string[] = [];

  const shellPath = assertInsideRepo(input.repoPath, input.scripts.paths.shell);
  const runnerPath = assertInsideRepo(input.repoPath, input.scripts.paths.runner);
  const tokenPath = assertInsideRepo(input.repoPath, HOOK_TOKEN_FILE);
  // 先补忽略规则：即使后续写入失败，也不能让凭据处于"可被 git add"的状态
  const ignoreFile = assertInsideRepo(input.repoPath, '.gitignore');
  ensureGitignore(ignoreFile);

  const write = (absolute: string, content: string, executable: boolean): void => {
    if (!input.overwrite && existsSync(absolute)) {
      skipped.push(absolute);
      return;
    }
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, 'utf8');
    if (executable) {
      try {
        chmodSync(absolute, 0o755);
      } catch {
        // Windows 上 chmod 无实际语义；失败不影响运行（git 通过 shebang 调用）
      }
    }
    files.push(absolute);
  };

  write(shellPath, input.scripts.shell, true);
  write(runnerPath, input.scripts.runner, true);
  // 令牌：新签发时覆盖（overwrite 语义 = 完全重置）；未签发时保留原令牌，避免重装导致旧 hook 失效
  if (input.plainText !== null) {
    const shouldWrite = input.overwrite || !existsSync(tokenPath);
    if (shouldWrite) {
      mkdirSync(dirname(tokenPath), { recursive: true });
      writeFileSync(tokenPath, `${input.plainText}\n`, 'utf8');
      try {
        chmodSync(tokenPath, 0o600);
      } catch {
        // 同上：Windows 无 POSIX 权限位
      }
      files.push(tokenPath);
    } else {
      skipped.push(tokenPath);
    }
  }

  return { files, skipped };
}

/**
 * 确保 .gitignore 含有所需条目（幂等，仅追加缺失项）。
 * @param ignoreFile .gitignore 绝对路径
 */
export function ensureGitignore(ignoreFile: string): void {
  let current = '';
  if (existsSync(ignoreFile)) {
    current = readFileSync(ignoreFile, 'utf8');
  }
  const existing = new Set(
    current
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^\//, ''))
      .filter((line) => line !== ''),
  );
  const missing = REQUIRED_IGNORE_ENTRIES.filter((entry) => !existing.has(entry));
  if (missing.length === 0) return;
  mkdirSync(dirname(ignoreFile), { recursive: true });
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  const block = ['', '# ai-review 本地凭据与运行器', ...missing, ''].join('\n');
  writeFileSync(ignoreFile, `${current}${separator}${block}`, 'utf8');
}
