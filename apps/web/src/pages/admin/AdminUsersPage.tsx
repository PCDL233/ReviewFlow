import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Dropdown,
  Form,
  Input,
  Modal,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  DeleteOutlined,
  KeyOutlined,
  MoreOutlined,
  PlusOutlined,
  SafetyCertificateOutlined,
  UserAddOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { AdminCreateUserInput, Role, User } from '@ai-review/shared/api';
import {
  assignRoles,
  createUser,
  deleteUser,
  fetchRoles,
  fetchUsers,
  patchUser,
  resetUserPassword,
} from '../../api/admin';
import { formatDateTime, formatRelativeTime } from '../../format';
import { useAuth, AUTH_QUERY_KEY } from '../../hooks/use-auth';
import { useNotify } from '../../hooks/use-notify';
import { UserAvatar } from '../../components/UserAvatar';
import { CardHeading, PageHeader } from '../../components/PageHeader';
import { ErrorAlert } from '../../components/ErrorAlert';
import { EmptyState } from '../../components/EmptyState';
import { ADMIN_ROLES_QUERY_KEY, ADMIN_USERS_QUERY_KEY } from '../../lib/query-keys';

const USERS_QUERY_KEY = ADMIN_USERS_QUERY_KEY;
const ROLES_QUERY_KEY = ADMIN_ROLES_QUERY_KEY;

type StatusFilter = 'all' | 'active' | 'disabled';

