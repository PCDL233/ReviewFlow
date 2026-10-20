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
import { ALL_ROUTE_PERMISSIONS } from '../../permissions';

type RoleFormValues = RoleInput;

export function AdminRolesPage(): ReactElement {
  const { message } = AntdApp.useApp();
  const { notifyError } = useNotify();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Role | null>(null);
  const [open, setOpen] = useState(false);
  const [form] = Form.useForm<RoleFormValues>();

  const rolesQuery = useQuery({ queryKey: ['admin', 'roles'], queryFn: fetchRoles });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'roles'] });
    void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
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
    form.setFieldsValue({ priority: 100, permissions: DEFAULT_PERMISSIONS });
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
      render: (_: unknown, record) => (
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
        width={520}
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
            rules={[{ required: true, message: '请至少选择一个权限' }]}
          >
            <Checkbox.Group style={{ width: '100%' }}>
              <Space orientation="vertical" style={{ width: '100%' }}>
                {ALL_ROUTE_PERMISSIONS.filter((p) => p.group === 'user').map((p) => (
                  <Checkbox key={p.path} value={p.path}>
                    {p.label}
                  </Checkbox>
                ))}
              </Space>
              <Typography.Text type="secondary" style={{ display: 'block', margin: '12px 0 6px' }}>
                管理后台
              </Typography.Text>
              <Space orientation="vertical" style={{ width: '100%' }}>
                {ALL_ROUTE_PERMISSIONS.filter((p) => p.group === 'admin').map((p) => (
                  <Checkbox key={p.path} value={p.path}>
                    {p.label}
                  </Checkbox>
                ))}
              </Space>
            </Checkbox.Group>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

const DEFAULT_PERMISSIONS = ['/', '/run', '/reviews', '/stats', '/profile'];
