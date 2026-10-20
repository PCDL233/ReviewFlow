import type { ReactElement } from 'react';
import { ArrowRightOutlined } from '@ant-design/icons';
import { Button, Card, Typography } from 'antd';
import type { ReviewStats } from '@ai-review/shared/api';
import type { Severity } from '@ai-review/shared';
import { CardHeading } from '../../components/PageHeader';
import { EmptyState } from '../../components/EmptyState';
import { formatNumber } from '../../format';

const SEVERITY_ROWS: Array<{ severity: Severity; label: string; color: string }> = [
  { severity: 'BLOCKER', label: '阻断问题', color: 'var(--severity-blocker)' },
  { severity: 'WARNING', label: '警告', color: 'var(--severity-warning)' },
  { severity: 'NIT', label: '改进建议', color: 'var(--severity-nit)' },
  { severity: 'PRAISE', label: '正向提示', color: 'var(--severity-praise)' },
];

export type QualitySnapshotProps = {
  stats: ReviewStats;
  onOpenStats: () => void;
};

/** 工作台右侧质量快照：严重度占比 + 误报回流，帮助快速判断近期质量走势。 */
export function QualitySnapshot(props: QualitySnapshotProps): ReactElement {
  const total = Math.max(1, props.stats.totalFindings);
  const hasFindings = props.stats.totalFindings > 0;

  return (
    <Card
      className="surface-card"
      title={<CardHeading title="质量快照" hint="全部审查" />}
      extra={
        <Button type="link" size="small" icon={<ArrowRightOutlined />} onClick={props.onOpenStats}>
          统计
        </Button>
      }
    >
      {hasFindings ? (
        <div className="home-quality">
          {SEVERITY_ROWS.map((row) => {
            const count =
              props.stats.severityDistribution.find((item) => item.severity === row.severity)
                ?.count ?? 0;
            const percent = Math.round((count / total) * 100);
            return (
              <div className="home-quality-row" key={row.severity}>
                <span className="home-quality-label">
                  <span
                    className="home-quality-dot"
                    style={{ background: row.color }}
                    aria-hidden="true"
                  />
                  {row.label}
                </span>
                <span className="home-quality-bar">
                  <span
                    className="home-quality-fill"
                    style={{ width: `${percent}%`, background: row.color }}
                  />
                </span>
                <span className="home-quality-value">{formatNumber(count)}</span>
              </div>
            );
          })}
          <div className="home-quality-foot">
            <span>
              已标记误报 <strong>{formatNumber(props.stats.falsePositiveCount)}</strong> 条
            </span>
            <Typography.Text type="secondary" style={{ fontSize: 10 }}>
              共 {formatNumber(props.stats.totalFindings)} 条发现
            </Typography.Text>
          </div>
        </div>
      ) : (
        <EmptyState
          title="还没有质量数据"
          description="发起第一次审查后，这里会展示严重度分布与误报回流。"
        />
      )}
    </Card>
  );
}
