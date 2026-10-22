import { useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Button,
  Card,
  Col,
  Input,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { ReloadOutlined, ThunderboltOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { LlmCall, LlmCallListResponse, LlmRuntimeStatus } from '@ai-review/shared/api';
import { describeLlmStatus } from '@ai-review/shared/api';
import { fetchLlmCalls } from '../../api/admin';
import { CardHeading, PageHeader } from '../../components/PageHeader';
import { ErrorAlert } from '../../components/ErrorAlert';
import { EmptyState } from '../../components/EmptyState';
import { StatCard } from '../../components/StatCard';
import { formatDateTime, formatDuration, formatNumber } from '../../format';

type CallRow = LlmCallListResponse['calls'][number];
type Attempt = LlmCall['attempts'][number];

/** 运行时状态 → 中文标签与语义色（与 shared 的 describeLlmStatus 同一套口径）。 */
const STATUS_META: Record<LlmRuntimeStatus, { label: string; color: string }> = {
  ok: { label: '正常', color: 'success' },
  degraded: { label: '降级', color: 'warning' },
  mock: { label: 'Mock', color: 'default' },
  unavailable: { label: '不可用', color: 'error' },
};

const DIMENSION_LABELS: Record<string, string> = {
  correctness: '正确性',
  security: '安全性',
  performance: '性能',
  maintainability: '可维护性',
  heal: '自愈重审',
  summary: '变更概述',
};

function dimensionLabel(dimension: string): string {
  return DIMENSION_LABELS[dimension] ?? dimension;
}

/** 单次调用的降级链：每次尝试的服务商、模型、耗时与失败原因。 */
function AttemptTrail(props: { attempts: Attempt[]; fallbackUsed: boolean }): ReactElement {
  if (props.attempts.length === 0) {
    return (
      <Typography.Text type="secondary">
        未记录尝试明细（早期记录或 fixture 回放）。
      </Typography.Text>
    );
  }
  return (
    <Space orientation="vertical" size={6} style={{ width: '100%' }}>
      {props.attempts.map((attempt, index) => (
        <Space key={`${attempt.provider}-${attempt.model}-${String(index)}`} size={8} wrap>
          <Tag color={attempt.status === 'succeeded' ? 'success' : 'error'}>
            {attempt.status === 'succeeded' ? '成功' : '失败'}
          </Tag>
          <Typography.Text strong>
            {attempt.provider} / {attempt.model}
          </Typography.Text>
          <Typography.Text type="secondary">{attempt.kind}</Typography.Text>
          <Typography.Text type="secondary">{formatDuration(attempt.latencyMs)}</Typography.Text>
          {attempt.errorKind === undefined ? null : <Tag color="warning">{attempt.errorKind}</Tag>}
          {attempt.message === undefined ? null : (
            <Typography.Text type="secondary" ellipsis={{ tooltip: attempt.message }}>
              {attempt.message}
            </Typography.Text>
          )}
        </Space>
      ))}
      {props.fallbackUsed ? (
        <Typography.Text type="secondary">
          共尝试 {props.attempts.length} 次后由降级链给出结果。
        </Typography.Text>
      ) : null}
    </Space>
  );
}

/** 模型调用审计：回答“这次审查到底调了哪些模型、花了多少 token、有没有降级”。 */
export function AdminObservabilityPage(): ReactElement {
  const navigate = useNavigate();
  const [dimension, setDimension] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<LlmRuntimeStatus | undefined>(undefined);
  const [keyword, setKeyword] = useState('');

  const callsQuery = useQuery({
    queryKey: ['admin', 'llm-calls'],
    queryFn: () => fetchLlmCalls(200),
  });

  const calls = callsQuery.data ?? [];

  const dimensions = [...new Set(calls.map((call) => call.dimension))].sort();

  const keywordText = keyword.trim().toLowerCase();
  const filtered = calls.filter((call) => {
    if (dimension !== undefined && call.dimension !== dimension) return false;
    if (status !== undefined && call.status !== status) return false;
    if (keywordText === '') return true;
    return (
      call.provider.toLowerCase().includes(keywordText) ||
      call.model.toLowerCase().includes(keywordText) ||
      call.reviewId.toLowerCase().includes(keywordText)
    );
  });

  const totalTokens = filtered.reduce((sum, call) => sum + call.totalTokens, 0);
  const fallbackCount = filtered.filter((call) => call.fallbackUsed).length;
  const abnormalCount = filtered.filter((call) => call.status !== 'ok').length;

  const columns: ColumnsType<CallRow> = [
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 150,
      render: (value: string) => formatDateTime(value),
    },
    {
      title: '审查',
      dataIndex: 'reviewId',
      width: 190,
      render: (reviewId: string) => (
        <Button
          type="link"
          size="small"
          style={{ padding: 0, height: 'auto' }}
          onClick={() => void navigate({ to: '/reviews/$reviewId', params: { reviewId } })}
        >
          <Typography.Text code ellipsis style={{ maxWidth: 160 }}>
            {reviewId}
          </Typography.Text>
        </Button>
      ),
    },
    {
      title: '维度 / 轮次',
      key: 'dimension',
      width: 120,
      render: (_value, record) => (
        <Space size={4}>
          <Tag>{dimensionLabel(record.dimension)}</Tag>
          <Typography.Text type="secondary">#{record.round}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '服务商 / 模型',
      key: 'model',
      width: 210,
      render: (_value, record) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text>{record.provider}</Typography.Text>
          <Typography.Text type="secondary" ellipsis={{ tooltip: record.model }}>
            {record.model}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (value: LlmRuntimeStatus) => (
        <Tooltip title={describeLlmStatus(value)}>
          <Tag color={STATUS_META[value].color}>{STATUS_META[value].label}</Tag>
        </Tooltip>
      ),
    },
    {
      title: 'Token（输入 / 输出）',
      key: 'tokens',
      width: 170,
      align: 'right',
      render: (_value, record) => (
        <Space orientation="vertical" size={0} align="end">
          <span className="numeric-cell">
            {formatNumber(record.promptTokens)} / {formatNumber(record.completionTokens)}
          </span>
          <Typography.Text type="secondary" className="numeric-cell">
            共 {formatNumber(record.totalTokens)}
            {record.estimated ? '（估算）' : ''}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '耗时',
      dataIndex: 'latencyMs',
      width: 90,
      align: 'right',
      render: (value: number) => <span className="numeric-cell">{formatDuration(value)}</span>,
    },
    {
      title: '链路',
      dataIndex: 'fallbackUsed',
      width: 90,
      render: (fallback: boolean, record) =>
        fallback ? (
          <Tooltip title={`共 ${record.attempts.length} 次尝试`}>
            <Tag color="warning">降级</Tag>
          </Tooltip>
        ) : (
          <Tag>主模型</Tag>
        ),
    },
  ];

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin / Observability"
        title="模型调用审计"
        description="每次维度审查与自愈轮次的模型、用量、耗时与降级链；展开行可查看每次尝试的失败原因。"
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

      <Row gutter={[16, 16]}>
        <Col xs={12} lg={6}>
          <StatCard
            title="调用次数"
            value={formatNumber(filtered.length)}
            icon={<ThunderboltOutlined />}
            accent="indigo"
            hint={`共加载最近 ${calls.length} 条记录`}
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatCard
            title="Token 消耗"
            value={formatNumber(totalTokens)}
            icon={<ThunderboltOutlined />}
            accent="teal"
            hint="输入 + 输出，含估算值"
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatCard
            title="降级调用"
            value={formatNumber(fallbackCount)}
            icon={<ThunderboltOutlined />}
            accent={fallbackCount > 0 ? 'amber' : 'emerald'}
            hint={fallbackCount > 0 ? '主模型不可用，已走备用链路' : '全部由主模型完成'}
          />
        </Col>
        <Col xs={12} lg={6}>
          <StatCard
            title="非正常状态"
            value={formatNumber(abnormalCount)}
            icon={<ThunderboltOutlined />}
            accent={abnormalCount > 0 ? 'rose' : 'emerald'}
            hint="降级 / Mock / 不可用的调用数"
          />
        </Col>
      </Row>

      <Card className="surface-card data-table-card" title={<CardHeading title="最近调用明细" />}>
        <div className="table-toolbar">
          <Space wrap>
            <Select<string | undefined>
              allowClear
              placeholder="全部维度"
              value={dimension}
              onChange={(value) => setDimension(value)}
              style={{ width: 160 }}
              options={dimensions.map((item) => ({ value: item, label: dimensionLabel(item) }))}
            />
            <Select<LlmRuntimeStatus | undefined>
              allowClear
              placeholder="全部状态"
              value={status}
              onChange={(value) => setStatus(value)}
              style={{ width: 140 }}
              options={(Object.keys(STATUS_META) as LlmRuntimeStatus[]).map((item) => ({
                value: item,
                label: STATUS_META[item].label,
              }))}
            />
            <Input.Search
              allowClear
              placeholder="按审查 ID / 服务商 / 模型过滤"
              onChange={(event) => setKeyword(event.target.value)}
              style={{ width: 280 }}
            />
          </Space>
          <Typography.Text type="secondary">
            {filtered.length === calls.length
              ? `共 ${calls.length} 条`
              : `筛选出 ${filtered.length} / ${calls.length} 条`}
          </Typography.Text>
        </div>
        {callsQuery.isError ? (
          <ErrorAlert
            error={callsQuery.error}
            title="调用记录加载失败"
            onRetry={() => void callsQuery.refetch()}
          />
        ) : callsQuery.isPending ? (
          <Table<CallRow> loading columns={columns} dataSource={[]} rowKey="reviewId" />
        ) : calls.length === 0 ? (
          <EmptyState
            title="还没有调用记录"
            description="执行一次审查后，这里会显示每个维度的模型、token 与耗时。"
          />
        ) : filtered.length === 0 ? (
          <EmptyState
            title="没有匹配的调用记录"
            description="尝试放宽筛选条件，或清空后重新查看。"
            action={
              <Button
                onClick={() => {
                  setDimension(undefined);
                  setStatus(undefined);
                  setKeyword('');
                }}
              >
                清空筛选
              </Button>
            }
          />
        ) : (
          <Table<CallRow>
            rowKey={(record) =>
              `${record.reviewId}-${record.createdAt}-${record.dimension}-${String(record.round)}`
            }
            columns={columns}
            dataSource={filtered}
            expandable={{
              expandedRowRender: (record) => (
                <AttemptTrail attempts={record.attempts} fallbackUsed={record.fallbackUsed} />
              ),
              rowExpandable: (record) => record.attempts.length > 0,
            }}
            pagination={{
              pageSize: 20,
              showSizeChanger: false,
              showTotal: (total) => `共 ${total} 条`,
            }}
            scroll={{ x: 1180 }}
          />
        )}
      </Card>
    </div>
  );
}
