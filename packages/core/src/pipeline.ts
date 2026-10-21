import { END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import type {
  BaseCheckpointSaver,
  CompiledStateGraph,
  StateDefinition,
} from '@langchain/langgraph';
import {
  HEAL_CONFIDENCE_THRESHOLD,
  MAX_HEAL_ROUNDS,
  createRunMetricsAccumulator,
  makeContextNode,
  makeHealNode,
  makeParseNode,
  makePlanNode,
  makeReportNode,
  makeReviewNode,
  makeStaticReviewNode,
  makeValidateNode,
} from './nodes.js';
import type { PipelineDeps, RunMetricsAccumulator } from './nodes.js';
import { reviewStateAnnotation } from './state.js';
import type { ReviewState } from './state.js';

export type { PipelineDeps } from './nodes.js';

/** 创建一次审查使用的检查点存储（同一 deps 重试时复用即可从上次节点续跑） */
export function createReviewCheckpointer(): BaseCheckpointSaver {
  return new MemorySaver();
}

/** 流水线节点名，与 SSE 进度事件（Dashboard 实时进度条）的 stage 值一一对应。
 * 规划节点名为 riskPlan：LangGraph 禁止节点名与状态字段（plan channel）同名。 */
export type PipelineNodeName =
  | 'parse'
  | 'riskPlan'
  | 'buildContext'
  | 'correctness'
  | 'security'
  | 'performance'
  | 'static'
  | 'validate'
  | 'heal'
  | 'report';

/** 编译后审查流水线图（泛型与 StateGraph compile 的推导一一对应：S/U 取注解的 State/Update，I/O 为状态定义，C 为类默认值） */
export type CompiledReviewPipeline = CompiledStateGraph<
  (typeof reviewStateAnnotation)['State'],
  (typeof reviewStateAnnotation)['Update'],
  typeof START | PipelineNodeName,
  (typeof reviewStateAnnotation)['spec'],
  (typeof reviewStateAnnotation)['spec'],
  StateDefinition
>;

/**
 * 交叉验证后的条件边（方案 3.9 routeAfterValidate）：
 * 存在置信度不足的 BLOCKER 且未达自愈轮次上限 → heal；否则 → report 收尾。
 */
export function routeAfterValidate(state: ReviewState): 'heal' | 'report' {
  const needsHeal = state.findings.some(
    (finding) =>
      finding.severity === 'BLOCKER' &&
      finding.confidence < HEAL_CONFIDENCE_THRESHOLD &&
      state.healRounds < MAX_HEAL_ROUNDS,
  );
  return needsHeal ? 'heal' : 'report';
}

/**
 * 装配 LangGraph 审查流水线（方案 3.9）：
 * parse → riskPlan → fan-out [correctness, security, performance + static] → validate
 * →（条件边）heal 自愈回退，上限 3 轮 → report。
 * 图结构保持固定（LangGraph 的编译期类型推导依赖静态节点集合）；
 * review.dimensions 的裁剪在 review 节点内短路（不调用 Provider，不产生 token 消耗），
 * 因此关闭某维度等价于从 fan-out 中移除该分支。
 * checkpointer 在每个 superstep 后保存状态快照，兑现"可审计原则"。
 * @param deps 流水线依赖（面向接口注入）
 * @returns 编译后的图（可 invoke / stream）
 */
export function buildPipeline(
  deps: PipelineDeps,
  runMetrics: RunMetricsAccumulator = createRunMetricsAccumulator(),
): CompiledReviewPipeline {
  return (
    new StateGraph(reviewStateAnnotation)
      .addNode('parse', makeParseNode(deps))
      .addNode('riskPlan', makePlanNode(deps, runMetrics))
      // 规模上限前置：先按风险分截断，再只对入选文件构建 AST/RAG 上下文
      .addNode('buildContext', makeContextNode(deps))
      .addNode('correctness', makeReviewNode('correctness', deps, runMetrics))
      .addNode('security', makeReviewNode('security', deps, runMetrics))
      .addNode('performance', makeReviewNode('performance', deps, runMetrics))
      .addNode('static', makeStaticReviewNode(deps))
      .addNode('validate', makeValidateNode())
      .addNode('heal', makeHealNode(deps, runMetrics))
      .addNode('report', makeReportNode(Date.now(), runMetrics))
      .addEdge(START, 'parse')
      .addEdge('parse', 'riskPlan')
      .addEdge('riskPlan', 'buildContext')
      // 静态优先：先产出确定性证据，再让三个维度带着证据并行审查（历史缺陷：并行时 LLM 看不到静态结论）
      .addEdge('buildContext', 'static')
      // fan-out：同一节点的多条出边即并行分支（LangGraph superstep 模型）
      .addEdge('static', 'correctness')
      .addEdge('static', 'security')
      .addEdge('static', 'performance')
      // fan-in：源数组表示汇聚点等待全部分支完成
      .addEdge(['correctness', 'security', 'performance'] as const, 'validate')
      .addConditionalEdges('validate', routeAfterValidate)
      .addEdge('heal', 'validate')
      .addEdge('report', END)
      .compile({ checkpointer: deps.checkpointer ?? new MemorySaver() })
  );
}

export type RunPipelineOptions = {
  /** 审查 ID：LangGraph thread_id，checkpoint 快照以此为键（可审计/断点恢复） */
  reviewId: string;
  signal?: AbortSignal | undefined;
  /** 节点级增量事件回调：直通 API Server 的 SSE → Dashboard 实时进度（方案 3.9） */
  onNodeUpdate?: ((node: string, update: unknown) => void) | undefined;
};

function isNamedNodeUpdate(entry: [string, unknown]): entry is [PipelineNodeName, unknown] {
  return (
    [
      'parse',
      'riskPlan',
      'buildContext',
      'correctness',
      'security',
      'performance',
      'static',
      'validate',
      'heal',
      'report',
    ] as const
  ).includes(entry[0] as PipelineNodeName);
}

function isStateSnapshot(value: unknown): value is ReviewState {
  return (
    typeof value === 'object' &&
    value !== null &&
    'context' in value &&
    'plan' in value &&
    'findings' in value &&
    'healRounds' in value &&
    'metrics' in value
  );
}

/**
 * 执行流水线并返回最终共享状态。
 * 以 ['updates', 'values'] 双模式流式执行：updates 提供节点级事件（SSE），
 * values 的最后一个快照即最终状态——与方案 3.9 的执行方式一致。
 * @throws {Error} 取消信号触发或流水线异常时透传
 */
export async function runReviewPipeline(
  deps: PipelineDeps,
  options: RunPipelineOptions,
): Promise<ReviewState> {
  const app = buildPipeline(deps);
  const eventStream = await app.stream(
    {},
    {
      configurable: { thread_id: options.reviewId },
      streamMode: ['updates', 'values'] as const,
      // exactOptionalPropertyTypes：signal 未提供时不得显式传 undefined
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  let finalState: ReviewState | undefined;
  for await (const chunk of eventStream) {
    if (Array.isArray(chunk) && chunk.length === 2) {
      const [mode, payload]: [unknown, unknown] = [chunk[0], chunk[1]];
      if (mode === 'values' && isStateSnapshot(payload)) {
        finalState = payload;
        continue;
      }
      if (
        mode === 'updates' &&
        options.onNodeUpdate !== undefined &&
        payload !== null &&
        typeof payload === 'object'
      ) {
        for (const entry of Object.entries(payload)) {
          if (isNamedNodeUpdate(entry)) options.onNodeUpdate(entry[0], entry[1]);
        }
      }
    }
  }

  if (finalState === undefined) {
    throw new Error('pipeline finished without producing a state snapshot');
  }
  return finalState;
}
