import type { ReactElement } from 'react';
import { ArrowRightOutlined, HistoryOutlined } from '@ant-design/icons';
import { Button, Card, Table, Tooltip, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ReviewListItem } from '@ai-review/shared/api';
import { CardHeading } from '../../components/PageHeader';
import { EmptyState } from '../../components/EmptyState';
import { ErrorAlert } from '../../components/ErrorAlert';
import { RiskScore } from '../../components/RiskScore';
import { StatusTag } from '../../components/StatusTag';
import { formatDateTime, formatRelativeTime } from '../../format';

export type RecentReviewsProps = {
  reviews: ReviewListItem[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  onOpen: (reviewId: string) => void;
  onViewAll: () => void;
  onRun: () => void;
};

function severitySummary(record: ReviewListItem): ReactElement {
  if (record.totalFindings === 0) {
    return <span className="table-muted">无发现</span>;
  }
  return (
    <span className="severity-counts">
      {record.blockerCount > 0 ? (
        <span className="severity-count severity-count-blocker">B {record.blockerCount}</span>
      ) : null}
      {record.warningCount > 0 ? (
        <span className="severity-count severity-count-warning">W {record.warningCount}</span>
      ) : null}
      {record.nitCount > 0 ? (
        <span className="severity-count severity-count-nit">N {record.nitCount}</span>
      ) : null}
    </span>
  );
}

function buildColumns(onOpen: (reviewId: string) => void): ColumnsType<ReviewListItem> {
  return [
    {
      title: '审查',
      dataIndex: 'reviewId',
      width: 190,
      render: (reviewId: string, record) => (
        <div className="repo-cell">
          <Typography.Link className="review-id" onClick={() => onOpen(reviewId)}>
            {reviewId}
          </Typography.Link>
          <span className="repo-cell-branch">{record.branch}</span>
        </div>
      ),
    },
    {
      title: '仓库',
      dataIndex: 'repoPath',
      ellipsis: true,
      render: (repoPath: string) => (
        <Tooltip title={repoPath}>
          <span className="repo-cell-path">{repoPath}</span>
        </Tooltip>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 92,
      render: (status: ReviewListItem['status']) => <StatusTag status={status} />,
    },
    {
      title: '风险',
      dataIndex: 'riskScore',
      width: 120,
      render: (riskScore: number) => <RiskScore score={riskScore} />,
    },
    {
      title: '发现',
      dataIndex: 'totalFindings',
      width: 106,
      render: (_: number, record) => severitySummary(record),
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 104,
      render: (createdAt: string) => (
        <Tooltip title={formatDateTime(createdAt)}>
          <span className="table-muted">{formatRelativeTime(createdAt)}</span>
        </Tooltip>
      ),
    },
  ];
}

/** 工作台最近审查：只保留判断所需的列，完整筛选与操作交给历史页。 */
export function RecentReviews(props: RecentReviewsProps): ReactElement {
  return (
    <Card
      className="surface-card data-table-card"
      title={<CardHeading title="最近审查" hint="按时间倒序" />}
      extra={
        <Button type="link" size="small" icon={<ArrowRightOutlined />} onClick={props.onViewAll}>
          查看全部
        </Button>
      }
    >
      {props.error ? (
        <ErrorAlert error={props.error} title="最近审查加载失败" onRetry={props.onRetry} />
      ) : (
        <Table<ReviewListItem>
          rowKey="reviewId"
          size="middle"
          columns={buildColumns(props.onOpen)}
          dataSource={props.reviews ?? []}
          loading={props.loading}
          pagination={false}
          scroll={{ x: 720 }}
          locale={{
            emptyText: (
              <EmptyState
                title="还没有审查记录"
                description="发起一次审查后，最近结果会出现在这里。"
                action={
                  <Button type="primary" icon={<HistoryOutlined />} onClick={props.onRun}>
                    发起第一次审查
                  </Button>
                }
              />
            ),
          }}
        />
      )}
    </Card>
  );
}
