#!/usr/bin/env node
/**
 * 清理可再生的构建产物与缓存。
 *
 * 只处理 `.gitignore` 已覆盖的构建输出，刻意不碰数据库、日志、报告和本地工具配置；
 * 删除前统一走 `git check-ignore` 校验，避免误删被重新纳入版本控制的文件。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, '..');
const WORKSPACE_PARENTS = ['apps', 'packages'];
const EXTRA_TARGETS = ['.turbo', 'tooling/tsconfig/tsconfig.tsbuildinfo'];
const STALE_LINK = 'node_modules/.pnpm/node_modules/@ai-review/cli';
const STALE_LINK_TARGET = 'apps/cli';
const ARGS = process.argv.slice(2);
const KNOWN_ARGS = new Set(['--dry-run', '-n', '--help', '-h']);
const DRY_RUN = ARGS.includes('--dry-run') || ARGS.includes('-n');

/**
 * 发现 apps/* 与 packages/* 下带 package.json 的 workspace 目录。
 * 动态发现可避免新增/删除包后脚本目标清单过期。
 * @returns {string[]} 相对仓库根目录的 workspace 路径
 */
function discoverWorkspaces() {
  const workspaces = [];
  for (const parent of WORKSPACE_PARENTS) {
    const parentDir = path.join(ROOT, parent);
    if (!fs.existsSync(parentDir)) continue;
    for (const entry of fs.readdirSync(parentDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relative = `${parent}/${entry.name}`;
      if (fs.existsSync(path.join(ROOT, relative, 'package.json'))) workspaces.push(relative);
    }
  }
  return workspaces.sort();
}

/**
 * 生成清理目标：每个 workspace 的 dist 与 .turbo，加上根缓存和独立 tsbuildinfo。
 * @returns {string[]} 相对仓库根目录的目标路径
 */
function buildTargets() {
  const workspaces = discoverWorkspaces();
  return [
    ...workspaces.map((workspace) => `${workspace}/dist`),
    ...workspaces.map((workspace) => `${workspace}/.turbo`),
    ...EXTRA_TARGETS,
  ];
}

/**
 * 把相对目标解析为绝对路径，并确保不会逃逸出仓库根目录。
 * @param {string} relative 相对路径
 * @returns {string} 绝对路径
 */
function resolveTarget(relative) {
  const full = path.resolve(ROOT, relative);
  if (!full.startsWith(ROOT + path.sep)) {
    throw new Error(`目标越出仓库根目录: ${relative}`);
  }
  return full;
}

/**
 * 判断路径是否存在；Windows 上断链 Junction 的 lstat 会抛 ENOENT，按不存在处理。
 * @param {string} target 绝对路径
 * @returns {boolean} 是否存在
 */
function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * 确认目标被 .gitignore 覆盖，防止配置变化后误删受跟踪文件。
 * @param {string} relative 相对路径
 */
function assertIgnored(relative) {
  const result = spawnSync('git', ['check-ignore', '-q', '--', relative], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`无法执行 git check-ignore: ${result.error.message}`);
  }
  if (result.status === 0) return;
  if (result.status === 1) {
    throw new Error(`拒绝删除未被 .gitignore 忽略的路径: ${relative}`);
  }
  throw new Error(`git check-ignore 执行失败（status ${String(result.status)}）: ${relative}`);
}

/**
 * 拒绝删除包含受跟踪文件的路径。
 * `.gitignore` 不会自动忽略已强制加入版本控制的文件，必须额外用 git ls-files 兜底。
 * @param {string} relative 相对路径
 */
function assertNoTrackedFiles(relative) {
  const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', relative], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`无法执行 git ls-files: ${result.error.message}`);
  }
  if (result.status === 0) {
    throw new Error(`拒绝删除包含受跟踪文件的路径: ${relative}`);
  }
  if (result.status !== 1) {
    throw new Error(`git ls-files 执行失败（status ${String(result.status)}）: ${relative}`);
  }
}

/**
 * 统一大小写后比较路径；Windows 文件系统大小写不敏感。
 * @param {string} value 路径
 * @returns {string} 可比较的路径
 */
