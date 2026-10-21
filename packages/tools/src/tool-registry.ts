import type { CodeContext, CustomRule, Finding } from '@ai-review/shared';
import { complexityFindings } from './complexity.js';
import { scanSecrets } from './secret-scan.js';
import { dependencyFindings } from './dependency-scan.js';
import { astFindings } from './ast-parse.js';
import { runCustomRules } from './custom-rule.js';

/**
 * 进程内静态分析工具（方案 3.4 工具总线）。
 * 确定性工具对 CodeContext 产出 Finding，与 LLM 发现共享同一数据结构；
 * 对外经 MCP 暴露时复用同一实现（packages/tools 的 mcp-server，后续里程碑）。
 */
export type StaticTool = {
  readonly name: string;
  readonly description: string;
  run(context: CodeContext): Finding[];
};

/** 单次工具执行失败（隔离后不阻断流水线，但必须可观测） */
export type ToolFailure = {
  tool: string;
  message: string;
};

/** 工具注册表：Agent 与流水线经注册表调用工具，禁止绕过总线直接 import 实现（规范 §6.5） */
export class ToolRegistry {
  private readonly tools = new Map<string, StaticTool>();
  private readonly failures: ToolFailure[] = [];

  /** @param tool 注册的工具；同名注册覆盖（幂等装配） */
  public register(tool: StaticTool): void {
    this.tools.set(tool.name, tool);
  }

  /** @returns 已注册工具名的稳定排序列表 */
  public list(): string[] {
    return [...this.tools.keys()].sort();
  }

  /** @returns 本次运行中失败的工具（供报告/可观测页展示） */
  public getFailures(): readonly ToolFailure[] {
    return [...this.failures];
  }

  /**
   * 依配置顺序运行启用的工具并汇总发现。
   * 单个工具抛错只记录失败并跳过，不能拖垮整个审查（历史缺陷：一个工具异常导致 static 节点失败）。
   * 注：工具为同步 CPU 操作，Node 无法在同线程内中断；超时保护需后续改为 Worker 执行。
   * @param context 审查上下文
   * @param enabledTools 启用的工具名；省略时运行全部
   * @returns 全部静态分析发现
   */
  public runAll(context: CodeContext, enabledTools?: readonly string[]): Finding[] {
    const enabled = enabledTools === undefined ? this.tools.keys() : enabledTools;
    return [...enabled].flatMap((name) => {
      const tool = this.tools.get(name);
      if (tool === undefined) return [];
      try {
        return tool.run(context);
      } catch (error) {
        this.failures.push({
          tool: name,
          message: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    });
  }
}

/** 默认复杂度阈值，与配置 schema staticAnalysis.complexityThreshold 默认值一致 */
export const DEFAULT_COMPLEXITY_THRESHOLD = 15;

/**
 * 解析实际启用的静态工具列表：配置了启用规则时，无论 enabledTools 是否显式包含
 * custom_rule_check，都自动并入——规则随配置保存即生效，无需手工开启（整体停用请关闭全部规则）。
 * @param enabledTools 配置声明的启用工具
 * @param customRules 全部自定义规则
 * @returns 实际生效的工具名列表
 */
export function resolveEnabledTools(
  enabledTools: readonly string[],
  customRules: readonly CustomRule[],
): string[] {
  const hasEnabledRules = customRules.some((rule) => rule.enabled);
  if (!hasEnabledRules || enabledTools.includes('custom_rule_check')) {
    return [...enabledTools];
  }
  return [...enabledTools, 'custom_rule_check'];
}

/**
 * 装配默认工具集：AST、复杂度、密钥、离线依赖 advisory 检查与用户自定义规则。
 * @param options 复杂度阈值、自定义规则等工具参数
 * @returns 含默认工具的注册表
 */
export function buildDefaultRegistry(options?: {
  complexityThreshold?: number;
  customRules?: readonly CustomRule[];
}): ToolRegistry {
  const threshold = options?.complexityThreshold ?? DEFAULT_COMPLEXITY_THRESHOLD;
  const customRules = options?.customRules ?? [];
  const registry = new ToolRegistry();
  registry.register({
    name: 'ast_parse',
    description: 'Parse changed JS/TS files and detect syntax errors or empty catch blocks.',
    run: (context) => astFindings(context.files),
  });
  registry.register({
    name: 'complexity_check',
    description: 'List functions whose cyclomatic complexity exceeds the threshold.',
    run: (context) => complexityFindings(context.files, threshold),
  });
  registry.register({
    name: 'secret_scan',
    description: 'Detect hardcoded secrets and credentials in changed lines.',
    run: (context) => scanSecrets(context.files),
  });
  registry.register({
    name: 'dependency_scan',
    description: 'Check changed package manifests against the bundled offline advisory set.',
    run: (context) => dependencyFindings(context.files),
  });
  // 用户自定义规则：配置了启用规则才注册（否则 custom_rule_check 在 enabledTools 中为空操作）
  if (customRules.some((rule) => rule.enabled)) {
    registry.register({
      name: 'custom_rule_check',
      description: 'Apply user-defined custom review rules (regex) to changed lines, staged content and function snippets.',
      run: (context) => runCustomRules(context.files, customRules),
    });
  }
  return registry;
}
