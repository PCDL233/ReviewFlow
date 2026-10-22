import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Row,
  Select,
  Skeleton,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import type { AdminConfig } from '@ai-review/shared/api';
import { AdminConfigSchema, MODEL_PROVIDER_LIST, MODEL_PROVIDERS } from '@ai-review/shared/api';
import { fetchAdminConfigPayload, updateAdminConfig } from '../../api';
import { CardHeading, PageHeader } from '../../components/PageHeader';
import { ErrorAlert } from '../../components/ErrorAlert';
import { useNotify } from '../../hooks/use-notify';
import { useUnsavedChanges } from '../../hooks/use-unsaved-changes';
import { ADMIN_CONFIG_QUERY_KEY } from '../../lib/query-keys';

/** Provider 下拉选项直接取自 shared 目录，与配置 schema 同源，避免双份维护。 */
const PROVIDER_OPTIONS = MODEL_PROVIDER_LIST.map((info) => ({
  label: info.label,
  value: info.id,
}));

function providerInfoOf(
  provider: AdminConfig['llm']['provider'] | undefined,
): (typeof MODEL_PROVIDER_LIST)[number] {
  const direct = MODEL_PROVIDER_LIST.find((item) => item.id === provider);
  // MODEL_PROVIDER_LIST 在 shared 中恒非空（zod 枚举推导），首个元素可靠兜底
  const fallback = MODEL_PROVIDER_LIST[0];
  if (direct !== undefined) return direct;
  if (fallback === undefined) throw new Error('MODEL_PROVIDER_LIST 不能为空');
  return fallback;
}

