import { useState } from 'react';
import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Card,
  DatePicker,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { Dayjs } from 'dayjs';
import type {
  LoginLog,
  LoginLogAction,
  OperationLog,
  OperationLogAction,
} from '@ai-review/shared/api';
import { fetchLoginLogs, fetchOperationLogs } from '../../api/admin';
import { formatDateTime } from '../../format';
import { CardHeading, PageHeader } from '../../components/PageHeader';
import { ErrorAlert } from '../../components/ErrorAlert';
import { EmptyState } from '../../components/EmptyState';

/** 登录事件动作 → 中文标签（与后端 LOGIN_LOG_ACTIONS 对齐） */
const LOGIN_ACTION_LABELS: Record<LoginLogAction, string> = {
  login: '登录',
  logout: '登出',
  register: '注册',
  change_password: '修改密码',
};

/** 操作动作 → 中文标签（与后端 OPERATION_LOG_ACTIONS 对齐） */
const OPERATION_ACTION_LABELS: Record<OperationLogAction, string> = {
  create: '创建',
  update: '更新',
  delete: '删除',
  login: '登录',
  logout: '登出',
  register: '注册',
  change_password: '修改密码',
  reset_password: '重置密码',
  assign_roles: '分配角色',
  start_review: '发起审查',
  rerun_review: '重跑审查',
  cancel_review: '取消审查',
  delete_review: '删除审查',
  mark_false_positive: '误报标记',
  save_config: '保存配置',
  save_rules: '保存规则',
  test_rules: '试跑规则',
  reindex_knowledge: '重建索引',
  install_hook: '安装 Hook',
  rotate_hook_token: '签发令牌',
  revoke_hook_token: '吊销令牌',
  run_hook_review: 'Hook 审查',
};

type LogKind = 'login' | 'operation';

/** 筛选值允许显式 undefined：用于清空某个条件（精确可选属性下不可写成 `field: undefined`）。 */
type Filters = {
  from?: string | undefined;
  to?: string | undefined;
  status?: 'success' | 'failed' | undefined;
  action?: string | undefined;
  q?: string | undefined;
};

/** 分页结果的判别联合：kind 决定 logs 的具体行类型，避免在渲染处做类型断言。 */
type LogPage =
  | { kind: 'login'; logs: LoginLog[]; total: number; page: number; pageSize: number }
  | { kind: 'operation'; logs: OperationLog[]; total: number; page: number; pageSize: number };

function statusTag(status: 'success' | 'failed'): ReactElement {
  return (
    <Tag color={status === 'success' ? 'green' : 'red'}>
      {status === 'success' ? '成功' : '失败'}
    </Tag>
  );
}

/** 单元格：过长内容省略并悬浮展示全文 */
function cellWithTooltip(text: string): ReactElement {
  if (text === '') return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <Tooltip title={text}>
      <Typography.Text style={{ maxWidth: 320 }} ellipsis>
        {text}
      </Typography.Text>
    </Tooltip>
  );
}

const LOGIN_COLUMNS: ColumnsType<LoginLog> = [
  { title: '时间', dataIndex: 'createdAt', width: 170, render: (v: string) => formatDateTime(v) },
  { title: '用户名', dataIndex: 'username', width: 160 },
  {
    title: '动作',
    dataIndex: 'action',
    width: 120,
    render: (action: LoginLogAction) => LOGIN_ACTION_LABELS[action],
  },
  {
    title: '结果',
    dataIndex: 'status',
    width: 90,
    render: (status: 'success' | 'failed') => statusTag(status),
  },
  {
    title: '原因',
    dataIndex: 'reason',
    width: 180,
    render: (reason: string | null) => cellWithTooltip(reason ?? ''),
  },
  { title: '来源 IP', dataIndex: 'ip', width: 140 },
  {
    title: 'User-Agent',
    dataIndex: 'userAgent',
    ellipsis: true,
    render: (ua: string) => cellWithTooltip(ua),
  },
];

