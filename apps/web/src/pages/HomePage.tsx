import { useNavigate } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Card, Col, Row } from 'antd';
import {
  BarChartOutlined,
  FileSearchOutlined,
  HistoryOutlined,
  PlayCircleOutlined,
} from '@ant-design/icons';
import { fetchReviewPage, fetchStats } from '../api';
import { useAuth } from '../hooks/use-auth';
import { formatNumber } from '../format';
import { CardHeading } from '../components/PageHeader';
import { LoadErrorState } from '../components/ErrorAlert';
import { EmptyState } from '../components/EmptyState';
import { WelcomePanel } from './home/WelcomePanel';
import { KpiGrid } from './home/KpiGrid';
import { RecentReviews } from './home/RecentReviews';
import { QualitySnapshot } from './home/QualitySnapshot';

const RECENT_LIMIT = 6;

/** 工作台：问候 + KPI + 最近审查 + 质量快照；首次使用给出三步引导。 */
export function HomePage(): ReactElement {
  const { user } = useAuth();
  const navigate = useNavigate();
  const statsQuery = useQuery({ queryKey: ['stats'], queryFn: () => fetchStats() });
  const reviewsQuery = useQuery({
    queryKey: ['reviews', 'recent', RECENT_LIMIT],
    queryFn: () => fetchReviewPage({ page: 1, pageSize: RECENT_LIMIT }),
  });

  const stats = statsQuery.data;
  const totalReviews = stats?.totalReviews ?? 0;
  const firstRun = !statsQuery.isPending && totalReviews === 0;

  return (
    <div className="page-stack">
      <WelcomePanel
        username={user?.username ?? '当前用户'}
        role={user?.role}
        totalReviews={totalReviews}
        avgRiskScore={stats?.avgRiskScore ?? 0}
        loading={statsQuery.isPending}
        onRun={() => void navigate({ to: '/run' })}
        onHistory={() => void navigate({ to: '/reviews' })}
      />

      {statsQuery.isError ? (
        <LoadErrorState
          error={statsQuery.error}
          title="统计数据加载失败"
          onRetry={() => void statsQuery.refetch()}
        />
      ) : (
        <KpiGrid stats={stats} loading={statsQuery.isPending} />
      )}

      {firstRun ? (
        <Card className="surface-card" title={<CardHeading title="开始使用 ReviewFlow" />}>
          <div className="onboarding-steps">
            <div className="onboarding-step">
              <span className="onboarding-index">01</span>
              <div>
                <div className="onboarding-title">配置模型</div>
                <p className="onboarding-desc">
                  在系统配置或 AI 模型页填写 Provider 与 API Key；未配置时自动回退到本地 Ollama 或
                  mock。
                </p>
              </div>
              <Button onClick={() => void navigate({ to: '/profile' })}>个人设置</Button>
            </div>
            <div className="onboarding-step">
              <span className="onboarding-index">02</span>
              <div>
                <div className="onboarding-title">发起一次审查</div>
                <p className="onboarding-desc">
                  填写仓库路径并选择 Fast / Full 模式，进度会通过 SSE 实时展示。
                </p>
              </div>
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                onClick={() => void navigate({ to: '/run' })}
              >
                发起审查
              </Button>
            </div>
            <div className="onboarding-step">
              <span className="onboarding-index">03</span>
              <div>
                <div className="onboarding-title">查看报告</div>
                <p className="onboarding-desc">
                  报告包含变更概述、发现列表、Diff 标注与改进建议，可导出 Markdown / HTML / JSON。
                </p>
              </div>
              <Button icon={<HistoryOutlined />} onClick={() => void navigate({ to: '/reviews' })}>
                审查历史
              </Button>
            </div>
          </div>
        </Card>
      ) : (
        <Row gutter={[16, 16]}>
          <Col xs={24} xl={16}>
            <RecentReviews
              reviews={reviewsQuery.data?.reviews}
              loading={reviewsQuery.isPending}
              error={reviewsQuery.isError ? reviewsQuery.error : undefined}
              onRetry={() => void reviewsQuery.refetch()}
              onOpen={(reviewId) =>
                void navigate({ to: '/reviews/$reviewId', params: { reviewId } })
              }
              onViewAll={() => void navigate({ to: '/reviews' })}
              onRun={() => void navigate({ to: '/run' })}
            />
          </Col>
          <Col xs={24} xl={8}>
            {statsQuery.isError ? (
              <Card className="surface-card">
                <EmptyState title="质量快照不可用" description="统计数据加载失败，请稍后重试。" />
              </Card>
            ) : stats === undefined ? (
              <Card className="surface-card" loading />
            ) : (
              <QualitySnapshot stats={stats} onOpenStats={() => void navigate({ to: '/stats' })} />
            )}
          </Col>
        </Row>
      )}

      <Card className="surface-card" title={<CardHeading title="快捷入口" />}>
        <Row gutter={[12, 12]}>
          <Col xs={24} sm={12} lg={6}>
            <Button
              block
              icon={<PlayCircleOutlined />}
              onClick={() => void navigate({ to: '/run' })}
            >
              发起新审查
            </Button>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Button
              block
              icon={<HistoryOutlined />}
              onClick={() => void navigate({ to: '/reviews' })}
            >
              浏览审查历史
            </Button>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Button
              block
              icon={<BarChartOutlined />}
              onClick={() => void navigate({ to: '/stats' })}
            >
              查看统计分析
            </Button>
          </Col>
          <Col xs={24} sm={12} lg={6}>
            <Button
              block
              icon={<FileSearchOutlined />}
              onClick={() => void navigate({ to: '/profile' })}
            >
              个人设置
            </Button>
          </Col>
        </Row>
        {stats === undefined ? null : (
          <p className="home-footnote">
            累计 {formatNumber(stats.totalReviews)} 次审查 · {formatNumber(stats.totalFindings)}{' '}
            条发现 · Token {formatNumber(stats.totalTokenUsed)}
          </p>
        )}
      </Card>
    </div>
  );
}