function normalizeForCompare(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

/**
 * 拒绝递归删除链接/重解析点，避免沿 Junction 删除仓库外的目标。
 * @param {string} full 绝对路径
 * @param {string} realRoot 仓库根目录的真实路径
 */
function assertNotLink(full, realRoot) {
  const stat = fs.lstatSync(full);
  if (stat.isSymbolicLink()) {
    throw new Error('目标是符号链接，拒绝递归删除');
  }
  if (!stat.isDirectory()) return;
  const expected = path.join(realRoot, path.relative(ROOT, full));
  const actual = fs.realpathSync.native(full);
  if (normalizeForCompare(actual) !== normalizeForCompare(expected)) {
    throw new Error(`目标是链接或重解析点（${actual}），拒绝递归删除`);
  }
}

/**
 * 统计目标下的文件数与字节数；不跟随符号链接。
 * @param {string} full 绝对路径
 * @returns {{ files: number, bytes: number }} 统计结果
 */
function measure(full) {
  const stat = fs.lstatSync(full);
  if (stat.isFile()) return { files: 1, bytes: stat.size };
  if (!stat.isDirectory()) return { files: 0, bytes: 0 };

  let files = 0;
  let bytes = 0;
  const pending = [full];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      const childStat = fs.lstatSync(child);
      if (childStat.isDirectory() && !childStat.isSymbolicLink()) {
        pending.push(child);
      } else if (childStat.isFile()) {
        files += 1;
        bytes += childStat.size;
      }
    }
  }
  return { files, bytes };
}

/**
 * 格式化字节数。
 * @param {number} bytes 字节数
 * @returns {string} 人类可读的大小
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(2)} ${units[unit]}`;
}

/**
 * 删除单个构建/缓存目标。
 * @param {string} relative 相对路径
 * @param {string} realRoot 仓库根目录的真实路径
 * @returns {{ relative: string, status: string, files?: number, bytes?: number, reason?: string }}
 * 单个目标的处理结果
 */