const OPERATION_COLUMNS: ColumnsType<OperationLog> = [
  { title: '时间', dataIndex: 'createdAt', width: 170, render: (v: string) => formatDateTime(v) },
  { title: '操作者', dataIndex: 'username', width: 150 },
  {
    title: '动作',
    dataIndex: 'action',
    width: 120,
    render: (action: OperationLogAction) => OPERATION_ACTION_LABELS[action],
  },
  {
    title: '资源',
    key: 'resource',
    width: 200,
    render: (_, record) => (
      <Space size={4}>
        <Tag>{record.resource}</Tag>
        {record.resourceId === '' ? null : (
          <Typography.Text type="secondary" className="numeric-cell">
            {record.resourceId}
          </Typography.Text>
        )}
      </Space>
    ),
  },
  {
    title: '结果',
    dataIndex: 'status',
    width: 90,
    render: (status: 'success' | 'failed') => statusTag(status),
  },
  { title: '详情', dataIndex: 'detail', ellipsis: true, render: (d: string) => cellWithTooltip(d) },
  { title: '来源 IP', dataIndex: 'ip', width: 140 },
];

function baseQuery(
  page: number,
  pageSize: number,
  filters: Filters,
): {
  page: number;
  pageSize: number;
  from?: string;
  to?: string;
  status?: 'success' | 'failed';
  q?: string;
} {
  return {
    page,
    pageSize,
    ...(filters.from === undefined ? {} : { from: filters.from }),
    ...(filters.to === undefined ? {} : { to: filters.to }),
    ...(filters.status === undefined ? {} : { status: filters.status }),
    ...(filters.q === undefined ? {} : { q: filters.q }),
  };
}

function loginActionOf(action: string | undefined): LoginLogAction | undefined {
  return (Object.keys(LOGIN_ACTION_LABELS) as LoginLogAction[]).find(
    (candidate) => candidate === action,
  );
}

function operationActionOf(action: string | undefined): OperationLogAction | undefined {
  return (Object.keys(OPERATION_ACTION_LABELS) as OperationLogAction[]).find(
    (candidate) => candidate === action,
  );
}

/** 拉取日志：按 kind 分派到对应接口，并回传统一的页面模型。 */
async function loadLogs(
  kind: LogKind,
  page: number,
  pageSize: number,
  filters: Filters,
): Promise<LogPage> {
  if (kind === 'login') {
    const action = loginActionOf(filters.action);
    const result = await fetchLoginLogs({
      ...baseQuery(page, pageSize, filters),
      ...(action === undefined ? {} : { action }),
    });
    return { kind: 'login', ...result };
  }
  const action = operationActionOf(filters.action);
  const result = await fetchOperationLogs({
    ...baseQuery(page, pageSize, filters),
    ...(action === undefined ? {} : { action }),
  });
  return { kind: 'operation', ...result };
}

/**
 * 审计日志表格页（登录日志 / 操作日志共用）。
 * 支持日期范围、结果、动作与关键词筛选，服务端分页。
 */
