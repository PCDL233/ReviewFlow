import type { ReactElement } from 'react';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  App as AntdApp,
  Button,
  Card,
  Dropdown,
  Form,
  Input,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  MoreOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { ReviewListItem } from '@ai-review/shared/api';
import { deleteReview, fetchReviewPage, rerunReview } from '../api';
import { formatDateTime, formatDuration, formatRelativeTime } from '../format';
import { PageHeader } from '../components/PageHeader';
import { useAuth } from '../hooks/use-auth';
import { useNotify } from '../hooks/use-notify';
import { ErrorAlert } from '../components/ErrorAlert';
import { EmptyState } from '../components/EmptyState';
import { RiskScore } from '../components/RiskScore';
import { StatusTag } from '../components/StatusTag';
import {
  REVIEW_DEFAULT_PAGE_SIZE,
  REVIEW_PAGE_SIZES,
  hasActiveFilters,
  pageOf,
  pageSizeOf,
  withFilters,
} from '../lib/search-params';
import type { ReviewSearch } from '../lib/search-params';

export type ReviewListViewProps = {
  search: ReviewSearch;
  onSearchChange: (next: ReviewSearch) => void;
  onOpen: (reviewId: string) => void;
};

type FilterFormValues = {
  q?: string;
  repo?: string;
  branch?: string;
  status?: 'completed' | 'failed' | 'cancelled';
  mode?: 'fast' | 'full';
  severity?: 'BLOCKER' | 'WARNING' | 'NIT';
};

const FILTER_LABELS: Record<string, string> = {
  q: '关键词',
  repo: '仓库',
  branch: '分支',
  status: '状态',
  mode: '模式',
  severity: '严重度',
};

function activeFilterEntries(search: ReviewSearch): Array<{ key: string; label: string }> {
  const entries: Array<{ key: string; label: string }> = [];
  if (search.q !== undefined) entries.push({ key: 'q', label: `${FILTER_LABELS.q}：${search.q}` });
  if (search.repo !== undefined) {
    entries.push({ key: 'repo', label: `${FILTER_LABELS.repo}：${search.repo}` });
  }
  if (search.branch !== undefined) {
    entries.push({ key: 'branch', label: `${FILTER_LABELS.branch}：${search.branch}` });
  }
  if (search.status !== undefined) {
    const label =
      search.status === 'completed' ? '已完成' : search.status === 'failed' ? '失败' : '已取消';
    entries.push({ key: 'status', label: `${FILTER_LABELS.status}：${label}` });
  }
  if (search.mode !== undefined) {
    entries.push({ key: 'mode', label: `${FILTER_LABELS.mode}：${search.mode.toUpperCase()}` });
  }
  if (search.severity !== undefined) {
    entries.push({ key: 'severity', label: `${FILTER_LABELS.severity}：${search.severity}` });
  }
  return entries;
}

