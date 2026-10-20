import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  List,
  Popconfirm,
  Skeleton,
  Space,
  Statistic,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { DatabaseOutlined, ReloadOutlined } from '@ant-design/icons';
import type { KnowledgeStatus } from '@ai-review/shared/api';
import { fetchKnowledgeStatus, reindexKnowledge } from '../../api';
import { CardHeading, PageHeader } from '../../components/PageHeader';
import { ErrorAlert } from '../../components/ErrorAlert';
import { EmptyState } from '../../components/EmptyState';
import { useNotify } from '../../hooks/use-notify';
import { formatDateTime, formatNumber, formatRelativeTime } from '../../format';

const STATUS_META: Record<
  KnowledgeStatus['status'],
  { label: string; color: string; hint: string }
> = {
  disabled: {
    label: '已停用',
    color: 'default',
    hint: 'RAG 在系统配置中被关闭，审查不会检索知识库。',
  },
  idle: { label: '空闲', color: 'blue', hint: '索引已就绪，等待下一次检索。' },
  ready: { label: '就绪', color: 'green', hint: '索引可用，审查会注入相关文本块。' },
  running: { label: '索引中', color: 'processing', hint: '重建任务正在执行，完成后自动刷新。' },
  error: { label: '错误', color: 'red', hint: '上一次索引失败，请检查路径后重建。' },
};

/** 知识库管理：索引状态、路径列表与重建入口。 */
export function AdminKnowledgePage(): ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { notifyError } = useNotify();
  const statusQuery = useQuery({
    queryKey: ['admin-knowledge'],
    queryFn: fetchKnowledgeStatus,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 2000 : false),
  });
  const reindexMutation = useMutation({
    mutationFn: reindexKnowledge,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin-knowledge'] }),
    onError: (e) => notifyError(e, { title: '重建索引失败' }),
  });

  if (statusQuery.isPending) {
    return (
      <div className="page-stack">
        <PageHeader eyebrow="Admin / Knowledge base" title="知识库管理" />
        <Card className="surface-card">
          <Skeleton active paragraph={{ rows: 8 }} />
        </Card>
      </div>
    );
  }
  if (statusQuery.isError) {
    return (
      <div className="page-stack">
        <PageHeader eyebrow="Admin / Knowledge base" title="知识库管理" />
        <ErrorAlert
          error={statusQuery.error}
          title="知识库状态读取失败"
          onRetry={() => void statusQuery.refetch()}
        />
      </div>
    );
  }

  const status = statusQuery.data;
  const meta = STATUS_META[status.status];
  const indexing = status.status === 'running';

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin / Knowledge base"
        title="知识库管理"
        description="查看当前索引状态，并在文档或代码规范发生变化后重新构建 RAG 索引。"
        extra={
          <Space>
            <Button
              icon={<ReloadOutlined />}
              loading={statusQuery.isFetching}
              onClick={() => void statusQuery.refetch()}
            >
              刷新状态
            </Button>
            <Popconfirm
              title="重建 RAG 索引？"
              description="重建期间审查会跳过知识库检索，完成后自动恢复。"
              okText="开始重建"
              cancelText="取消"
              disabled={status.status === 'disabled'}
              onConfirm={() => reindexMutation.mutate()}
            >
              <Button
                type="primary"
                icon={<DatabaseOutlined />}
                loading={reindexMutation.isPending}
                disabled={status.status === 'disabled' || indexing}
              >
                {indexing ? '索引中…' : '重建索引'}
              </Button>
            </Popconfirm>
          </Space>
        }
      />
      <Card className="surface-card" title={<CardHeading title="索引概况" />}>
        <Space size="large" wrap className="knowledge-stats">
          <Statistic
            title="状态"
            valueRender={() => (
              <Tooltip title={meta.hint}>
                <Tag color={meta.color}>{meta.label}</Tag>
              </Tooltip>
            )}
          />
          <Statistic
            title="文本块"
            value={formatNumber(status.chunkCount)}
            prefix={<DatabaseOutlined />}
          />
          <Statistic title="知识库路径" value={status.paths.length} />
          <Statistic
            title="最后更新"
            valueRender={() =>
              status.lastIndexedAt === null ? (
                <span className="stat-card-value">尚未构建</span>
              ) : (
                <Tooltip title={formatDateTime(status.lastIndexedAt)}>
                  <span className="stat-card-value">
                    {formatRelativeTime(status.lastIndexedAt)}
                  </span>
                </Tooltip>
              )
            }
          />
        </Space>
        {indexing ? (
          <div className="knowledge-running" aria-live="polite">
            <Tag color="processing">索引中</Tag>
            正在重建索引，页面每 2 秒自动刷新状态。
          </div>
        ) : null}
        <Descriptions className="knowledge-meta" column={1} bordered size="small">
          <Descriptions.Item label="索引目录">
            <Typography.Text code>{status.indexDir}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="索引路径">
            {status.paths.length === 0 ? (
              <Typography.Text type="secondary">未配置</Typography.Text>
            ) : (
              status.paths.join('、')
            )}
          </Descriptions.Item>
        </Descriptions>
        {status.error !== null ? (
          <Alert className="knowledge-error" type="error" showIcon message={status.error} />
        ) : null}
        {status.status === 'disabled' ? (
          <Alert
            className="knowledge-error"
            type="info"
            showIcon
            title="RAG 知识库当前已停用"
            description="前往「系统配置」打开「包含 RAG 上下文」后，再回到本页重建索引。"
            action={
              <Button size="small" onClick={() => void navigate({ to: '/admin/config' })}>
                前往系统配置
              </Button>
            }
          />
        ) : null}
      </Card>
      <Card className="surface-card" title={<CardHeading title="配置的知识库路径" />}>
        {status.paths.length === 0 ? (
          <EmptyState
            title="暂无知识库路径"
            description="在「系统配置 → 知识库」中添加 docs/ 或规范目录，然后重建索引。"
            action={
              <Button onClick={() => void navigate({ to: '/admin/config' })}>添加路径</Button>
            }
          />
        ) : (
          <List
            className="knowledge-paths"
            dataSource={status.paths}
            renderItem={(path) => (
              <List.Item
                actions={[
                  <Typography.Text key="copy" copyable={{ text: path }} className="table-muted">
                    复制
                  </Typography.Text>,
                ]}
              >
                <Typography.Text code>{path}</Typography.Text>
              </List.Item>
            )}
          />
        )}
      </Card>
    </div>
  );
}