export function LogListPage(props: { kind: LogKind }): ReactElement {
  const { kind } = props;
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [filters, setFilters] = useState<Filters>({});
  const [pending, setPending] = useState<Filters>({});
  const [range, setRange] = useState<[Dayjs | null, Dayjs | null] | null>(null);

  const query = useQuery({
    queryKey: ['admin', kind, 'logs', page, pageSize, filters],
    queryFn: () => loadLogs(kind, page, pageSize, filters),
    placeholderData: (previous) => previous,
  });

  const applyFilters = (): void => {
    setPage(1);
    setFilters(pending);
  };

  const resetFilters = (): void => {
    setRange(null);
    setPending({});
    setFilters({});
    setPage(1);
  };

  const actionOptions =
    kind === 'login'
      ? Object.entries(LOGIN_ACTION_LABELS).map(([value, label]) => ({ value, label }))
      : Object.entries(OPERATION_ACTION_LABELS).map(([value, label]) => ({ value, label }));

  const activeTags = [
    filters.from === undefined ? null : `日期 ${filters.from} ~ ${filters.to ?? '今天'}`,
    filters.status === undefined ? null : `结果 ${filters.status === 'success' ? '成功' : '失败'}`,
    filters.action === undefined ? null : `动作 ${filters.action}`,
    filters.q === undefined ? null : `关键词 ${filters.q}`,
  ].filter((tag): tag is string => tag !== null);

  const emptyContent = (
    <EmptyState
      title={activeTags.length === 0 ? '暂无审计日志' : '没有匹配的日志'}
      description={
        activeTags.length === 0
          ? '系统尚未记录任何事件，或日志功能已在配置中关闭。'
          : '放宽筛选条件，或清空后重新查询。'
      }
      action={
        activeTags.length === 0 ? undefined : <Button onClick={resetFilters}>清空筛选</Button>
      }
    />
  );

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin / Audit"
        title={kind === 'login' ? '登录日志' : '操作日志'}
        description={
          kind === 'login'
            ? '记录登录、登出、注册与改密事件，便于追踪异常访问。'
            : '记录管理端与审查相关的写操作，便于审计关键变更。'
        }
        extra={
          <Button onClick={() => void query.refetch()} loading={query.isFetching}>
            刷新
          </Button>
        }
      />
      <Card className="surface-card filter-card" title={<CardHeading title="筛选条件" />}>
        <div className="filter-grid">
          <label className="filter-field">
            <span className="filter-label">日期范围</span>
            <DatePicker.RangePicker
              value={range}
              onChange={(dates) => {
                setRange(dates ?? null);
                setPending((prev) => ({
                  ...prev,
                  from: dates?.[0]?.format('YYYY-MM-DD'),
                  to: dates?.[1]?.format('YYYY-MM-DD'),
                }));
              }}
              placeholder={['开始日期', '结束日期']}
            />
          </label>
          <label className="filter-field">
            <span className="filter-label">结果</span>
            <Select
              allowClear
              placeholder="全部"
              value={pending.status}
              onChange={(status?: 'success' | 'failed') =>
                setPending((prev) => ({ ...prev, status }))
              }
              options={[
                { value: 'success', label: '成功' },
                { value: 'failed', label: '失败' },
              ]}
            />
          </label>
          <label className="filter-field">
            <span className="filter-label">动作</span>
            <Select
              allowClear
              showSearch
              placeholder="全部"
              value={pending.action}
              onChange={(action?: string) => setPending((prev) => ({ ...prev, action }))}
              options={actionOptions}
            />
          </label>
          <label className="filter-field">
            <span className="filter-label">关键词</span>
            <Input.Search
              allowClear
              placeholder={kind === 'login' ? '按用户名搜索' : '按用户名/资源搜索'}
              onSearch={(value) => {
                const keyword = value.trim();
                setPending((prev) => ({
                  ...prev,
                  q: keyword === '' ? undefined : keyword,
                }));
              }}
            />
          </label>
        </div>
        <Space className="filter-actions">
          <Button type="primary" onClick={applyFilters}>
            查询
          </Button>
          <Button onClick={resetFilters}>重置</Button>
          {activeTags.length === 0 ? null : (
            <Space size={6} wrap className="filter-tags">
              {activeTags.map((tag) => (
                <Tag key={tag} color="blue">
                  {tag}
                </Tag>
              ))}
            </Space>
          )}
        </Space>
      </Card>
      <Card className="surface-card data-table-card">
        {query.isError ? (
          <ErrorAlert
            error={query.error}
            title="日志加载失败"
            onRetry={() => void query.refetch()}
          />
        ) : (query.data?.logs.length ?? 0) === 0 && !query.isPending ? (
          emptyContent
        ) : kind === 'login' ? (
          <Table<LoginLog>
            rowKey="id"
            size="middle"
            loading={query.isPending}
            columns={LOGIN_COLUMNS}
            dataSource={query.data?.kind === 'login' ? query.data.logs : []}
            scroll={{ x: 1100 }}
            pagination={{
              current: page,
              pageSize,
              total: query.data?.total ?? 0,
              showSizeChanger: true,
              showTotal: (total) => `共 ${total} 条`,
              onChange: (nextPage, nextSize) => {
                setPage(nextPage);
                setPageSize(nextSize);
              },
            }}
          />
        ) : (
          <Table<OperationLog>
            rowKey="id"
            size="middle"
            loading={query.isPending}
            columns={OPERATION_COLUMNS}
            dataSource={query.data?.kind === 'operation' ? query.data.logs : []}
            scroll={{ x: 1100 }}
            pagination={{
              current: page,
              pageSize,
              total: query.data?.total ?? 0,
              showSizeChanger: true,
              showTotal: (total) => `共 ${total} 条`,
              onChange: (nextPage, nextSize) => {
                setPage(nextPage);
                setPageSize(nextSize);
              },
            }}
          />
        )}
      </Card>
    </div>
  );
}

/** 登录日志页（管理后台） */
export function AdminLoginLogsPage(): ReactElement {
  return <LogListPage kind="login" />;
}

/** 操作日志页（管理后台） */
export function AdminOperationLogsPage(): ReactElement {
  return <LogListPage kind="operation" />;
}
