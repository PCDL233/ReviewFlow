import type { ReactElement, ReactNode } from 'react';
import { Card, Statistic } from 'antd';
import type { StatisticProps } from 'antd';

export type StatAccent = 'indigo' | 'teal' | 'amber' | 'rose' | 'emerald' | 'slate';

export type StatCardProps = {
  title: string;
  value: number | string;
  precision?: number;
  suffix?: ReactNode;
  prefix?: ReactNode;
  /** 数值下方的一句解释（与 caption 等价，命名更贴近业务用法）。 */
  hint?: ReactNode;
  caption?: ReactNode;
  icon?: ReactNode;
  accent?: StatAccent;
  loading?: boolean;
  formatter?: StatisticProps['formatter'];
};

/** 统一的指标卡：图标、主数值与一句解释，避免各页面重复拼 Card + Statistic。 */
export function StatCard(props: StatCardProps): ReactElement {
  const hint = props.hint ?? props.caption;
  return (
    <Card className={`surface-card stat-card accent-${props.accent ?? 'indigo'}`}>
      <div className="stat-card-head">
        <div className="stat-card-copy">
          <Statistic
            title={props.title}
            value={props.value}
            {...(props.precision === undefined ? {} : { precision: props.precision })}
            {...(props.suffix === undefined ? {} : { suffix: props.suffix })}
            {...(props.prefix === undefined ? {} : { prefix: props.prefix })}
            {...(props.formatter === undefined ? {} : { formatter: props.formatter })}
            loading={props.loading ?? false}
          />
        </div>
        {props.icon ? (
          <span className="stat-card-icon" aria-hidden="true">
            {props.icon}
          </span>
        ) : null}
      </div>
      {hint ? <div className="stat-caption">{hint}</div> : null}
    </Card>
  );
}