/** AI 模型配置：Provider / 模型 / 端点 / 密钥与生成参数。 */
export function AdminAiConfigPage(): ReactElement {
  const [form] = Form.useForm<AdminConfig>();
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const { notifyError } = useNotify();

  // 与「系统配置」页共用同一查询与同一数据形状（配置 + 运行环境），
  // 否则先打开任一页面都会污染另一页面的缓存，保存时把配置重置为默认值。
  const configQuery = useQuery({
    queryKey: ADMIN_CONFIG_QUERY_KEY,
    queryFn: fetchAdminConfigPayload,
  });
  const provider =
    Form.useWatch<AdminConfig['llm']['provider']>(['llm', 'provider'], form) ?? 'anthropic';
  const recommendedModels = MODEL_PROVIDERS[provider]?.recommendedModels ?? [];
  const providerInfo = providerInfoOf(provider);
  const unsavedGuard = useUnsavedChanges(dirty);

  const saveMutation = useMutation({
    mutationFn: (config: AdminConfig) => updateAdminConfig(config),
    onSuccess: (config) => {
      form.setFieldsValue(config);
      setSaved(true);
      setDirty(false);
      void queryClient.invalidateQueries({ queryKey: ADMIN_CONFIG_QUERY_KEY });
    },
    onError: (e) => notifyError(e, { title: '保存配置失败' }),
  });

  useEffect(() => {
    if (configQuery.data !== undefined) {
      form.setFieldsValue(configQuery.data.config);
      setDirty(false);
    }
  }, [configQuery.data, form]);

  const handleProviderChange = (nextProvider: string): void => {
    const current = form.getFieldValue(['llm', 'baseUrl']);
    const baseUrl = typeof current === 'string' ? current.trim() : '';
    if (baseUrl !== '') return;
    const info = MODEL_PROVIDER_LIST.find((item) => item.id === nextProvider);
    if (info !== undefined) form.setFieldValue(['llm', 'baseUrl'], info.defaultEndpoint);
  };

  const restoreDefaultEndpoint = (): void => {
    form.setFieldValue(['llm', 'baseUrl'], providerInfo?.defaultEndpoint ?? '');
    setDirty(true);
  };

  const submit = (): void => {
    setSaved(false);
    // 全量提交：取表单 store 的全部值（含未渲染 Form.Item 的其他配置段），
    // 避免只提交本页注册字段时把审查/日志/服务端等其余配置段重置为默认值
    const values = form.getFieldsValue(true);
    const parsed = AdminConfigSchema.safeParse(values);
    if (!parsed.success) {
      setValidationErrors(
        parsed.error.issues.map(
          (issue) =>
            `${issue.path.map((segment) => String(segment)).join('.') || '根'}：${issue.message}`,
        ),
      );
      return;
    }
    setValidationErrors([]);
    saveMutation.mutate(parsed.data);
  };

  const discard = (): void => {
    if (configQuery.data === undefined) return;
    form.setFieldsValue(configQuery.data.config);
    setDirty(false);
    setSaved(false);
    setValidationErrors([]);
  };

  const header = (
    <PageHeader
      eyebrow="Admin / AI Model"
      title="AI 模型配置"
      description="配置审查使用的模型服务。API Key 提交后会被安全掩码，Base URL 支持自定义端点或留空使用默认值。"
    />
  );

  if (configQuery.isError) {
    return (
      <div className="page-stack">
        {header}
        <ErrorAlert
          error={configQuery.error}
          title="配置加载失败"
          onRetry={() => void configQuery.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="page-stack config-page">
      {header}
      {unsavedGuard}
      {saved ? (
        <Alert
          type="success"
          showIcon
          closable
          title="模型配置已保存"
          description="新发起的审查会立即使用新配置；运行中的审查仍使用旧配置。"
          onClose={() => setSaved(false)}
        />
      ) : null}
      {validationErrors.length > 0 ? (
        <Alert
          type="error"
          showIcon
          title="配置校验未通过"
          description={
            <ul className="config-error-list">
              {validationErrors.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          }
          closable
          onClose={() => setValidationErrors([])}
        />
      ) : null}
      <Row gutter={[16, 16]} align="stretch">
        <Col xs={24} xl={16}>
          <Card className="surface-card" title={<CardHeading title="模型服务" />}>
            {configQuery.isPending ? (
              <Skeleton active paragraph={{ rows: 10 }} />
            ) : (
              <Form
                form={form}
                layout="vertical"
                onFinish={submit}
                onValuesChange={() => {
                  setDirty(true);
                  setSaved(false);
                }}
              >
                <Form.Item
                  label="Provider"
                  name={['llm', 'provider']}
                  extra="已支持国内主流模型服务：DeepSeek、智谱 GLM、Moonshot Kimi、通义千问、豆包、MiniMax。"
                  rules={[{ required: true, message: '请选择模型提供商' }]}
                >
                  <Select options={PROVIDER_OPTIONS} onChange={handleProviderChange} />
                </Form.Item>
                <Form.Item
                  label="模型"
                  name={['llm', 'model']}
                  rules={[{ required: true, message: '请输入模型名称' }]}
                >
                  <AutoComplete
                    options={recommendedModels.map((model) => ({ value: model }))}
                    placeholder="选择推荐模型或直接输入，例如 deepseek-v4-pro"
                  />
                </Form.Item>
                <Form.Item
                  label={
                    <Space size={8}>
                      <span>Base URL</span>
                      <Button
                        type="link"
                        size="small"
                        icon={<ReloadOutlined />}
                        onClick={restoreDefaultEndpoint}
                      >
                        恢复默认
                      </Button>
                    </Space>
                  }
                  name={['llm', 'baseUrl']}
                  extra={
                    providerInfo === undefined
                      ? '留空将使用提供商默认端点。'
                      : `默认端点：${providerInfo.defaultEndpoint}`
                  }
                >
                  <Input
                    placeholder={providerInfo?.defaultEndpoint ?? 'https://api.example.com/v1'}
                  />
                </Form.Item>
                <Form.Item
                  label="API Key"
                  name={['llm', 'apiKey']}
                  extra="支持直接填写密钥或 ${ENV_NAME} 环境变量引用。提交后页面将显示为掩码（********）。"
                  rules={[{ required: true, message: '请输入 API Key' }]}
                >
                  <Input.Password placeholder="sk-... 或 ${AI_REVIEW_API_KEY}" />
                </Form.Item>
                <Row gutter={16}>
                  <Col xs={24} md={12}>
                    <Form.Item
                      label="单次最大 Token"
                      name={['llm', 'maxTokensPerReview']}
                      rules={[{ required: true, message: '请输入单次最大 Token' }]}
                      extra="单位：tokens"
                    >
                      <InputNumber min={1000} max={200000} step={1000} className="full-width" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    <Form.Item
                      label="温度"
                      name={['llm', 'temperature']}
                      rules={[{ required: true, message: '请输入温度' }]}
                      extra="0 更确定，1 更发散；审查建议 0.1–0.3。"
                    >
                      <InputNumber min={0} max={2} step={0.1} className="full-width" />
                    </Form.Item>
                  </Col>
                </Row>
                <Form.Item label="Mock fixtures 目录" name={['llm', 'mockFixturesDir']}>
                  <Input placeholder=".ai-review-cache/llm-fixtures" />
                </Form.Item>
                <Form.Item
                  label="启用 RAG 上下文"
                  name={['rag', 'enabled']}
                  valuePropName="checked"
                >
                  <Switch />
                </Form.Item>
                <div className="config-savebar">
                  <span className="config-savebar-status" aria-live="polite">
                    {dirty ? (
                      <Tag color="warning">有未保存的变更</Tag>
                    ) : (
                      <Tag color="success">配置与服务端一致</Tag>
                    )}
                  </span>
                  <Space>
                    <Button onClick={discard} disabled={!dirty}>
                      撤销修改
                    </Button>
                    <Button type="primary" htmlType="submit" loading={saveMutation.isPending}>
                      保存配置
                    </Button>
                  </Space>
                </div>
              </Form>
            )}
          </Card>
        </Col>
        <Col xs={24} xl={8}>
          <Card
            className="surface-card card-fill provider-card"
            title={<CardHeading title="Provider 说明" hint={providerInfo?.label ?? ''} />}
          >
            <div className="provider-meta">
              <div className="provider-meta-item">
                <div className="provider-meta-label">默认端点</div>
                <div className="provider-meta-value">
                  <Typography.Text code>{providerInfo?.defaultEndpoint ?? '—'}</Typography.Text>
                </div>
              </div>
              <div className="provider-meta-item">
                <div className="provider-meta-label">推荐模型</div>
                <div className="provider-meta-value">
                  {recommendedModels.length === 0 ? (
                    <Typography.Text type="secondary">该服务商未提供推荐列表</Typography.Text>
                  ) : (
                    <Space size={4} wrap>
                      {recommendedModels.slice(0, 4).map((model) => (
                        <Tag key={model}>{model}</Tag>
                      ))}
                    </Space>
                  )}
                </div>
              </div>
              <div className="provider-meta-item">
                <div className="provider-meta-label">密钥掩码</div>
                <div className="provider-meta-value">
                  保存后回显为 <Typography.Text code>********</Typography.Text>
                  ，仅当填写新值时才覆盖。
                </div>
              </div>
              <div className="provider-meta-item">
                <div className="provider-meta-label">环境变量优先</div>
                <div className="provider-meta-value">
                  设置 <Typography.Text code>AI_REVIEW_API_KEY</Typography.Text> 时以环境变量为准。
                </div>
              </div>
            </div>
            <Typography.Paragraph type="secondary" className="config-help">
              未配置可用 Provider 时，审查会自动回退到本地 Ollama，再回退到 mock
              数据，保证流水线可运行。
            </Typography.Paragraph>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
