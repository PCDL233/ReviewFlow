import { useEffect, useRef, useState } from 'react';
import { ReviewStageEventSchema } from '@ai-review/shared/api';

/** 流水线节点 → 进度条步骤分组。 */
export const STAGE_GROUPS: ReadonlyArray<{
  key: string;
  label: string;
  stages: readonly string[];
}> = [
  { key: 'parse', label: '解析 diff', stages: ['parse'] },
  // 规模上限前置后新增 buildContext 节点；归入“风险规划”步骤，保持 5 步进度条不变
  { key: 'plan', label: '风险规划', stages: ['riskPlan', 'buildContext'] },
  {
    key: 'review',
    label: '并行审查',
    stages: ['correctness', 'security', 'performance', 'static'],
  },
  { key: 'validate', label: '交叉验证', stages: ['validate', 'heal'] },
  { key: 'report', label: '生成报告', stages: ['report'] },
];

/** 阶段名 → 步骤索引（未知阶段归入第一步，避免进度条越界）。 */
export function stageToStepIndex(stage: string): number {
  const index = STAGE_GROUPS.findIndex((group) => group.stages.includes(stage));
  return index === -1 ? 0 : index;
}

export type ConnectionState = 'connecting' | 'open' | 'error' | 'closed';

export type CompletedResult = { riskScore: number; blockerCount: number; blocking: boolean };

export type ReviewProgress = {
  step: number;
  currentStage: string | undefined;
  /** 最近一次阶段事件的明细（文件数、分流结果等）。 */
  detail: string | undefined;
  connection: ConnectionState;
  finished: boolean;
  failed: boolean;
  cancelled: boolean;
  message: string | undefined;
  result: CompletedResult | undefined;
};

const INITIAL_PROGRESS: ReviewProgress = {
  step: 0,
  currentStage: undefined,
  detail: undefined,
  connection: 'connecting',
  finished: false,
  failed: false,
  cancelled: false,
  message: undefined,
  result: undefined,
};

/** 由 SSE 事件推导的终态摘要（供进度面板文案使用）。 */
export function terminalLabel(progress: ReviewProgress): string {
  if (progress.cancelled) return '已取消';
  if (progress.failed) return '失败';
  if (progress.finished) return '已完成';
  return '进行中';
}

/**
 * 订阅审查进度 SSE。
 * 终态（completed/failed/cancelled）后主动关闭连接，避免服务端持续保活；
 * 坏帧（非 JSON 或不符合契约）忽略但不断流。
 */
export function useReviewEvents(
  reviewId: string | undefined,
  onFinish: (failed: boolean) => void,
): ReviewProgress {
  const [progress, setProgress] = useState<ReviewProgress>(INITIAL_PROGRESS);
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;

  useEffect(() => {
    if (reviewId === undefined) {
      setProgress(INITIAL_PROGRESS);
      return;
    }
    setProgress(INITIAL_PROGRESS);
    const source = new EventSource(`/api/reviews/${encodeURIComponent(reviewId)}/events`);
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      source.close();
    };

    source.onopen = () => {
      setProgress((current) => (current.finished ? current : { ...current, connection: 'open' }));
    };
    source.onerror = () => {
      if (closed) return;
      setProgress((current) =>
        current.finished
          ? { ...current, connection: 'closed' }
          : { ...current, connection: 'error' },
      );
    };

    const handleEvent = (event: Event): void => {
      if (!(event instanceof MessageEvent)) return;
      let rawPayload: unknown;
      try {
        rawPayload = JSON.parse(String(event.data)) as unknown;
      } catch {
        // SSE 可能被代理或旧服务写入非 JSON 数据；忽略坏帧，保持连接继续接收后续事件。
        return;
      }
      const parsed = ReviewStageEventSchema.safeParse(rawPayload);
      if (!parsed.success) return;
      const payload = parsed.data;

      if (payload.type === 'stage') {
        setProgress((current) => ({
          ...current,
          connection: 'open',
          currentStage: payload.stage,
          detail: payload.detail ?? current.detail,
          step: Math.max(current.step, stageToStepIndex(payload.stage)),
        }));
        return;
      }

      const failed = payload.type !== 'completed';
      if (payload.type === 'completed') {
        setProgress((current) => ({
          ...current,
          connection: 'closed',
          step: STAGE_GROUPS.length - 1,
          finished: true,
          result: {
            riskScore: payload.riskScore,
            blockerCount: payload.blockerCount,
            blocking: payload.blocking,
          },
        }));
      } else {
        setProgress((current) => ({
          ...current,
          connection: 'closed',
          finished: true,
          failed: payload.type === 'failed',
          cancelled: payload.type === 'cancelled',
          message: payload.message,
        }));
      }
      close();
      onFinishRef.current(failed);
    };

    for (const type of ['stage', 'completed', 'failed', 'cancelled']) {
      source.addEventListener(type, handleEvent);
    }
    return close;
  }, [reviewId]);

  return progress;
}
