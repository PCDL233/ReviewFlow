import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { useState } from 'react';
import {
  App as AntdApp,
  Button,
  Card,
  Checkbox,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { PlusOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { Role, RoleInput } from '@ai-review/shared/api';
import { createRole, deleteRole, fetchRoles, updateRole } from '../../api/admin';
import { CardHeading, PageHeader } from '../../components/PageHeader';
import { ErrorAlert } from '../../components/ErrorAlert';
import { EmptyState } from '../../components/EmptyState';
import { useNotify } from '../../hooks/use-notify';
import { ALL_ROUTE_PERMISSIONS, DEFAULT_USER_PATHS, WILDCARD_PERMISSION } from '../../permissions';
import type { RoutePermission } from '../../permissions';
import { buildAdminMenu, isAdminMenuGroup } from '../../admin-menu';
import { ADMIN_ROLES_QUERY_KEY, ADMIN_USERS_QUERY_KEY } from '../../lib/query-keys';

type RoleFormValues = RoleInput;

export function AdminRolesPage(): ReactElement {
  const { message } = AntdApp.useApp();
  const { notifyError } = useNotify();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Role | null>(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<RoleFormValues>();

  const rolesQuery = useQuery({ queryKey: ADMIN_ROLES_QUERY_KEY, queryFn: fetchRoles });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ADMIN_ROLES_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ADMIN_USERS_QUERY_KEY });
    // 角色权限变更会影响用户的导航与页面可见性，刷新当前登录用户的认证态
    void queryClient.invalidateQueries({ queryKey: ['auth'] });
  };

  const saveMutation = useMutation({
    mutationFn: (values: RoleFormValues) =>
      editing === null ? createRole(values) : updateRole(editing.id, values),
    onSuccess: () => {
      void message.success(editing === null ? '角色已创建' : '角色已更新');
      setOpen(false);
      form.resetFields();
      setEditing(null);
      invalidate();
    },
    onError: (e) => notifyError(e, { title: '保存角色失败' }),
  });

  const deleteMutation = useMutation({
    mutationFn: (roleId: string) => deleteRole(roleId),
    onSuccess: () => {
      void message.success('角色已删除');
      invalidate();
    },
    onError: (e) => notifyError(e, { title: '删除角色失败' }),
  });

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ priority: 100, permissions: DEFAULT_USER_PATHS });
    setOpen(true);
  };

  const openEdit = (role: Role): void => {
    setEditing(role);
    form.setFieldsValue({
      name: role.name,
      description: role.description ?? undefined,
      priority: role.priority,
      permissions: role.permissions,
    });
    setOpen(true);
  };

  const columns: ColumnsType<Role> = [
    {
      title: '角色',
      dataIndex: 'name',
      width: 160,
      render: (name: string, record) => (
        <Space size={8}>
          <SafetyCertificateOutlined style={{ color: record.isSystem ? '#f59e0b' : '#4f46e5' }} />
          <Typography.Text strong>{name}</Typography.Text>
          {record.isSystem ? <Tag color="gold">内置</Tag> : null}
        </Space>
      ),
    },
    {
      title: '描述',
      dataIndex: 'description',
      ellipsis: true,
      render: (desc: string | null) => desc ?? '—',
    },
    {
      title: '优先级',
      dataIndex: 'priority',
      width: 100,
      render: (priority: number) => <Tag color="blue">#{priority}</Tag>,
    },
    {
      title: '权限数',
      key: 'permissionCount',
      width: 100,
      render: (_: unknown, record) =>
        record.permissions.includes(WILDCARD_PERMISSION) ? (
          <Tag color="purple">全部</Tag>
        ) : (
          <Typography.Text>{record.permissions.length}</Typography.Text>
        ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 160,
      fixed: 'right',
      render: (_, record) => (
        <Space size={8}>
          <Typography.Link onClick={() => openEdit(record)}>编辑</Typography.Link>
          {record.isSystem ? (
            <Typography.Text type="secondary">不可删</Typography.Text>
          ) : (
            <Popconfirm
              title="确认删除该角色？"
              description="删除后相关用户将失去该角色权限。"
              onConfirm={() => deleteMutation.mutate(record.id)}
            >
              <Typography.Link type="danger">删除</Typography.Link>
            </Popconfirm>
          )}
        </Space>
      ),
    },
  ];

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin / Roles"
        title="角色管理"
        description="权限即页面访问路径；多角色时按优先级取默认角色，权限取并集。"
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增角色
          </Button>
        }
      />
      {rolesQuery.isError ? (
        <ErrorAlert
          error={rolesQuery.error}
          title="角色列表加载失败"
          onRetry={() => void rolesQuery.refetch()}
        />
      ) : (
        <Card className="surface-card data-table-card">
          <div className="table-toolbar">
            <Typography.Text type="secondary">
              共 {rolesQuery.data?.length ?? 0} 个角色，权限即系统页面访问路径。
            </Typography.Text>
          </div>
          {!rolesQuery.isPending && (rolesQuery.data ?? []).length === 0 ? (
            <EmptyState
              title="还没有自定义角色"
              description="创建角色后可以为成员分配不同页面权限。"
              action={
                <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                  新增角色
                </Button>
              }
            />
          ) : (
            <Table<Role>
              rowKey="id"
              size="middle"
              loading={rolesQuery.isPending}
              columns={columns}
              dataSource={rolesQuery.data ?? []}
              scroll={{ x: 900 }}
              pagination={false}
            />
          )}
        </Card>
      )}

      <Modal
        title={<CardHeading title={editing === null ? '新增角色' : '编辑角色'} />}
        open={open}
        onOk={() => void form.submit()}
        confirmLoading={saveMutation.isPending}
        onCancel={() => {
          setOpen(false);
          setEditing(null);
          form.resetFields();
        }}
        okText="保存"
        cancelText="取消"
        width={660}
        rootClassName="role-modal"
        afterOpenChange={(isOpen) => {
          // 弹窗复用 DOM，重新打开时会保留上次的滚动位置，这里回到顶部。
          if (isOpen) {
            document
              .querySelector<HTMLElement>('.role-modal .ant-modal-body')
              ?.scrollTo({ top: 0 });
          }
        }}
      >
        <Form<RoleFormValues>
          form={form}
          layout="vertical"
          onFinish={(values) => saveMutation.mutate(values)}
          style={{ marginTop: 16 }}
        >
          <Form.Item
            label="角色名"
            name="name"
            rules={[{ required: true, message: '请输入角色名' }]}
          >
            <Input placeholder="例如：开发、审查员" maxLength={32} />
          </Form.Item>
          <Form.Item label="描述" name="description">
            <Input.TextArea placeholder="角色职责说明（可选）" rows={2} maxLength={200} />
          </Form.Item>
          <Form.Item
            label="优先级"
            name="priority"
            extra="数值越小优先级越高；多角色时默认取最高优先级角色。"
            rules={[{ required: true, message: '请输入优先级' }]}
          >
            <InputNumber min={1} max={999} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            label="页面访问权限"
            name="permissions"
            rules={[
              {
                validator: (_rule, value: string[] | undefined) =>
                  value !== undefined && value.length > 0
                    ? Promise.resolve()
                    : Promise.reject(new Error('请至少选择一个权限')),
              },
            ]}
            extra="持有「全部权限」等价于内置 admin 角色；否则按页面勾选，动态子页面（如审查报告详情）随父级自动放行。"
          >
            <Checkbox.Group className="role-permission-groups">
              <div className="permission-group permission-group-wide">
                <div className="permission-group-head">
                  <span className="permission-group-title">全部权限（内置管理员等价）</span>
                </div>
                <Checkbox value={WILDCARD_PERMISSION}>授予所有页面与操作权限</Checkbox>
              </div>
              {PERMISSION_GROUPS.map((group) => (
                <div key={group.title} className="permission-group">
                  <div className="permission-group-head">
                    <span className="permission-group-title">{group.title}</span>
                  </div>
                  <div className="permission-grid">
                    {group.items.map((item) => (
                      <Checkbox key={item.path} value={item.path}>
                        {item.label}
                      </Checkbox>
                    ))}
                  </div>
                </div>
              ))}
            </Checkbox.Group>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

/** 权限选择分组：用户端一组，管理后台直接复用侧栏菜单结构，避免两处维护导致漂移。 */
function permissionGroups(): Array<{ title: string; items: RoutePermission[] }> {
  const userItems = ALL_ROUTE_PERMISSIONS.filter((item) => item.group === 'user');
  const byPath = new Map(ALL_ROUTE_PERMISSIONS.map((item) => [item.path, item]));
  const groups: Array<{ title: string; items: RoutePermission[] }> = [
    { title: '用户端', items: userItems },
  ];
  for (const entry of buildAdminMenu([WILDCARD_PERMISSION])) {
    if (!isAdminMenuGroup(entry)) {
      const item = byPath.get(entry.key);
      if (item !== undefined) {
        groups.push({ title: `管理后台 · ${entry.label}`, items: [item] });
      }
      continue;
    }
    const items = entry.children.flatMap((child) => {
      const item = byPath.get(child.key);
      return item === undefined ? [] : [item];
    });
    if (items.length > 0) groups.push({ title: `管理后台 · ${entry.label}`, items });
  }
  return groups;
}

const PERMISSION_GROUPS = permissionGroups();
