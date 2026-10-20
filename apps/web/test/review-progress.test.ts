import { describe, expect, it } from 'vitest';
import { STAGE_GROUPS, stageToStepIndex, terminalLabel } from '../src/hooks/use-review-events';
import type { ReviewProgress } from '../src/hooks/use-review-events';

const BASE: ReviewProgress = {
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

describe('stageToStepIndex', () => {
  it('maps each pipeline stage to its step group', () => {
    expect(stageToStepIndex('parse')).toBe(0);
    expect(stageToStepIndex('riskPlan')).toBe(1);
    expect(stageToStepIndex('security')).toBe(2);
    expect(stageToStepIndex('static')).toBe(2);
    expect(stageToStepIndex('validate')).toBe(3);
    expect(stageToStepIndex('heal')).toBe(3);
    expect(stageToStepIndex('report')).toBe(4);
  });

  it('falls back to the first step for unknown stages', () => {
    expect(stageToStepIndex('unknown-stage')).toBe(0);
  });

  it('covers every declared stage exactly once', () => {
    const stages = STAGE_GROUPS.flatMap((group) => group.stages);
    expect(new Set(stages).size).toBe(stages.length);
    expect(STAGE_GROUPS).toHaveLength(5);
  });
});

describe('terminalLabel', () => {
  it('describes running state', () => {
    expect(terminalLabel(BASE)).toBe('进行中');
  });

  it('prioritises cancelled, then failed, then finished', () => {
    expect(terminalLabel({ ...BASE, cancelled: true, failed: true, finished: true })).toBe(
      '已取消',
    );
    expect(terminalLabel({ ...BASE, failed: true, finished: true })).toBe('失败');
    expect(terminalLabel({ ...BASE, finished: true })).toBe('已完成');
  });
});
