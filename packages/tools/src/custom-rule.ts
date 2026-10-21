import picomatch from 'picomatch';
import type { CustomRule, CustomRuleMatchScope, FileContext, Finding } from '@ai-review/shared';

/**
 * 用户自定义审查规则引擎（方案：custom_rule_check 确定性工具）。
 * 规则以正则表达式的形态在流水线 static 阶段执行：命中即产出 Finding（agent=static），
 * 与内置工具共享同一数据结构，经交叉验证后进入报告与阻断判定。
 */

/** 自定义规则的确定性来源（方案 3.6 阶段 2：静态分析基准置信度 0.9） */
const CUSTOM_RULE_CONFIDENCE = 0.9;

/** 范围优先级：added 行号最精确；跨范围去重时按此顺序保留最先命中的发现 */
const SCOPE_PRIORITY: readonly CustomRuleMatchScope[] = ['added', 'staged', 'snippet'];

/** 规则命中：匹配范围 + 行号 + 命中文本 */
export type CustomRuleHit = {
  scope: CustomRuleMatchScope;
  line: number;
  text: string;
};

/** 单文件规则扫描字符上限：防止超长生成物/压缩文件把同步正则变成事实上的 DoS */
const MAX_CUSTOM_RULE_SCAN_CHARS = 1_000_000;

/**
 * 明显的灾难性回溯形态：分组内含重复量词、分组外再次重复，例如 `(a+)+`、`(.*)*`。
 * 这是启发式预检（不是完整的正则安全性证明），宁可拒绝一条规则也不阻塞审查进程。
 */
const UNSAFE_NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)\s*[+*{]/;

/**
 * 编译规则正则；非法表达式或明显的 ReDoS 形态返回 null
 * （该规则被跳过，确定性工具不阻断流水线）。
 * @param rule 自定义规则
 * @returns 编译后的正则，失败为 null
 */
export function compileCustomRulePattern(rule: CustomRule): RegExp | null {
  if (rule.pattern.length > 1024 || UNSAFE_NESTED_QUANTIFIER.test(rule.pattern)) return null;
  try {
    return new RegExp(rule.pattern, rule.flags);
  } catch {
    return null;
  }
}

/** 对文本逐行匹配；每次 test 前重置 lastIndex，兼容 g/y 标志的游标状态 */
function matchLines(pattern: RegExp, text: string): Array<{ line: number; text: string }> {
  const hits: Array<{ line: number; text: string }> = [];
  text.split(/\r?\n/).forEach((line, index) => {
    pattern.lastIndex = 0;
    if (pattern.test(line)) hits.push({ line: index + 1, text: line });
  });
  return hits;
}

/** 单文件 × 单规则的命中收集：按配置的匹配范围逐项匹配，并按行号跨范围去重 */
function matchFileScope(rule: CustomRule, file: FileContext, pattern: RegExp): CustomRuleHit[] {
  const hits: CustomRuleHit[] = [];
  for (const scope of SCOPE_PRIORITY) {
    if (!rule.matchScope.includes(scope)) continue;
    if (scope === 'added') {
      // 变更新增行：以 diff 的 newLineNo 为准（方案 3.1：审查聚焦新增/修改行）
      for (const line of file.diff.changedLines) {
        if (line.type !== 'added' || line.newLineNo === null) continue;
        pattern.lastIndex = 0;
        if (pattern.test(line.content))
          hits.push({ scope, line: line.newLineNo, text: line.content });
      }
    } else if (scope === 'staged') {
      // 暂存文件全文（index blob）：逐行匹配，行号为文件内行号；超长文件截断以限制单次正则成本
      for (const { line, text } of matchLines(
        pattern,
        file.stagedContent.slice(0, MAX_CUSTOM_RULE_SCAN_CHARS),
      )) {
        hits.push({ scope, line, text });
      }
    } else {
      // 变更函数/类源码片段：AST 签名提供绝对起始行；无签名时相对片段起始（best effort）
      const baseLine = file.signature?.range.startLine ?? 1;
      for (const { line, text } of matchLines(pattern, file.snippet)) {
        hits.push({ scope, line: baseLine + line - 1, text });
      }
    }
  }
  const byLine = new Map<number, CustomRuleHit>();
  for (const hit of hits) {
    if (!byLine.has(hit.line)) byLine.set(hit.line, hit);
  }
  return [...byLine.values()];
}

/** 规则命中 → Finding（标题为空时回退为规则名） */
function toFindings(rule: CustomRule, file: FileContext, hits: CustomRuleHit[]): Finding[] {
  const title = rule.message !== '' ? rule.message : `Custom rule matched: ${rule.name}`;
  const description =
    rule.description !== ''
      ? rule.description
      : `Matched custom rule "${rule.name}" with pattern /${rule.pattern}/${rule.flags}.`;
  return hits.map((hit) => ({
    agent: 'static',
    severity: rule.severity,
    confidence: CUSTOM_RULE_CONFIDENCE,
    filePath: file.diff.path,
    lineStart: hit.line,
    lineEnd: hit.line,
    title,
    description,
    ...(rule.suggestion !== '' ? { suggestion: rule.suggestion } : {}),
    ...(rule.cweId === undefined ? {} : { cweId: rule.cweId }),
    codeSnippet: hit.text,
    isFalsePositive: false,
  }));
}

/**
 * 执行启用的自定义规则，产出确定性发现（custom_rule_check 工具实现）。
 * 规则作用于三类范围：变更新增行 / 暂存文件全文 / 变更函数源码片段；
 * 非法正则的规则被跳过（降级不阻断），禁用规则不参与匹配。
 * @param files 上下文文件列表
 * @param rules 全部自定义规则（内部过滤 enabled）
 * @returns 规则命中产出的发现
 */
export function runCustomRules(
  files: readonly FileContext[],
  rules: readonly CustomRule[],
): Finding[] {
  const findings: Finding[] = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const pattern = compileCustomRulePattern(rule);
    if (pattern === null) continue;
    // 文件过滤：filePatterns 为空匹配全部；否则按 picomatch glob 语义（dot:true 覆盖隐藏文件）
    const isFileMatch =
      rule.filePatterns.length === 0 ? () => true : picomatch(rule.filePatterns, { dot: true });
    for (const file of files) {
      if (!isFileMatch(file.diff.path.replaceAll('\\', '/'))) continue;
      findings.push(...toFindings(rule, file, matchFileScope(rule, file, pattern)));
    }
  }
  return findings;
}

