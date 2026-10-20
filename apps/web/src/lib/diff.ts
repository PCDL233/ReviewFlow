/**
 * 轻量 unified diff 解析器（不依赖第三方 diff 组件）。
 * 只覆盖 git 生成的 unified diff：文件头、hunk、增删上下文、二进制与空 diff。
 */

export type DiffLineKind = 'add' | 'remove' | 'context';

export type DiffLine = {
  kind: DiffLineKind;
  text: string;
  /** 旧文件行号；新增行为 null。 */
  oldLine: number | null;
  /** 新文件行号；删除行为 null。 */
  newLine: number | null;
};

export type DiffHunk = {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
};

export type DiffFile = {
  oldPath: string;
  path: string;
  isNew: boolean;
  isDeleted: boolean;
  isBinary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
};

const HUNK_PATTERN = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** 归一化 diff 中的路径：去掉 a/ b/ 前缀、引号与反斜杠。 */
export function normalizeDiffPath(value: string): string {
  let path = value.trim();
  if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
  if (path.startsWith('a/') || path.startsWith('b/')) path = path.slice(2);
  return path.replace(/\\/g, '/');
}

/** 从 `diff --git a/x b/y` 行解析两侧路径（路径含空格时以 ` b/` 切分）。 */
function parseGitHeader(line: string): { oldPath: string; path: string } | null {
  const rest = line.slice('diff --git '.length);
  const separator = rest.lastIndexOf(' b/');
  if (separator === -1) return null;
  return {
    oldPath: normalizeDiffPath(rest.slice(0, separator)),
    path: normalizeDiffPath(rest.slice(separator + 1)),
  };
}

function createFile(oldPath: string, path: string): DiffFile {
  return {
    oldPath,
    path,
    isNew: false,
    isDeleted: false,
    isBinary: false,
    additions: 0,
    deletions: 0,
    hunks: [],
  };
}

/**
 * 将 unified diff 文本解析为「文件 → hunk → 行」结构。
 * 空输入返回空数组；无法识别的内容（例如 `\ No newline`）按元信息忽略。
 */
export function parseUnifiedDiff(diffText: string | null | undefined): DiffFile[] {
  if (diffText === null || diffText === undefined || diffText.trim() === '') return [];

  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;

  const flushFile = (): void => {
    if (current !== null && (current.path !== '' || current.hunks.length > 0)) {
      files.push(current);
    }
    current = null;
    hunk = null;
  };

  for (const rawLine of diffText.split(/\r?\n/)) {
    const line = rawLine;

    if (line.startsWith('diff --git ')) {
      flushFile();
      const header = parseGitHeader(line);
      current = createFile(header?.oldPath ?? '', header?.path ?? '');
      continue;
    }

    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      if (current === null) current = createFile('', '');
      const target = line.slice(4).trim();
      const targetPath = target === '/dev/null' ? '/dev/null' : normalizeDiffPath(target);
      if (line.startsWith('--- ')) {
        current.oldPath = targetPath;
        if (targetPath === '/dev/null') current.isNew = true;
      } else {
        current.path = targetPath === '/dev/null' ? current.path : targetPath;
        if (targetPath === '/dev/null') current.isDeleted = true;
      }
      hunk = null;
      continue;
    }

    if (current === null) {
      // 允许直接粘贴不带 diff --git 头的片段（只有 hunk）。
      if (!HUNK_PATTERN.test(line)) continue;
      current = createFile('', '');
    }

    const hunkMatch = HUNK_PATTERN.exec(line);
    if (hunkMatch !== null) {
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
      oldRemaining = hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]);
      newRemaining = hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]);
      hunk = {
        header: line,
        oldStart: oldLine,
        oldCount: oldRemaining,
        newStart: newLine,
        newCount: newRemaining,
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }

    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.isBinary = true;
      continue;
    }

    if (hunk === null) continue;

    if (line.startsWith('\\')) continue;

    const limited = oldRemaining <= 0 && newRemaining <= 0;
    if (limited && line !== '') break;

    if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine });
      newLine += 1;
      newRemaining -= 1;
      current.additions += 1;
      continue;
    }
    if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'remove', text: line.slice(1), oldLine, newLine: null });
      oldLine += 1;
      oldRemaining -= 1;
      current.deletions += 1;
      continue;
    }

    const text = line.startsWith(' ') ? line.slice(1) : line;
    hunk.lines.push({ kind: 'context', text, oldLine, newLine });
    oldLine += 1;
    newLine += 1;
    oldRemaining -= 1;
    newRemaining -= 1;
  }

  flushFile();
  for (const file of files) {
    if (file.path === '' && file.oldPath !== '') file.path = file.oldPath;
  }
  return files;
}

/** 位置区间（用于判断某条 diff 行是否落在发现范围内）。 */
export type LineRange = { start: number; end: number };

/** 判断某行新增行号是否命中给定区间列表。 */
export function isLineInRanges(line: number, ranges: readonly LineRange[]): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

/** 汇总文件增删行数，用于 diff 头部统计。 */
export function diffStats(files: readonly DiffFile[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    additions += file.additions;
    deletions += file.deletions;
  }
  return { additions, deletions };
}
