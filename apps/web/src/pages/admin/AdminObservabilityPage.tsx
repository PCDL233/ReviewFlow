import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Button, Card, Space, Table, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { LlmCallListResponse } from '@ai-review/shared/api';
import { fetchLlmCalls } from '../../api/admin';
import { CardHeading, PageHeader } from '../../components/PageHeader';
import { ErrorAlert } from '../../components/ErrorAlert';
import { EmptyState } from '../../components/EmptyState';
import { formatDateTime, formatDuration } from '../../format';

type CallRow = LlmCallListResponse['calls'][number];

const STATUS_COLORS: Record<string, string> = {
  ok: 'success',
  degraded: 'warning',
  mock: 'default',
  unavailable: 'error',
};

/** 模型调用审计：回答“这次审查到底调了哪些模型、花了多少 token、有没有降级”。 */
export function AdminObservabilityPage(): ReactElement {
  const navigate = useNavigate();
  const callsQuery = useQuery({
    queryKey: ['admin-llm-calls'],
    queryFn: () => fetchLlmCalls(200),
  });

  const columns: ColumnsType<CallRow> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (value: string) => formatDateTime(value),
    },
    {
      title: '审查',
      dataIndex: 'reviewId',
      width: 220,
      render: (reviewId: string) => (
        <Button
          type="link"
          size="small"
          onClick={() => void navigate({ to: '/reviews/$reviewId', params: { reviewId } })}
        >
          <Typography.Text code ellipsis>
            {reviewId}
          </Typography.Text>
        </Button>
      ),
    },
    {
      title: '维度 / 轮次',
      key: 'dimension',
      width: 130,
      render: (_value, record) => (
        <Space size={4}>
          <Tag>{record.dimension}</Tag>
          <Typography.Text type="secondary">#{record.round}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '服务商 / 模型',
      key: 'model',
      width: 220,
      render: (_value, record) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text>{record.provider}</Typography.Text>
          <Typography.Text type="secondary" ellipsis style={{ maxWidth: 200 }}>
            {record.model}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (status: string) => <Tag color={STATUS_COLORS[status] ?? 'default'}>{status}</Tag>,
    },
    {
      title: 'Token（输入/输出）',
      key: 'tokens',
      width: 160,
      render: (_value, record) => (
        <Space orientation="vertical" size={0}>
          <span>
            {record.promptTokens} / {record.completionTokens}
          </span>
          <Typography.Text type="secondary">
            共 {record.totalTokens}
            {record.estimated ? '（估算）' : ''}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '耗时',
      dataIndex: 'latencyMs',
      width: 100,
      render: (value: number) => formatDuration(value),
    },
    {
      title: '降级',
      dataIndex: 'fallbackUsed',
      width: 90,
      render: (fallback: boolean) =>
        fallback ? <Tag color="warning">降级</Tag> : <Tag>主模型</Tag>,
    },
  ];

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Observability"
        title="模型调用审计"
        description="每次维度审查与自愈轮次的模型、用量、耗时与降级链。"
        extra={
          <Button
            icon={<ReloadOutlined />}
            loading={callsQuery.isFetching}
            onClick={() => void callsQuery.refetch()}
          >
            刷新
          </Button>
        }
      />

      <Card className="surface-card" title={<CardHeading title="最近 200 次调用" />}>
        {callsQuery.isError ? (
          <ErrorAlert
            error={callsQuery.error}
            title="调用记录加载失败"
            onRetry={() => void callsQuery.refetch()}
          />
        ) : callsQuery.data === undefined ? (
          <Table<CallRow>
            loading
            columns={columns}
            dataSource={[]}
            rowKey="id"
            pagination={false}
          />
        ) : callsQuery.data.length === 0 ? (
          <EmptyState
            title="还没有调用记录"
            description="执行一次审查后，这里会显示每个维度的模型、token 与耗时。"
          />
        ) : (
          <Table<CallRow>
            rowKey={(record) =>
              `${record.reviewId}-${record.createdAt}-${record.dimension}-${record.round}`
            }
            columns={columns}
            dataSource={callsQuery.data}
            pagination={{ pageSize: 20, showSizeChanger: false }}
            scroll={{ x: 1200 }}
          />
        )}
      </Card>
    </div>
  );
}
