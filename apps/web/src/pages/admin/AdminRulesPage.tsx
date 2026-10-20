import { useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  App as AntdApp,
  Alert,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { ExperimentOutlined, PlusOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { CustomRule, CustomRuleTestResult } from '@ai-review/shared/api';
import { CustomRuleSchema } from '@ai-review/shared/api';
import { fetchCustomRules, testCustomRule, updateCustomRules } from '../../api/admin';
import { CardHeading, PageHeader } from '../../components/PageHeader';
import { EmptyState } from '../../components/EmptyState';
import { ErrorAlert } from '../../components/ErrorAlert';
import { useNotify } from '../../hooks/use-notify';

const SCOPE_LABELS: Record<string, string> = {
  added: '新增行',
  staged: '文件全文',
  snippet: '函数片段',
};

const SEVERITY_COLORS: Record<CustomRule['severity'], string> = {
  BLOCKER: 'error',
  WARNING: 'warning',
  NIT: 'default',
};

/** 表单校验：正则表达式必须可编译 */
function validatePattern(_: unknown, value: string | undefined): Promise<void> {
  if (value === undefined || value === '') return Promise.resolve();
  try {
    new RegExp(value);
    return Promise.resolve();
  } catch {
    return Promise.reject(new Error('正则表达式无法编译'));
  }
}

/** 表单校验：正则 flag 仅允许 JS 支持的子集 */
function validateFlags(_: unknown, value: string | undefined): Promise<void> {
  if (value === undefined || value === '') return Promise.resolve();
  if (/^[dgimsuvy]*$/.test(value) && value.length <= 8) return Promise.resolve();
  return Promise.reject(new Error('仅允许 dgimsuvy 且不超过 8 个字符'));
}

export function AdminRulesPage(): ReactElement {
  const { message } = AntdApp.useApp();
  const { notifyError } = useNotify();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CustomRule | null>(null);
  const [form] = Form.useForm<CustomRule>();
  // —— 试跑面板状态 ——
  const [testRule, setTestRule] = useState<CustomRule | null>(null);
  const [diffText, setDiffText] = useState('');
  const [sampleSource, setSampleSource] = useState('');
  const [testResult, setTestResult] = useState<CustomRuleTestResult | null>(null);
  const [testOpen, setTestOpen] = useState(false);

  const rulesQuery = useQuery({ queryKey: ['admin', 'rules'], queryFn: fetchCustomRules });
  const rules = rulesQuery.data ?? [];

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'rules'] });
  };

  const saveMutation = useMutation({
    mutationFn: (next: CustomRule[]) => updateCustomRules(next),
    onSuccess: () => {
      void message.success('规则已保存');
      invalidate();
    },
    onError: (e) => notifyError(e, { title: '保存规则失败' }),
  });

  const submitRule = (values: CustomRule): void => {
    // 规则名作为事实上的唯一键（Table rowKey）；保存前拒绝重名，避免键冲突与规则混淆
    const duplicate = rules.find((rule) => rule.name === values.name && rule !== editing);
    if (duplicate !== undefined) {
      form.setFields([{ name: 'name', errors: [`规则名称「${values.name}」已存在`] }]);
      return;
    }
    const parsed = CustomRuleSchema.parse(values);
    const next = [...rules];
    if (editing !== null) {
      const index = next.indexOf(editing);
      if (index !== -1) next[index] = parsed;
      else next.push(parsed);
    } else {
      next.push(parsed);
    }
    setOpen(false);
    setEditing(null);
    form.resetFields();
    saveMutation.mutate(next);
  };

  const openCreate = (): void => {
    setEditing(null);
    form.resetFields();
    form.setFieldsValue({ severity: 'WARNING', matchScope: ['added'], enabled: true });
    setOpen(true);
  };

  const openEdit = (rule: CustomRule): void => {
    setEditing(rule);
    form.setFieldsValue({
      ...rule,
      matchScope: [...rule.matchScope],
      filePatterns: [...rule.filePatterns],
    });
    setOpen(true);
  };

  const toggleRule = (rule: CustomRule, enabled: boolean): void => {
    const next = rules.map((item) => (item === rule ? { ...item, enabled } : item));
    saveMutation.mutate(next);
  };

  const removeRule = (rule: CustomRule): void => {
    saveMutation.mutate(rules.filter((item) => item !== rule));
  };

  const runTest = (): void => {
    if (testRule === null) return;
    testMutation.mutate({
      rule: testRule,
      sampleDiffText: diffText,
      sampleSource,
    });
  };

  const testMutation = useMutation({
    mutationFn: (request: { rule: CustomRule; sampleDiffText: string; sampleSource: string }) =>
      testCustomRule(request),
    onSuccess: (result) => setTestResult(result),
    onError: (e) => notifyError(e, { title: '试跑失败' }),
  });

  const columns: ColumnsType<CustomRule> = [
    {
      title: '规则名称',
      dataIndex: 'name',
      width: 180,
      render: (name: string, record) => (
        <Space size={8}>
          <Typography.Text strong>{name}</Typography.Text>
          {record.message !== '' ? <Tag color="purple">{record.message}</Tag> : null}
        </Space>
      ),
    },
    {
      title: '严重度',
      dataIndex: 'severity',
      width: 100,
      render: (severity: CustomRule['severity']) => (
        <Tag color={SEVERITY_COLORS[severity]}>{severity}</Tag>
      ),
    },
    {
      title: '匹配范围',
      dataIndex: 'matchScope',
      width: 160,
      render: (scopes: CustomRule['matchScope']) => (
        <Space size={4} wrap>
          {scopes.map((scope) => (
            <Tag key={scope}>{SCOPE_LABELS[scope]}</Tag>
          ))}
        </Space>
      ),
    },
    {
      title: '文件过滤',
      dataIndex: 'filePatterns',
      ellipsis: true,
      render: (patterns: string[]) => (patterns.length === 0 ? '全部' : patterns.join(', ')),
    },
    {
      title: '启用',
      dataIndex: 'enabled',
      width: 80,
      render: (enabled: boolean, record) => (
        <Switch
          size="small"
          checked={enabled}
          loading={saveMutation.isPending}
          onChange={(checked) => toggleRule(record, checked)}
        />
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 200,
      fixed: 'right',
      render: (_, record) => (
        <Space size={8}>
          <Typography.Link onClick={() => openEdit(record)}>编辑</Typography.Link>
          <Typography.Link onClick={() => setTestRule(record)}>试跑</Typography.Link>
          <Popconfirm
            title="确认删除该规则？"
            description="删除后本次审查不再应用此规则。"
            onConfirm={() => removeRule(record)}
          >
            <Typography.Link type="danger">删除</Typography.Link>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin / Custom Rules"
        title="自定义审查规则"
        description="定义团队专属的确定性检查规则（正则），在每次审查的静态分析阶段自动执行；可覆盖新增行、文件全文与变更函数片段。"
      />
      {rulesQuery.isError ? (
        <ErrorAlert
          error={rulesQuery.error}
          title="规则加载失败"
          onRetry={() => void rulesQuery.refetch()}
        />
      ) : (
        <Card className="surface-card data-table-card">
          <div className="table-toolbar">
            <Typography.Text type="secondary">
              共 {rules.length} 条规则，规则随 .ai-review.yml 持久化，保存后立即对后续审查生效。
            </Typography.Text>
            <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
              新增规则
            </Button>
          </div>
          <Table<CustomRule>
            rowKey="name"
            size="middle"
            loading={rulesQuery.isPending}
            columns={columns}
            dataSource={rules}
            scroll={{ x: 1000 }}
            pagination={false}
          />
        </Card>
      )}

      <Drawer
        className="rule-test-drawer"
        title={<CardHeading title="规则试跑" />}
        size={720}
        open={testOpen}
        onClose={() => setTestOpen(false)}
        destroyOnHidden
        extra={
          <Button
            type="primary"
            icon={<ExperimentOutlined />}
            onClick={runTest}
            loading={testMutation.isPending}
            disabled={testRule === null}
          >
            运行
          </Button>
        }
      >
        <Typography.Paragraph type="secondary">
          选择一条规则，粘贴示例
          diff（新增行）或示例源码，验证正则命中是否符合预期。试跑结果不会写入配置。
        </Typography.Paragraph>
        <Form layout="vertical">
          <Form.Item label="规则">
            <Select<string | undefined>
              placeholder="选择要测试的规则"
              value={testRule?.name}
              onChange={(name?: string) => {
                setTestRule(rules.find((rule) => rule.name === name) ?? null);
                setTestResult(null);
              }}
              options={rules.map((rule) => ({ label: rule.name, value: rule.name }))}
              allowClear
            />
          </Form.Item>
          <Space align="start" size="middle" style={{ width: '100%' }} wrap>
            <Form.Item label="示例 diff（新增行，前缀 +）" style={{ minWidth: 300, flex: 1 }}>
              <Input.TextArea
                rows={7}
                value={diffText}
                onChange={(e) => setDiffText(e.target.value)}
                placeholder={'+ const timeout = setTimeout(done, 1000);\n+ todo("fix me later");'}
              />
            </Form.Item>
            <Form.Item label="示例源码（文件全文 / 函数片段）" style={{ minWidth: 300, flex: 1 }}>
              <Input.TextArea
                rows={7}
                value={sampleSource}
                onChange={(e) => setSampleSource(e.target.value)}
                placeholder={
                  'function example() {\n  // TODO: clean up\n  console.log("debug");\n}'
                }
              />
            </Form.Item>
          </Space>
        </Form>
        <Space className="rule-test-presets" wrap>
          <Typography.Text type="secondary">快速填入：</Typography.Text>
          <Button
            size="small"
            onClick={() => {
              setDiffText('+ // TODO: replace mocked value\n+ console.log(password);');
              setTestResult(null);
            }}
          >
            TODO / console.log
          </Button>
          <Button
            size="small"
            onClick={() => {
              setDiffText('+ const token = "ghp_012345678901234567890123456789012345";');
              setTestResult(null);
            }}
          >
            疑似密钥
          </Button>
        </Space>
        {testResult === null ? (
          <EmptyState
            title="尚未运行试跑"
            description="选择规则并填入示例后点击「运行」，命中行会显示在下方。"
          />
        ) : testResult.matches.length === 0 ? (
          <Alert
            type="success"
            showIcon
            title="未命中任何行"
            description="检查正则或对应范围的示例输入。"
          />
        ) : (
          <Table
            rowKey={(row, index) => `${row.scope}-${row.line}-${String(index)}`}
            size="small"
            pagination={false}
            dataSource={testResult.matches}
            columns={[
              {
                title: '范围',
                dataIndex: 'scope',
                width: 100,
                render: (scope: string) => <Tag>{SCOPE_LABELS[scope] ?? scope}</Tag>,
              },
              {
                title: '行号',
                dataIndex: 'line',
                width: 80,
                render: (line: number) =>
                  line === 0 ? '—' : <span className="numeric-cell">{line}</span>,
              },
              {
                title: '命中内容',
                dataIndex: 'text',
                ellipsis: true,
                render: (text: string) => (
                  <Typography.Text code style={{ whiteSpace: 'pre-wrap' }}>
                    {text}
                  </Typography.Text>
                ),
              },
            ]}
          />
        )}
      </Drawer>

      <Modal
        title={<CardHeading title={editing === null ? '新增规则' : '编辑规则'} />}
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
        width={640}
      >
        <Form<CustomRule>
          form={form}
          layout="vertical"
          onFinish={submitRule}
          style={{ marginTop: 16 }}
        >
          <Form.Item
            label="规则名称"
            name="name"
            rules={[{ required: true, message: '请输入规则名称' }]}
          >
            <Input placeholder="例如：禁止遗留 TODO" maxLength={64} />
          </Form.Item>
          <Form.Item label="说明" name="description">
            <Input.TextArea
              placeholder="规则作用说明，会作为发现的描述文案（可选）"
              rows={2}
              maxLength={500}
            />
          </Form.Item>
          <Space align="start" size="large" style={{ width: '100%' }} wrap>
            <Form.Item
              label="正则表达式"
              name="pattern"
              style={{ minWidth: 280, flex: 1 }}
              rules={[
                { required: true, message: '请输入正则表达式' },
                { validator: validatePattern },
              ]}
            >
              <Input placeholder="例如：\\bTODO\\b|\\bFIXME\\b" />
            </Form.Item>
            <Form.Item
              label="正则 flag"
              name="flags"
              style={{ width: 140 }}
              rules={[{ validator: validateFlags }]}
            >
              <Input placeholder="如 i（忽略大小写）" maxLength={8} />
            </Form.Item>
          </Space>
          <Space align="start" size="large" style={{ width: '100%' }} wrap>
            <Form.Item
              label="严重度"
              name="severity"
              style={{ width: 180 }}
              rules={[{ required: true, message: '请选择严重度' }]}
            >
              <Select
                options={[
                  { label: 'BLOCKER（阻断）', value: 'BLOCKER' },
                  { label: 'WARNING（警告）', value: 'WARNING' },
                  { label: 'NIT（建议）', value: 'NIT' },
                ]}
              />
            </Form.Item>
            <Form.Item label="CWE 编号" name="cweId" style={{ width: 180 }}>
              <Input placeholder="如 CWE-1177（可选）" maxLength={16} />
            </Form.Item>
          </Space>
          <Form.Item label="发现标题" name="message" extra="为空时自动使用规则名称。">
            <Input placeholder="例如：检测到遗留的 TODO 标记" maxLength={120} />
          </Form.Item>
          <Form.Item label="修复建议" name="suggestion">
            <Input.TextArea placeholder="命中的修复指引（可选）" rows={2} maxLength={500} />
          </Form.Item>
          <Form.Item
            label="匹配范围"
            name="matchScope"
            extra="新增行仅看本次变更；文件全文与函数片段会覆盖存量代码，可能产生较多命中。"
            rules={[{ required: true, message: '请至少选择一个匹配范围' }]}
          >
            <Select
              mode="multiple"
              options={[
                { label: '变更新增行（推荐）', value: 'added' },
                { label: '文件全文', value: 'staged' },
                { label: '变更函数片段', value: 'snippet' },
              ]}
            />
          </Form.Item>
          <Form.Item
            label="文件过滤"
            name="filePatterns"
            extra="按 glob 过滤文件路径，留空表示匹配全部文件。"
          >
            <Select mode="tags" placeholder="例如：src/**、*.ts" open={false} suffixIcon={null} />
          </Form.Item>
          <Form.Item label="启用" name="enabled" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
