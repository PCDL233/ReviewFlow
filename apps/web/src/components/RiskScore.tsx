import type { ReactElement } from 'react';
import { Progress } from 'antd';

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, score));
}

function riskTone(score: number): 'low' | 'medium' | 'high' {
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

const TONE_COLOR: Record<'low' | 'medium' | 'high', string> = {
  low: 'var(--success)',
  medium: 'var(--warning)',
  high: 'var(--error)',
};

export type RiskScoreProps = {
  score: number;
  /** 是否展示迷你进度条；表格中可关闭。 */
  showBar?: boolean;
  compact?: boolean;
};

/** 风险分：数字 + 分级色彩 + 可选进度条，统一 0–100 的视觉语义。 */
export function RiskScore(props: RiskScoreProps): ReactElement {
  const score = clampScore(props.score);
  const tone = riskTone(score);
  const display = Number.isInteger(score) ? score : score.toFixed(1);

  return (
    <span className={`risk-score risk-${tone}${props.compact ? ' risk-compact' : ''}`}>
      <span className="risk-score-value">
        {display}
        <span className="risk-score-suffix"> /100</span>
      </span>
      {props.showBar === false ? null : (
        <Progress
          className="risk-score-bar"
          percent={score}
          showInfo={false}
          size="small"
          strokeColor={TONE_COLOR[tone]}
          railColor="var(--line-soft)"
          aria-label={`风险评分 ${display} 分`}
        />
      )}
    </span>
  );
}
