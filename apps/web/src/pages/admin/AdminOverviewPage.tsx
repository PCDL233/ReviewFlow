import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Button,
  Card,
  Col,
  Empty,
  List,
  Progress,
  Row,
  Skeleton,
  Space,
  Tag,
  Typography,
} from 'antd';
import {
  AlertOutlined,
  FileSearchOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { fetchAdminOverview } from '../../api/admin';
import { CardHeading, PageHeader } from '../../components/PageHeader';
import { ErrorAlert } from '../../components/ErrorAlert';
import { StatCard } from '../../components/StatCard';
import { EmptyState } from '../../components/EmptyState';
import { formatDateTime, formatNumber, formatRelativeTime } from '../../format';

/** 系统概览：规模、健康度、缓存收益与最近失败任务。 */
export function AdminOverviewPage(): ReactElement {
  const navigate = useNavigate();
  const overviewQuery = useQuery({ queryKey: ['admin', 'overview'], queryFn: fetchAdminOverview });

  const header = (
    <PageHeader
      eyebrow="Admin overview"
      title="系统概览"
      description="从用户规模、审查吞吐与缓存效率三个维度了解平台运行状态。"
      extra={
        <Button
          icon={<ReloadOutlined />}
          loading={overviewQuery.isFetching}
          onClick={() => void overviewQuery.refetch()}
        >
          刷新
        </Button>
      }
    />
  );

  if (overviewQuery.isPending) {
    return (
      <div className="page-stack">
        {header}
        <Card className="surface-card">
          <Skeleton active paragraph={{ rows: 6 }} />
        </Card>
      </div>
    );
  }
  if (overviewQuery.isError) {
    return (
      <div className="page-stack">
        {header}
        <ErrorAlert
          error={overviewQuery.error}
          title="概览数据加载失败"
          onRetry={() => void overviewQuery.refetch()}
        />
      </div>
    );
  }

  const overview = overviewQuery.data;
  const reviewsLast7d = overview.riskTrend.reduce((sum, point) => sum + point.reviews, 0);
  const avgRisk =
    overview.riskTrend.length === 0
      ? 0
      : overview.riskTrend.reduce((sum, point) => sum + point.avgRiskScore, 0) /
        overview.riskTrend.length;

  return (
    <div className="page-stack">
      {header}
      <Row gutter={[16, 16]} align="stretch">
        <Col xs={12} lg={6}>
          <StatCard
            title="用户总数"
            value={formatNumber(overview.userCount)}
            icon={<TeamOutlined />}
            accent="indigo"
            hint={`其中管理员 ${overview.adminCount} 人`}
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatCard
            title="审查总数"
            value={formatNumber(overview.totalReviews)}
            icon={<FileSearchOutlined />}
            accent="teal"
            hint={`近 7 日 ${reviewsLast7d} 次`}
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatCard
            title="发现总数"
            value={formatNumber(overview.totalFindings)}
            icon={<AlertOutlined />}
            accent="amber"
            hint="全部审查累计"
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatCard
            title="失败率"
            value={(overview.failureRate * 100).toFixed(1)}
            suffix="%"
            icon={<SafetyCertificateOutlined />}
            accent={overview.failureRate > 0.2 ? 'rose' : 'emerald'}
            hint={overview.failureRate > 0.2 ? '高于 20%，建议排查模型服务' : '运行稳定'}
          />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card className="surface-card" title={<CardHeading title="近 7 日风险趋势" />}>
            <div className="overview-trend-head">
              <div>
                <div className="stat-card-label">日均风险分</div>
                <div className="stat-card-value">{avgRisk.toFixed(1)}</div>
              </div>
              <div>
                <div className="stat-card-label">审查次数</div>
                <div className="stat-card-value">{reviewsLast7d}</div>
              </div>
            </div>
            {overview.riskTrend.length === 0 ? (
              <EmptyState
                title="暂无趋势数据"
                description="近 7 日没有审查记录，趋势图会在首次审查后出现。"
              />
            ) : (
              <div className="overview-trend">
                {overview.riskTrend.map((point) => (
                  <div key={point.date} className="admin-trend-row">
                    <Typography.Text type="secondary">{point.date}</Typography.Text>
                    <Progress
                      percent={Math.round(point.avgRiskScore)}
                      size="small"
                      strokeColor={
                        point.avgRiskScore >= 70
                          ? 'var(--error)'
                          : point.avgRiskScore >= 40
                            ? 'var(--warning)'
                            : 'var(--success)'
                      }
                      format={() => `${point.reviews} 次`}
                    />
                  </div>
                ))}
              </div>
            )}
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card className="surface-card" title={<CardHeading title="最近失败审查" />}>
            {overview.recentFailures.length === 0 ? (
              <EmptyState title="暂无失败记录" description="所有审查均已完成，服务运行正常。" />
            ) : (
              <List
                size="small"
                dataSource={overview.recentFailures}
                renderItem={(failure) => (
                  <List.Item
                    actions={[
                      <Button
                        key="open"
                        type="link"
                        size="small"
                        onClick={() =>
                          void navigate({
                            to: '/reviews/$reviewId',
                            params: { reviewId: failure.reviewId },
                          })
                        }
                      >
                        查看
                      </Button>,
                    ]}
                  >
                    <List.Item.Meta
                      title={
                        <Typography.Text code ellipsis>
                          {failure.reviewId}
                        </Typography.Text>
                      }
                      description={
                        <Typography.Text
                          type="secondary"
                          ellipsis={{ tooltip: failure.errorMessage ?? '未记录失败原因' }}
                        >
                          {failure.errorMessage ?? '未记录失败原因'}
                        </Typography.Text>
                      }
                    />
                    <Tag color="error">{formatRelativeTime(failure.createdAt)}</Tag>
                  </List.Item>
                )}
              />
            )}
          </Card>
        </Col>
      </Row>

      <Card className="surface-card" title={<CardHeading title="资源与缓存" />}>
        <Row gutter={[16, 16]}>
          <Col xs={24} md={8}>
            <div className="stat-card-label">Token 消耗总量</div>
            <div className="stat-card-value">{formatNumber(overview.totalTokenUsed)}</div>
          </Col>
          <Col xs={24} md={8}>
            <div className="stat-card-label">缓存条目数</div>
            <div className="stat-card-value">{formatNumber(overview.cacheEntries)}</div>
          </Col>
          <Col xs={24} md={8}>
            <div className="stat-card-label">缓存节省 Token</div>
            <div className="stat-card-value">{formatNumber(overview.tokenSavedByCache)}</div>
          </Col>
        </Row>
        <Typography.Paragraph type="secondary" className="config-help">
          缓存命中可以减少重复分析成本，同时加快团队常见路径的反馈速度。
          {overview.totalTokenUsed > 0
            ? ` 当前节省比例约 ${Math.round(
                (overview.tokenSavedByCache /
                  (overview.totalTokenUsed + overview.tokenSavedByCache)) *
                  100,
              )}%。`
            : ''}
        </Typography.Paragraph>
        <div className="overview-cache-row">
          <ThunderboltOutlined className="overview-cache-icon" />
          <span>
            缓存按 agent + prompt 版本 + 代码内容哈希命中；修改审查提示词后缓存会自动失效。
          </span>
        </div>
      </Card>
      {overview.totalReviews === 0 ? (
        <Card className="surface-card">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Space orientation="vertical" size={2}>
                <Typography.Text strong>还没有任何审查记录</Typography.Text>
                <Typography.Text type="secondary">
                  前往「发起审查」运行第一次审查，概览数据会实时更新。
                </Typography.Text>
              </Space>
            }
          >
            <Button type="primary" onClick={() => void navigate({ to: '/run' })}>
              发起审查
            </Button>
          </Empty>
        </Card>
      ) : null}
      <Typography.Text type="secondary" className="table-muted">
        数据更新时间：{formatDateTime(new Date(overviewQuery.dataUpdatedAt).toISOString())}
      </Typography.Text>
    </div>
  );
}
