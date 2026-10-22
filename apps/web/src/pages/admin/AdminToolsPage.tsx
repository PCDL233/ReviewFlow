import { useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  InputNumber,
  Row,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ExperimentOutlined } from '@ant-design/icons';
import type { Finding } from '@ai-review/shared/api';
import { analyzeComplexity, scanSecrets } from '../../api';
import type { FunctionMetrics } from '../../api';
import { CardHeading, PageHeader } from '../../components/PageHeader';
import { ErrorAlert } from '../../components/ErrorAlert';
import { SeverityTag } from '../../components/SeverityTag';
import { useNotify } from '../../hooks/use-notify';

const SECRET_EXAMPLE = [
  'diff --git a/src/config.ts b/src/config.ts',
  '--- a/src/config.ts',
  '+++ b/src/config.ts',
  '@@ -1,2 +1,3 @@',
  '+const apiKey = "sk-live-1234567890abcdef";',
  '+const endpoint = "https://api.example.com";',
].join('\n');

const COMPLEXITY_EXAMPLE = `function handleOrder(order, user, options) {
  if (!order) return null;
  if (order.status === 'paid') {
    if (user.isAdmin) {
      return options?.force ? approve(order) : review(order);
    }
    for (const item of order.items) {
      if (item.refunded) continue;
      if (item.quantity > 1) console.log(item.id);
    }
  }
  return order;
}`;