/**
 * 试跑（管理后台在线测试入口，POST /api/admin/rules/test）。
 * added 范围取示例 diff 的新增行；staged/snippet 范围对示例源码逐行匹配。
 * added 范围没有文件行号语义，line 恒为 0（UI 按"—"展示）。
 * @param rule 待试跑的规则（不校验 enabled）
 * @param samples 示例输入
 * @returns 命中行列表；规则正则非法时返回空数组（调用方另行提示编译错误）
 */
export function testCustomRuleOnSamples(
  rule: CustomRule,
  samples: { diffText: string; source: string },
): CustomRuleHit[] {
  const pattern = compileCustomRulePattern(rule);
  if (pattern === null) return [];
  const hits: CustomRuleHit[] = [];
  if (rule.matchScope.includes('added')) {
    for (const line of samples.diffText.split(/\r?\n/)) {
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      pattern.lastIndex = 0;
      if (pattern.test(line.slice(1))) hits.push({ scope: 'added', line: 0, text: line.slice(1) });
    }
  }
  if (rule.matchScope.includes('staged') || rule.matchScope.includes('snippet')) {
    const scope: CustomRuleMatchScope = rule.matchScope.includes('snippet') ? 'snippet' : 'staged';
    for (const { line, text } of matchLines(pattern, samples.source)) {
      hits.push({ scope, line, text });
    }
  }
  // 跨范围去重：同一文本只保留一条。added 范围 line 恒为 0（无文件行号语义），
  // 后续 staged/snippet 命中同文本时以其真实行号覆盖，兼顾展示准确与结果简洁。
  const byText = new Map<string, CustomRuleHit>();
  for (const hit of hits) {
    const existing = byText.get(hit.text);
    if (existing === undefined || existing.line === 0) byText.set(hit.text, hit);
  }
  return [...byText.values()];
}
