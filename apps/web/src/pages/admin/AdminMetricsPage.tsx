import { useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Card,
  Col,
  Input,
  Row,
  Segmented,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { fetchMetricsText } from '../../api';
import { parseMetrics, summarizeMetrics, type MetricRow } from '../../lib/metrics';
import { CardHeading, PageHeader } from '../../components/PageHeader';
import { ErrorAlert } from '../../components/ErrorAlert';
import { CodeBlock } from '../../components/CodeBlock';
import { EmptyState } from '../../components/EmptyState';

type RefreshKey = 'off' | '5s' | '15s';

const REFRESH_INTERVAL_MS: Record<RefreshKey, number | false> = {
  off: false,
  '5s': 5000,
  '15s': 15000,
};

const TYPE_COLORS: Record<string, string> = {
  counter: 'blue',
  gauge: 'green',
  histogram: 'purple',
  summary: 'gold',
};

/** 系统指标：Prometheus 文本解析 + 搜索/自动刷新/原始文本。 */
export function AdminMetricsPage(): ReactElement {
  const [refresh, setRefresh] = useState<RefreshKey>('off');
  const [keyword, setKeyword] = useState('');
  const metricsQuery = useQuery({
    queryKey: ['admin', 'metrics'],
    queryFn: fetchMetricsText,
    refetchInterval: REFRESH_INTERVAL_MS[refresh],
  });

  if (metricsQuery.isError) {
    return (
      <div className="page-stack">
        <PageHeader
          eyebrow="Admin / Metrics"
          title="系统指标"
          description="实时查看 Prometheus 格式的系统运行指标。"
        />
        <ErrorAlert
          error={metricsQuery.error}
          title="指标加载失败"
          onRetry={() => void metricsQuery.refetch()}
        />
      </div>
    );
  }

  const metricsText = metricsQuery.data;
  const rows = metricsText === undefined ? [] : parseMetrics(metricsText);
  const summary = summarizeMetrics(rows);
  const keywordText = keyword.trim().toLowerCase();
  const filteredRows =
    keywordText === ''
      ? rows
      : rows.filter(
          (row) =>
            row.name.toLowerCase().includes(keywordText) ||
            row.help.toLowerCase().includes(keywordText),
        );

  const columns: ColumnsType<MetricRow> = [
    {
      title: '指标',
      dataIndex: 'name',
      width: 280,
      render: (name: string, record) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text code>{name}</Typography.Text>
          {record.help === '' ? null : (
            <Typography.Text type="secondary" className="metric-help">
              {record.help}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 110,
      render: (type: string) =>
        type === '' ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Tag color={TYPE_COLORS[type] ?? 'default'}>{type}</Tag>
        ),
    },
    {
      title: '标签',
      dataIndex: 'labels',
      render: (labels: Record<string, string>) => (
        <Space size={4} wrap>
          {Object.entries(labels).map(([key, value]) => (
            <Tag key={key}>
              {key}={value}
            </Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '数值',
      dataIndex: 'value',
      width: 150,
      render: (value: string) => <span className="numeric-cell">{value}</span>,
    },
  ];

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin / Metrics"
        title="系统指标"
        description="实时查看 Prometheus 格式的系统运行指标，包括审查量、发现数、Token 消耗与运行时数据。"
        extra={
          <Space wrap>
            <Segmented<RefreshKey>
              value={refresh}
              onChange={(value) => setRefresh(value)}
              options={[
                { label: '手动刷新', value: 'off' },
                { label: '每 5s', value: '5s' },
                { label: '每 15s', value: '15s' },
              ]}
            />
            <Button
              icon={<ReloadOutlined />}
              loading={metricsQuery.isFetching}
              onClick={() => void metricsQuery.refetch()}
            >
              立即刷新
            </Button>
          </Space>
        }
      />
      <Row gutter={[16, 16]}>
        <Col xs={12} md={6}>
          <Card className="surface-card stat-card accent-blue">
            <div className="stat-card-label">指标条数</div>
            <div className="stat-card-value">{rows.length}</div>
          </Card>
        </Col>
        {Array.from(summary.entries()).map(([type, count]) => (
          <Col key={type} xs={12} md={6}>
            <Card className="surface-card stat-card accent-teal">
              <div className="stat-card-label">{type}</div>
              <div className="stat-card-value">{count}</div>
            </Card>
          </Col>
        ))}
      </Row>
      <Card
        className="surface-card data-table-card"
        title={<CardHeading title="Prometheus 指标" />}
        extra={
          <Input.Search
            allowClear
            placeholder="按指标名或说明搜索"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            style={{ width: 260 }}
          />
        }
      >
        {metricsText === undefined ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : filteredRows.length === 0 ? (
          <EmptyState
            title={rows.length === 0 ? '暂无指标数据' : '没有匹配的指标'}
            description={
              rows.length === 0
                ? '服务尚未输出任何指标，或在配置中关闭了指标采集。'
                : '尝试调整搜索关键词，或清空搜索框查看全部指标。'
            }
            action={
              keyword !== '' ? <Button onClick={() => setKeyword('')}>清空搜索</Button> : undefined
            }
          />
        ) : (
          <Table<MetricRow>
            rowKey={(row) => `${row.name}${JSON.stringify(row.labels)}:${row.value}`}
            columns={columns}
            dataSource={filteredRows}
            pagination={{ pageSize: 20, showSizeChanger: true, showTotal: (t) => `共 ${t} 条` }}
            scroll={{ x: 800 }}
          />
        )}
      </Card>
      {metricsText !== undefined ? (
        <Card
          className="surface-card"
          title={<CardHeading title="原始文本" hint="Prometheus 文本格式" />}
        >
          <CodeBlock code={metricsText} title="metrics" maxHeight={360} showLineNumbers />
        </Card>
      ) : null}
    </div>
  );
}