/** 静态分析工具：密钥扫描与复杂度检查的在线试跑面板。 */
export function AdminToolsPage(): ReactElement {
  const { notifyError } = useNotify();
  const [diffText, setDiffText] = useState('');
  const [source, setSource] = useState('');
  const [threshold, setThreshold] = useState(15);
  const [secretError, setSecretError] = useState<string | undefined>(undefined);
  const [complexityError, setComplexityError] = useState<string | undefined>(undefined);

  const secretMutation = useMutation({
    mutationFn: () => scanSecrets(diffText),
    onError: (e) => notifyError(e, { title: '扫描失败' }),
  });
  const complexityMutation = useMutation({
    mutationFn: () => analyzeComplexity(source, threshold),
    onError: (e) => notifyError(e, { title: '检查失败' }),
  });

  const functionColumns: ColumnsType<FunctionMetrics> = [
    { title: '函数', dataIndex: 'name', width: 200 },
    {
      title: '行号',
      dataIndex: 'line',
      width: 100,
      render: (line: number, record) => (
        <span className="numeric-cell">
          {line}-{record.endLine}
        </span>
      ),
    },
    {
      title: '复杂度',
      dataIndex: 'complexity',
      width: 110,
      render: (value: number) => (
        <Tag color={value >= threshold * 2 ? 'error' : 'warning'}>{value}</Tag>
      ),
    },
    {
      title: '参数',
      dataIndex: 'params',
      render: (params: string[]) =>
        params.length === 0 ? (
          <Typography.Text type="secondary">—</Typography.Text>
        ) : (
          <Space size={4} wrap>
            {params.map((param) => (
              <Tag key={param}>{param}</Tag>
            ))}
          </Space>
        ),
    },
    {
      title: '异步',
      dataIndex: 'isAsync',
      width: 80,
      render: (isAsync: boolean) => (isAsync ? <Tag color="blue">async</Tag> : '—'),
    },
  ];

  const secretColumns: ColumnsType<Finding> = [
    {
      title: '严重度',
      dataIndex: 'severity',
      width: 110,
      render: (severity: Finding['severity']) => <SeverityTag severity={severity} />,
    },
    { title: '文件', dataIndex: 'filePath', width: 220, ellipsis: true },
    {
      title: '行号',
      dataIndex: 'lineStart',
      width: 90,
      render: (line: number) => <span className="numeric-cell">{line}</span>,
    },
    {
      title: '问题',
      dataIndex: 'title',
      render: (title: string, record) => (
        <Space orientation="vertical" size={2}>
          <Typography.Text strong>{title}</Typography.Text>
          {record.codeSnippet === undefined ? null : (
            <Typography.Text code className="finding-snippet">
              {record.codeSnippet}
            </Typography.Text>
          )}
        </Space>
      ),
    },
    {
      title: 'CWE',
      dataIndex: 'cweId',
      width: 110,
      render: (cweId: string | undefined) =>
        cweId === undefined ? '—' : <Tag color="volcano">{cweId}</Tag>,
    },
  ];

  const runSecretScan = (): void => {
    if (diffText.trim() === '') {
      setSecretError('请先粘贴要扫描的 diff 文本');
      return;
    }
    setSecretError(undefined);
    secretMutation.mutate();
  };

  const runComplexity = (): void => {
    if (source.trim() === '') {
      setComplexityError('请先粘贴要检查的源码');
      return;
    }
    setComplexityError(undefined);
    complexityMutation.mutate();
  };

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin / Tools"
        title="静态分析工具"
        description="直接调用内置静态分析工具，快速验证 diff 或源码片段的扫描结果；与审查流水线使用同一实现。"
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} xl={12}>
          <Card
            className="surface-card"
            title={<CardHeading title="密钥扫描" hint="只检查新增行" />}
            extra={
              <Button
                size="small"
                onClick={() => {
                  setDiffText(SECRET_EXAMPLE);
                  secretMutation.reset();
                }}
              >
                填入示例
              </Button>
            }
          >
            <Typography.Paragraph type="secondary" className="config-help">
              粘贴 unified diff 文本，工具只检查以 + 开头的新增行中的疑似密钥或凭证。
            </Typography.Paragraph>
            <Input.TextArea
              rows={9}
              value={diffText}
              onChange={(e) => setDiffText(e.target.value)}
              placeholder={'+ const apiKey = "sk-..."'}
              aria-label="待扫描的 diff 文本"
            />
            {secretError === undefined ? null : (
              <Alert className="knowledge-error" type="warning" showIcon title={secretError} />
            )}
            <Button
              className="tool-action"
              type="primary"
              icon={<ExperimentOutlined />}
              onClick={runSecretScan}
              loading={secretMutation.isPending}
            >
              扫描
            </Button>
            {secretMutation.isError ? (
              <ErrorAlert error={secretMutation.error} title="扫描失败" />
            ) : null}
            {secretMutation.data === undefined ? null : secretMutation.data.length === 0 ? (
              <Alert
                className="tool-result"
                type="success"
                showIcon
                title="未发现疑似密钥"
                description={`已扫描 ${diffText.split('\n').length} 行 diff。`}
              />
            ) : (
              <Table<Finding>
                className="tool-result"
                rowKey={(record) => `${record.filePath}:${record.lineStart}:${record.title}`}
                size="small"
                columns={secretColumns}
                dataSource={secretMutation.data}
                pagination={false}
                scroll={{ x: 620 }}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={12}>
          <Card
            className="surface-card"
            title={<CardHeading title="复杂度检查" hint="圈复杂度" />}
            extra={
              <Button
                size="small"
                onClick={() => {
                  setSource(COMPLEXITY_EXAMPLE);
                  complexityMutation.reset();
                }}
              >
                填入示例
              </Button>
            }
          >
            <Typography.Paragraph type="secondary" className="config-help">
              粘贴 TypeScript / JavaScript 源码，检查圈复杂度超过阈值的函数。
            </Typography.Paragraph>
            <Space align="center" className="tool-threshold">
              <Typography.Text type="secondary">阈值</Typography.Text>
              <InputNumber
                min={1}
                max={100}
                value={threshold}
                onChange={(value) => setThreshold(value ?? 15)}
                aria-label="复杂度阈值"
              />
              <Typography.Text type="secondary">默认 15，超过 2 倍阈值标红</Typography.Text>
            </Space>
            <Input.TextArea
              rows={9}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="function example() { ... }"
              aria-label="待检查的源码"
            />
            {complexityError === undefined ? null : (
              <Alert className="knowledge-error" type="warning" showIcon title={complexityError} />
            )}
            <Button
              className="tool-action"
              type="primary"
              icon={<ExperimentOutlined />}
              onClick={runComplexity}
              loading={complexityMutation.isPending}
            >
              检查
            </Button>
            {complexityMutation.isError ? (
              <ErrorAlert error={complexityMutation.error} title="检查失败" />
            ) : null}
            {complexityMutation.data === undefined ? null : complexityMutation.data.length === 0 ? (
              <Alert
                className="tool-result"
                type="success"
                showIcon
                title={`未发现复杂度超过 ${threshold} 的函数`}
              />
            ) : (
              <Table<FunctionMetrics>
                className="tool-result"
                rowKey={(row) => `${row.name}:${row.line}`}
                size="small"
                columns={functionColumns}
                dataSource={complexityMutation.data}
                pagination={false}
                scroll={{ x: 620 }}
              />
            )}
          </Card>
        </Col>
      </Row>
    </div>
  );
}