/** 用户管理（管理后台）：新增用户、角色调整、启用/禁用、重置密码、删除。 */
export function AdminUsersPage(): ReactElement {
  const { message, modal } = AntdApp.useApp();
  const { notifyError } = useNotify();
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [roleFilter, setRoleFilter] = useState<string | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm] = Form.useForm<AdminCreateUserInput>();
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignTarget, setAssignTarget] = useState<User | null>(null);
  const [assignForm] = Form.useForm<{ roleIds: string[] }>();

  const usersQuery = useQuery({ queryKey: USERS_QUERY_KEY, queryFn: fetchUsers });
  const rolesQuery = useQuery({ queryKey: ROLES_QUERY_KEY, queryFn: fetchRoles });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: USERS_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'overview'] });
  };

  const patchMutation = useMutation({
    mutationFn: (input: { userId: string; patch: Parameters<typeof patchUser>[1] }) =>
      patchUser(input.userId, input.patch),
    onSuccess: invalidate,
    onError: (e) => notifyError(e, { title: '状态更新失败' }),
  });

  const resetMutation = useMutation({
    mutationFn: (userId: string) => resetUserPassword(userId),
    onSuccess: (newPassword) => {
      void modal.success({
        title: '密码已重置',
        content: (
          <Space orientation="vertical">
            <Typography.Text type="secondary">
              新密码（仅显示一次，请立即转告该用户）：
            </Typography.Text>
            <Typography.Text copyable code style={{ fontSize: 16 }}>
              {newPassword}
            </Typography.Text>
          </Space>
        ),
      });
      invalidate();
    },
    onError: (e) => notifyError(e, { title: '重置密码失败' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (userId: string) => deleteUser(userId),
    onSuccess: () => {
      void message.success('用户已删除');
      invalidate();
    },
    onError: (e) => notifyError(e, { title: '删除用户失败' }),
  });

  const createMutation = useMutation({
    mutationFn: (input: AdminCreateUserInput) => createUser(input),
    onSuccess: () => {
      void message.success('用户已创建');
      setCreateOpen(false);
      createForm.resetFields();
      invalidate();
    },
    onError: (e) => notifyError(e, { title: '创建用户失败' }),
  });

  const openAssign = (record: User): void => {
    setAssignTarget(record);
    assignForm.setFieldsValue({ roleIds: record.roleIds });
    setAssignOpen(true);
  };

  const assignMutation = useMutation({
    mutationFn: ({ userId, roleIds }: { userId: string; roleIds: string[] }) =>
      assignRoles(userId, roleIds),
    onSuccess: (user) => {
      void message.success('角色已分配');
      setAssignOpen(false);
      setAssignTarget(null);
      invalidate();
      // 若分配的是当前登录用户，同步刷新本地认证态（导航权限即时生效）
      if (currentUser?.id === user.id) queryClient.setQueryData(AUTH_QUERY_KEY, user);
    },
    onError: (e) => notifyError(e, { title: '分配角色失败' }),
  });

  const keyword = search.trim().toLowerCase();
  const roleNames = new Map((rolesQuery.data ?? []).map((role) => [role.id, role.name]));
  const filteredUsers = (usersQuery.data ?? []).filter((user) => {
    if (
      keyword !== '' &&
      !user.username.toLowerCase().includes(keyword) &&
      !user.id.toLowerCase().includes(keyword)
    ) {
      return false;
    }
    if (statusFilter !== 'all' && user.status !== statusFilter) return false;
    if (roleFilter !== undefined && !user.roleIds.includes(roleFilter)) return false;
    return true;
  });

  const columns: ColumnsType<User> = [
    {
      title: '用户名',
      dataIndex: 'username',
      width: 200,
      render: (_value, record) => (
        <div className="user-cell">
          <UserAvatar user={record} className="table-avatar" />
          <div className="user-cell-body">
            <div className="user-cell-name">
              <Typography.Text strong ellipsis>
                {record.username}
              </Typography.Text>
              {record.id === currentUser?.id ? <Tag color="blue">当前账号</Tag> : null}
            </div>
            <Typography.Text
              type="secondary"
              className="numeric-cell"
              ellipsis={{ tooltip: record.id }}
            >
              {record.id}
            </Typography.Text>
          </div>
        </div>
      ),
    },
    {
      title: '角色',
      dataIndex: 'role',
      width: 170,
      render: (role: string, record) => (
        <Space size={4} wrap>
          <Tag color={role === 'admin' ? 'gold' : 'blue'}>
            {role === 'admin' ? '管理员' : '用户'}
          </Tag>
          {record.roleIds.map((roleId) => (
            <Tag key={roleId}>{roleNames.get(roleId) ?? roleId}</Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (status: string, record) =>
        record.id === currentUser?.id ? (
          <Tooltip title="当前登录账号不可被禁用">
            <Tag color="green">正常</Tag>
          </Tooltip>
        ) : (
          <Tooltip title={status === 'active' ? '点击禁用该用户' : '点击启用该用户'}>
            <Switch
              size="small"
              checked={status === 'active'}
              checkedChildren="正常"
              unCheckedChildren="禁用"
              loading={patchMutation.isPending && patchMutation.variables?.userId === record.id}
              onChange={(checked) =>
                patchMutation.mutate({
                  userId: record.id,
                  patch: { status: checked ? 'active' : 'disabled' },
                })
              }
            />
          </Tooltip>
        ),
    },
    {
      title: '注册时间',
      dataIndex: 'createdAt',
      width: 160,
      render: (value: string) => formatDateTime(value),
    },
    {
      title: '最近登录',
      dataIndex: 'lastLoginAt',
      width: 150,
      render: (lastLoginAt: string | null) =>
        lastLoginAt === null ? (
          <Typography.Text type="secondary">从未登录</Typography.Text>
        ) : (
          <Tooltip title={formatDateTime(lastLoginAt)}>{formatRelativeTime(lastLoginAt)}</Tooltip>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 90,
      fixed: 'right',
      align: 'center',
      render: (_value, record) =>
        record.id === currentUser?.id ? (
          <Tooltip title="当前登录账号不可被重置密码、删除或降级">
            <Typography.Text type="secondary">—</Typography.Text>
          </Tooltip>
        ) : (
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {
                  key: 'roles',
                  label: '分配角色',
                  icon: <SafetyCertificateOutlined />,
                },
                {
                  key: 'reset',
                  label: '重置密码',
                  icon: <KeyOutlined />,
                },
                { type: 'divider' },
                {
                  key: 'delete',
                  label: '删除用户',
                  icon: <DeleteOutlined />,
                  danger: true,
                },
              ],
              onClick: ({ key, domEvent }) => {
                domEvent.stopPropagation();
                if (key === 'roles') openAssign(record);
                if (key === 'reset') {
                  void modal.confirm({
                    title: `重置 ${record.username} 的密码？`,
                    content: '系统会生成一个随机新密码，旧密码立即失效。',
                    okText: '重置',
                    cancelText: '取消',
                    onOk: () => resetMutation.mutate(record.id),
                  });
                }
                if (key === 'delete') {
                  void modal.confirm({
                    title: `删除用户 ${record.username}？`,
                    content: '删除后该用户将无法登录，其历史审查记录保留。',
                    okText: '删除',
                    okButtonProps: { danger: true },
                    cancelText: '取消',
                    onOk: () => deleteMutation.mutate(record.id),
                  });
                }
              },
            }}
          >
            <Button
              type="text"
              icon={<MoreOutlined />}
              aria-label={`用户 ${record.username} 的操作`}
            />
          </Dropdown>
        ),
    },
  ];

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin / Users"
        title="用户管理"
        description="管理团队成员账号、角色分配与启停状态；当前登录账号不可被降级、禁用或删除。"
        extra={
          <Button type="primary" icon={<UserAddOutlined />} onClick={() => setCreateOpen(true)}>
            增加用户
          </Button>
        }
      />
      <Card className="surface-card data-table-card">
        <div className="table-toolbar">
          <Space wrap>
            <Input.Search
              allowClear
              placeholder="按用户名或用户 ID 搜索"
              onChange={(event) => setSearch(event.target.value)}
              style={{ width: 260 }}
            />
            <Select<StatusFilter>
              value={statusFilter}
              onChange={setStatusFilter}
              style={{ width: 130 }}
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'active', label: '正常' },
                { value: 'disabled', label: '已禁用' },
              ]}
            />
            <Select<string | undefined>
              allowClear
              placeholder="全部角色"
              value={roleFilter}
              onChange={(value) => setRoleFilter(value)}
              style={{ width: 160 }}
              options={(rolesQuery.data ?? []).map((role: Role) => ({
                value: role.id,
                label: role.name,
              }))}
            />
          </Space>
          <Typography.Text type="secondary">
            共 {filteredUsers.length} / {usersQuery.data?.length ?? 0} 个用户
          </Typography.Text>
        </div>
        {usersQuery.isError ? (
          <ErrorAlert
            error={usersQuery.error}
            title="用户列表加载失败"
            onRetry={() => void usersQuery.refetch()}
          />
        ) : !usersQuery.isPending && filteredUsers.length === 0 ? (
          <EmptyState
            title={keyword === '' ? '暂无用户' : '没有匹配的用户'}
            description={
              keyword === ''
                ? '创建第一个成员账号，或检查服务端初始化是否完成。'
                : '尝试更换关键词或清空筛选条件。'
            }
            action={
              keyword === '' ? (
                <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
                  增加用户
                </Button>
              ) : (
                <Button
                  onClick={() => {
                    setSearch('');
                    setStatusFilter('all');
                    setRoleFilter(undefined);
                  }}
                >
                  清空筛选
                </Button>
              )
            }
          />
        ) : (
          <Table<User>
            rowKey="id"
            size="middle"
            loading={usersQuery.isPending}
            columns={columns}
            dataSource={filteredUsers}
            rowClassName={(record) => (record.id === currentUser?.id ? 'table-row-current' : '')}
            scroll={{ x: 900 }}
            pagination={{
              pageSize: 10,
              showSizeChanger: false,
              showTotal: (total) => `共 ${total} 个用户`,
            }}
          />
        )}
      </Card>

      <Modal
        title={<CardHeading title="增加用户" />}
        open={createOpen}
        onOk={() => void createForm.submit()}
        confirmLoading={createMutation.isPending}
        onCancel={() => {
          setCreateOpen(false);
          createForm.resetFields();
        }}
        okText="保存"
        cancelText="取消"
      >
        <Form<AdminCreateUserInput>
          form={createForm}
          layout="vertical"
          onFinish={(values) => createMutation.mutate(values)}
          style={{ marginTop: 16 }}
        >
          <Form.Item
            label="用户名"
            name="username"
            rules={[
              { required: true, message: '请输入用户名' },
              { pattern: /^[a-zA-Z0-9_-]{3,32}$/, message: '3-32 位字母、数字、下划线或连字符' },
            ]}
          >
            <Input placeholder="3-32 位字母、数字或符号" prefix={<PlusOutlined />} />
          </Form.Item>
          <Form.Item
            label="初始密码"
            name="password"
            rules={[
              { required: true, message: '请输入初始密码' },
              { min: 8, message: '密码至少 8 位' },
            ]}
          >
            <Input.Password placeholder="至少 8 位" />
          </Form.Item>
          <Typography.Text type="secondary">
            新用户将以「普通用户」角色创建，创建后可在此页面调整其角色。
          </Typography.Text>
        </Form>
      </Modal>

      <Modal
        title={<CardHeading title={`分配角色：${assignTarget?.username ?? ''}`} />}
        open={assignOpen}
        onOk={() => void assignForm.submit()}
        confirmLoading={assignMutation.isPending}
        onCancel={() => {
          setAssignOpen(false);
          setAssignTarget(null);
          assignForm.resetFields();
        }}
        okText="保存"
        cancelText="取消"
      >
        <Form<{ roleIds: string[] }>
          form={assignForm}
          layout="vertical"
          onFinish={(values) => {
            if (assignTarget === null) return;
            assignMutation.mutate({ userId: assignTarget.id, roleIds: values.roleIds });
          }}
          style={{ marginTop: 16 }}
        >
          <Form.Item
            name="roleIds"
            rules={[{ required: true, message: '请至少选择一个角色' }]}
            extra="可多选角色，权限取并集；含 '*' 权限的角色会自动将该用户标记为管理员。"
          >
            <Checkbox.Group style={{ width: '100%' }}>
              {rolesQuery.isPending ? (
                <Skeleton active paragraph={{ rows: 4 }} title={false} />
              ) : (rolesQuery.data ?? []).length === 0 ? (
                <EmptyState
                  title="还没有可分配的角色"
                  description="先到「角色管理」创建一个角色，再回到这里分配。"
                />
              ) : (
                <Space orientation="vertical" style={{ width: '100%' }}>
                  {(rolesQuery.data ?? []).map((role: Role) => (
                    <Checkbox key={role.id} value={role.id}>
                      <Space size={6} wrap>
                        <SafetyCertificateOutlined
                          style={{ color: role.isSystem ? 'var(--warning)' : 'var(--brand)' }}
                        />
                        {role.name}
                        {role.isSystem ? <Tag color="gold">内置</Tag> : null}
                        {role.permissions.includes('*') ? <Tag color="purple">全部权限</Tag> : null}
                        <Typography.Text type="secondary">
                          优先级 #{role.priority} · {role.permissions.length} 项权限
                        </Typography.Text>
                      </Space>
                    </Checkbox>
                  ))}
                </Space>
              )}
            </Checkbox.Group>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