function removeTarget(relative, realRoot) {
  const full = resolveTarget(relative);
  if (!pathExists(full)) return { relative, status: 'missing' };

  assertIgnored(relative);
  assertNoTrackedFiles(relative);
  assertNotLink(full, realRoot);
  const size = measure(full);
  if (DRY_RUN) return { relative, status: 'would-remove', ...size };

  fs.rmSync(full, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  return { relative, status: 'removed', ...size };
}

/**
 * 移除旧版 CLI 删除后遗留的失效 Junction。
 * 只做非递归删除：真实目录非空时会失败，不会丢数据。
 * @returns {{ status: string, reason?: string }} 处理结果
 */
function removeStaleLink() {
  const link = path.join(ROOT, STALE_LINK);
  const expectedTarget = path.join(ROOT, STALE_LINK_TARGET);

  if (fs.existsSync(expectedTarget)) {
    return { status: 'skipped', reason: `${STALE_LINK_TARGET} 已存在，拒绝移除可能有效的链接` };
  }
  if (DRY_RUN) {
    return { status: 'would-check', reason: '实际清理时将尝试移除非递归 Junction' };
  }

  let stat;
  try {
    stat = fs.lstatSync(link);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Windows 上断链 Junction 无法被 lstat；非递归 rmdir 只移除链接本身。
    if (process.platform !== 'win32') return { status: 'missing' };
    try {
      fs.rmdirSync(link);
      return { status: 'removed' };
    } catch (rmError) {
      if (rmError.code === 'ENOENT') return { status: 'missing' };
      return { status: 'failed', reason: `${rmError.code}: ${rmError.message}` };
    }
  }

  if (stat.isSymbolicLink()) {
    const target = fs.readlinkSync(link);
    const resolved = path.resolve(path.dirname(link), target);
    if (fs.existsSync(resolved)) {
      return { status: 'skipped', reason: `链接目标仍存在: ${resolved}` };
    }
    if (process.platform === 'win32') fs.rmdirSync(link);
    else fs.unlinkSync(link);
    return { status: 'removed' };
  }

  return { status: 'skipped', reason: '不是符号链接/Junction，拒绝删除' };
}

/**
 * 输出帮助。
 */
function printHelp() {
  console.log(
    [
      '用法: node scripts/clean-build.mjs [选项]',
      '',
      '清理 apps/* 与 packages/* 下的 dist、.turbo，根 .turbo、',
      'tooling/tsconfig/tsconfig.tsbuildinfo，以及失效的 @ai-review/cli 链接。',
      '数据库、日志、报告和本地工具配置不会被删除。',
      '',
      '选项:',
      '  -n, --dry-run  只列出将删除的目标与体积',
      '  -h, --help     显示帮助',
    ].join('\n'),
  );
}

/**
 * 校验运行环境：必须是本仓库根目录，且存在 workspace。
 */
function validateEnvironment() {
  if (!fs.existsSync(path.join(ROOT, 'package.json'))) {
    throw new Error(`找不到 package.json，脚本必须位于仓库的 scripts/ 目录: ${ROOT}`);
  }
  if (!fs.existsSync(path.join(ROOT, 'pnpm-workspace.yaml'))) {
    throw new Error(`找不到 pnpm-workspace.yaml，当前目录不是仓库根目录: ${ROOT}`);
  }
  if (discoverWorkspaces().length === 0) {
    throw new Error('未发现 apps/* 或 packages/* workspace');
  }
}

/**
 * 入口。
 */
function main() {
  for (const arg of ARGS) {
    if (!KNOWN_ARGS.has(arg)) {
      console.error(`[clean] 未知参数: ${arg}`);
      printHelp();
      process.exitCode = 2;
      return;
    }
  }
  if (ARGS.includes('--help') || ARGS.includes('-h')) {
    printHelp();
    return;
  }

  validateEnvironment();
  const realRoot = fs.realpathSync.native(ROOT);
  const targets = buildTargets();

  console.log(`[clean] root: ${ROOT}`);
  console.log('[clean] scope: dist / .turbo / *.tsbuildinfo / stale @ai-review/cli link');
  console.log('[clean] preserved: .ai-review-cache, .ai-review-reports, logs, .claude');
  console.log(`[clean] ${String(targets.length)} targets, mode: ${DRY_RUN ? 'dry-run' : 'delete'}`);

  const results = [];
  for (const relative of targets) {
    try {
      results.push(removeTarget(relative, realRoot));
    } catch (error) {
      results.push({ relative, status: 'failed', reason: error.message });
    }
  }

  const planned = results.filter(
    (result) => result.status === 'removed' || result.status === 'would-remove',
  );
  for (const result of planned) {
    const label = result.status === 'removed' ? 'removed' : 'would remove';
    console.log(
      `[clean] ${label} ${result.relative} (${String(result.files)} files, ${formatBytes(
        result.bytes ?? 0,
      )})`,
    );
  }
  for (const result of results) {
    if (result.status === 'failed') {
      console.error(`[clean] failed ${result.relative}: ${result.reason}`);
    }
  }

  const link = removeStaleLink();
  if (link.status === 'removed') {
    console.log(`[clean] removed stale link ${STALE_LINK}`);
  } else if (link.status === 'failed') {
    console.error(`[clean] failed to remove stale link ${STALE_LINK}: ${link.reason}`);
  } else if (link.status === 'skipped') {
    console.log(`[clean] skipped stale link: ${link.reason}`);
  } else if (link.status === 'would-check') {
    console.log(`[dry-run] stale link ${STALE_LINK}: ${link.reason}`);
  }

  const totals = planned.reduce(
    (accumulator, result) => ({
      files: accumulator.files + (result.files ?? 0),
      bytes: accumulator.bytes + (result.bytes ?? 0),
    }),
    { files: 0, bytes: 0 },
  );
  const missing = results.filter((result) => result.status === 'missing').length;
  const failed = results.filter((result) => result.status === 'failed').length;

  if (planned.length === 0) {
    console.log('[clean] no build artifacts or caches found');
  } else if (DRY_RUN) {
    console.log(
      `[dry-run] ${String(planned.length)}/${String(targets.length)} targets present, ` +
        `${String(totals.files)} files, ${formatBytes(totals.bytes)} would be freed`,
    );
  } else {
    console.log(
      `[clean] ${String(planned.length)}/${String(targets.length)} targets removed, ` +
        `${String(totals.files)} files, ${formatBytes(totals.bytes)} freed`,
    );
  }
  if (missing > 0) console.log(`[clean] ${String(missing)} target(s) already absent`);
  if (failed > 0) {
    console.error(`[clean] ${String(failed)} target(s) failed`);
    process.exitCode = 1;
  }
  if (link.status === 'failed') process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`[clean] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