/** 审查历史：筛选与分页由 URL 驱动，支持刷新/后退/分享链接复现。 */
export function ReviewListView(props: ReviewListViewProps): ReactElement {
  const { message, modal } = AntdApp.useApp();
  const { notifyError } = useNotify();
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const search = props.search;
  const reviewsQuery = useQuery({
    queryKey: ['reviews', search],
    queryFn: () =>
      fetchReviewPage({
        ...(search.q === undefined ? {} : { q: search.q }),
        ...(search.status === undefined ? {} : { status: search.status }),
        ...(search.mode === undefined ? {} : { mode: search.mode }),
        ...(search.severity === undefined ? {} : { severity: search.severity }),
        ...(search.repo === undefined ? {} : { repo: search.repo }),
        ...(search.branch === undefined ? {} : { branch: search.branch }),
        page: pageOf(search),
        pageSize: pageSizeOf(search),
      }),
  });

  const rerunMutation = useMutation({
    mutationFn: (reviewId: string) => rerunReview(reviewId),
    onSuccess: (reviewId) => {
      void message.success(`已触发重新运行，新任务：${reviewId}`);
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
    },
    onError: (e) => notifyError(e, { title: '重跑失败' }),
  });
  const deleteMutation = useMutation({
    mutationFn: (reviewId: string) => deleteReview(reviewId),
    onSuccess: () => {
      void message.success('审查记录已删除');
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
    },
    onError: (e) => notifyError(e, { title: '删除失败' }),
  });

  const copyId = async (reviewId: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(reviewId);
      void message.success('审查 ID 已复制');
    } catch {
      void message.error('复制失败，请手动选择文本复制');
    }
  };

  const applyFilters = (values: FilterFormValues): void => {
    props.onSearchChange(
      withFilters(search, {
        q: values.q?.trim() || undefined,
        repo: values.repo?.trim() || undefined,
        branch: values.branch?.trim() || undefined,
        status: values.status,
        mode: values.mode,
        severity: values.severity,
      }),
    );
  };

  const clearFilters = (): void => {
    props.onSearchChange({});
  };

  const removeFilter = (key: string): void => {
    props.onSearchChange(withFilters(search, { [key]: undefined }));
  };

  const isAdmin = user?.role === 'admin';
  const filtersActive = hasActiveFilters(search);

  const columns: ColumnsType<ReviewListItem> = [
    {
      title: '审查 ID',
      dataIndex: 'reviewId',
      width: 240,
      render: (reviewId: string) => (
        <Space size={4} className="review-id-cell">
          <Button type="link" size="small" onClick={() => props.onOpen(reviewId)}>
            <Typography.Text code ellipsis className="review-id-text">
              {reviewId}
            </Typography.Text>
          </Button>
          <Tooltip title="复制审查 ID">
            <Button
              type="text"
              size="small"
              icon={<CopyOutlined />}
              aria-label={`复制审查 ID ${reviewId}`}
              onClick={() => void copyId(reviewId)}
            />
          </Tooltip>
        </Space>
      ),
    },
    {
      title: '仓库 / 分支',
      key: 'repo',
      width: 260,
      render: (_value, record) => (
        <Space orientation="vertical" size={0}>
          <Tooltip title={record.repoPath}>
            <Typography.Text ellipsis className="cell-primary">
              {record.repoPath}
            </Typography.Text>
          </Tooltip>
          <Typography.Text type="secondary" ellipsis className="cell-secondary">
            {record.branch}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: '模式',
      dataIndex: 'mode',
      width: 90,
      render: (mode: string) => (
        <Tag color={mode === 'full' ? 'blue' : 'default'}>{mode === 'full' ? 'FULL' : 'FAST'}</Tag>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (status: ReviewListItem['status']) => <StatusTag status={status} />,
    },
    {
      title: '风险分',
      dataIndex: 'riskScore',
      width: 150,
      sorter: (a, b) => a.riskScore - b.riskScore,
      render: (riskScore: number) => <RiskScore score={riskScore} compact />,
    },
    {
      title: '发现',
      key: 'findings',
      width: 220,
      render: (_value, record) => (
        <Space size={4} wrap>
          {record.blockerCount > 0 ? <Tag color="error">BLOCKER {record.blockerCount}</Tag> : null}
          {record.warningCount > 0 ? (
            <Tag color="warning">WARNING {record.warningCount}</Tag>
          ) : null}
          {record.nitCount > 0 ? <Tag color="processing">NIT {record.nitCount}</Tag> : null}
          {record.totalFindings === 0 ? <Tag color="success">无发现</Tag> : null}
        </Space>
      ),
    },
    {
      title: '耗时',
      dataIndex: 'durationMs',
      width: 100,
      render: (durationMs: number) => (
        <span className="numeric-cell">{formatDuration(durationMs)}</span>
      ),
    },
    {
      title: '时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (value: string) => (
        <Tooltip title={formatDateTime(value)}>{formatRelativeTime(value)}</Tooltip>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 60,
      fixed: 'right',
      align: 'center',
      render: (_value, record) => (
        <Dropdown
          trigger={['click']}
          menu={{
            items: [
              { key: 'open', label: '查看报告', icon: <PlayCircleOutlined /> },
              ...(isAdmin
                ? [
                    { key: 'rerun', label: '重新运行', icon: <ReloadOutlined /> },
                    { type: 'divider' as const },
                    { key: 'delete', label: '删除', icon: <DeleteOutlined />, danger: true },
                  ]
                : []),
            ],
            onClick: ({ key, domEvent }) => {
              domEvent.stopPropagation();
              if (key === 'open') props.onOpen(record.reviewId);
              if (key === 'rerun') rerunMutation.mutate(record.reviewId);
              if (key === 'delete') {
                void modal.confirm({
                  title: '确认删除该审查记录？',
                  content: '删除后不可恢复，相关发现与报告将一并移除。',
                  okText: '删除',
                  okButtonProps: { danger: true },
                  cancelText: '取消',
                  onOk: () => deleteMutation.mutate(record.reviewId),
                });
              }
            },
          }}
        >
          <Button
            type="text"
            icon={<MoreOutlined />}
            aria-label={`审查 ${record.reviewId} 的操作`}
          />
        </Dropdown>
      ),
    },
  ];

  const total = reviewsQuery.data?.total ?? 0;

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Review history"
        title="审查历史"
        description="集中查看审查任务、风险分数与发现分布，快速定位需要跟进的报告。"
        extra={
          <Space>
            <Button
              icon={<ReloadOutlined />}
              loading={reviewsQuery.isFetching}
              onClick={() => void reviewsQuery.refetch()}
            >
              刷新
            </Button>
            <Button type="primary" onClick={() => void navigate({ to: '/run' })}>
              发起审查
            </Button>
          </Space>
        }
      />

      <Card className="surface-card filter-card">
        <Form<FilterFormValues>
          layout="vertical"
          className="filter-form"
          initialValues={{
            ...(search.q === undefined ? {} : { q: search.q }),
            ...(search.repo === undefined ? {} : { repo: search.repo }),
            ...(search.branch === undefined ? {} : { branch: search.branch }),
            ...(search.status === undefined ? {} : { status: search.status }),
            ...(search.mode === undefined ? {} : { mode: search.mode }),
            ...(search.severity === undefined ? {} : { severity: search.severity }),
          }}
          onFinish={applyFilters}
        >
          <div className="filter-grid">
            <label className="filter-field filter-field-wide">
              <span className="filter-label">关键词</span>
              <Form.Item name="q" noStyle>
                <Input allowClear placeholder="搜索审查 ID、仓库路径或分支" />
              </Form.Item>
            </label>
            <label className="filter-field">
              <span className="filter-label">状态</span>
              <Form.Item name="status" noStyle>
                <Select
                  allowClear
                  placeholder="全部"
                  options={[
                    { value: 'completed', label: '已完成' },
                    { value: 'failed', label: '失败' },
                    { value: 'cancelled', label: '已取消' },
                  ]}
                />
              </Form.Item>
            </label>
            <label className="filter-field">
              <span className="filter-label">模式</span>
              <Form.Item name="mode" noStyle>
                <Select
                  allowClear
                  placeholder="全部"
                  options={[
                    { value: 'fast', label: 'Fast' },
                    { value: 'full', label: 'Full' },
                  ]}
                />
              </Form.Item>
            </label>
            {advancedOpen ? (
              <>
                <label className="filter-field">
                  <span className="filter-label">仓库包含</span>
                  <Form.Item name="repo" noStyle>
                    <Input allowClear placeholder="例如 git_review" />
                  </Form.Item>
                </label>
                <label className="filter-field">
                  <span className="filter-label">分支</span>
                  <Form.Item name="branch" noStyle>
                    <Input allowClear placeholder="例如 main" />
                  </Form.Item>
                </label>
                <label className="filter-field">
                  <span className="filter-label">严重度</span>
                  <Form.Item name="severity" noStyle>
                    <Select
                      allowClear
                      placeholder="全部"
                      options={[
                        { value: 'BLOCKER', label: 'BLOCKER' },
                        { value: 'WARNING', label: 'WARNING' },
                        { value: 'NIT', label: 'NIT' },
                      ]}
                    />
                  </Form.Item>
                </label>
              </>
            ) : null}
          </div>
          <div className="filter-actions">
            <Space wrap>
              <Button type="primary" htmlType="submit">
                应用筛选
              </Button>
              <Button onClick={clearFilters} disabled={!filtersActive}>
                重置
              </Button>
              <Button
                type="link"
                onClick={() => setAdvancedOpen((open) => !open)}
                icon={<DownOutlined rotate={advancedOpen ? 180 : 0} />}
              >
                {advancedOpen ? '收起更多筛选' : '更多筛选'}
              </Button>
            </Space>
            <Space size={6} wrap className="filter-tags">
              {activeFilterEntries(search).map((entry) => (
                <Tag
                  key={entry.key}
                  color="blue"
                  closable
                  onClose={(event) => {
                    event.preventDefault();
                    removeFilter(entry.key);
                  }}
                >
                  {entry.label}
                </Tag>
              ))}
            </Space>
          </div>
        </Form>
      </Card>

      <Card className="surface-card data-table-card">
        {reviewsQuery.isError ? (
          <ErrorAlert
            error={reviewsQuery.error}
            title="审查历史加载失败"
            onRetry={() => void reviewsQuery.refetch()}
          />
        ) : reviewsQuery.isPending ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : total === 0 ? (
          <EmptyState
            title={filtersActive ? '没有匹配的审查记录' : '还没有审查记录'}
            description={
              filtersActive
                ? '调整筛选条件，或清空后查看全部记录。'
                : '发起第一次代码审查，结果会自动出现在这里。'
            }
            action={
              filtersActive ? (
                <Button onClick={clearFilters}>清空筛选</Button>
              ) : (
                <Button type="primary" onClick={() => void navigate({ to: '/run' })}>
                  发起审查
                </Button>
              )
            }
          />
        ) : (
          <>
            <div className="table-summary">
              <Typography.Text type="secondary">
                共 {total} 条记录，当前第 {pageOf(search)} 页
              </Typography.Text>
            </div>
            <Table<ReviewListItem>
              rowKey="reviewId"
              columns={columns}
              dataSource={reviewsQuery.data.reviews}
              loading={reviewsQuery.isFetching}
              scroll={{ x: 1250 }}
              pagination={{
                current: pageOf(search),
                pageSize: pageSizeOf(search),
                total,
                showSizeChanger: true,
                pageSizeOptions: REVIEW_PAGE_SIZES.map((size) => String(size)),
                showTotal: (count) => `共 ${count} 条记录`,
                onChange: (nextPage, nextPageSize) => {
                  const sizeChanged = nextPageSize !== pageSizeOf(search);
                  props.onSearchChange({
                    ...search,
                    ...(sizeChanged || nextPage === 1 ? {} : { page: nextPage }),
                    ...(nextPageSize === REVIEW_DEFAULT_PAGE_SIZE
                      ? {}
                      : { pageSize: nextPageSize }),
                  });
                },
              }}
            />
          </>
        )}
      </Card>
    </div>
  );
}
