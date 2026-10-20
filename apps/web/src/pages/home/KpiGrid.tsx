import type { ReactElement } from 'react';
import {
  BugOutlined,
  ClockCircleOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Col, Row } from 'antd';
import type { ReviewStats } from '@ai-review/shared/api';
import { StatCard } from '../../components/StatCard';
import { formatDuration, formatNumber } from '../../format';

export function KpiGrid(props: { stats: ReviewStats | undefined; loading: boolean }): ReactElement {
  const stats = props.stats;
  const blockerCount =
    stats?.severityDistribution.find((item) => item.severity === 'BLOCKER')?.count ?? 0;
  const warningCount =
    stats?.severityDistribution.find((item) => item.severity === 'WARNING')?.count ?? 0;

  return (
    <Row gutter={[14, 14]} align="stretch">
      <Col xs={12} lg={6}>
        <StatCard
          title="发现总数"
          value={props.loading ? '—' : formatNumber(stats?.totalFindings ?? 0)}
          accent="indigo"
          icon={<BugOutlined />}
          loading={props.loading}
          caption="所有审查累计归档的问题"
        />
      </Col>
      <Col xs={12} lg={6}>
        <StatCard
          title="阻断项"
          value={props.loading ? '—' : formatNumber(blockerCount)}
          accent="rose"
          icon={<WarningOutlined />}
          loading={props.loading}
          caption={
            warningCount > 0 ? `另有 ${formatNumber(warningCount)} 条警告` : '当前没有新增阻断'
          }
        />
      </Col>
      <Col xs={12} lg={6}>
        <StatCard
          title="平均耗时"
          value={props.loading ? '—' : formatDuration(stats?.avgDurationMs ?? 0)}
          accent="teal"
          icon={<ClockCircleOutlined />}
          loading={props.loading}
          caption="从解析 Diff 到生成报告"
        />
      </Col>
      <Col xs={12} lg={6}>
        <StatCard
          title="Token 消耗"
          value={props.loading ? '—' : formatNumber(stats?.totalTokenUsed ?? 0)}
          accent="amber"
          icon={<ThunderboltOutlined />}
          loading={props.loading}
          caption="静态分析优先，减少无效调用"
        />
      </Col>
    </Row>
  );
}
