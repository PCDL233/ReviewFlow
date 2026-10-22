import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Popconfirm,
  Select,
  Skeleton,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import { UndoOutlined } from '@ant-design/icons';
import type { AdminConfig, ServerRuntime } from '@ai-review/shared/api';
import { AdminConfigSchema } from '@ai-review/shared/api';
import { fetchAdminConfigPayload, updateAdminConfig } from '../../api';
import { CardHeading, PageHeader } from '../../components/PageHeader';
import { ErrorAlert } from '../../components/ErrorAlert';
import { useNotify } from '../../hooks/use-notify';
import { useUnsavedChanges } from '../../hooks/use-unsaved-changes';
import { ADMIN_CONFIG_QUERY_KEY } from '../../lib/query-keys';

const TOOL_OPTIONS = [
  { label: 'AST 解析', value: 'ast_parse' },
  { label: '复杂度检查', value: 'complexity_check' },
  { label: '密钥扫描', value: 'secret_scan' },
  { label: '依赖漏洞扫描', value: 'dependency_scan' },
  { label: '自定义规则检查', value: 'custom_rule_check' },
];

const DIMENSION_OPTIONS = [
  { label: '正确性（LLM Agent）', value: 'correctness' },
  { label: '安全性（LLM Agent）', value: 'security' },
  { label: '性能（LLM Agent）', value: 'performance' },
  { label: '可维护性（由静态分析覆盖）', value: 'maintainability' },
];

const PAGE_HEADER = (
  <PageHeader
    eyebrow="Admin / Configuration"
    title="系统配置"
    description="管理审查模式、静态分析规则、RAG 知识库与报告输出策略；标注「需重启」的参数在服务启动时读取。"
  />
);

/** 系统配置：审查策略、静态分析、RAG、报告、日志、服务端与只读运行环境。 */
export function AdminConfigPage(): ReactElement {
  const [form] = Form.useForm<AdminConfig>();
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const queryClient = useQueryClient();
  const { notifyError } = useNotify();

  const configQuery = useQuery({
    queryKey: ADMIN_CONFIG_QUERY_KEY,
    queryFn: fetchAdminConfigPayload,
  });
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

  if (configQuery.isPending) {
    return (
      <div className="page-stack">
        {PAGE_HEADER}
        <Card className="surface-card">
          <Skeleton active paragraph={{ rows: 12 }} />
        </Card>
      </div>
    );
  }
  if (configQuery.isError) {
    return (
      <div className="page-stack">
        {PAGE_HEADER}
        <ErrorAlert
          error={configQuery.error}
          title="配置加载失败"
          onRetry={() => void configQuery.refetch()}
        />
      </div>
    );
  }

  const submit = (): void => {
    setSaved(false);
    // 全量提交：取表单 store 的全部值（含未渲染 Form.Item 的其他配置段），
    // 避免只提交本页注册字段时把 AI 模型等其余配置段重置为默认值
    const values = form.getFieldsValue(true);
    const parsed = AdminConfigSchema.safeParse(values);
    if (!parsed.success) {
      // 逐条列出 zod 校验问题：路径以 a.b.c 形式展示，便于对照表单定位
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

  return (
    <div className="page-stack config-page">
      {PAGE_HEADER}
      {unsavedGuard}
      {saved && (
        <Alert
          type="success"
          showIcon
          title="配置已保存"
          description="「服务端」与「审计日志」参数需重启服务后生效；其余参数（审查模式/维度/忽略模式/RAG/报告等）下一次审查即生效。"
          closable
          onClose={() => setSaved(false)}
        />
      )}
      {validationErrors.length > 0 && (
        <Alert
          type="error"
          showIcon
          title="配置校验未通过，请检查以下字段"
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
      )}
      <Form
        form={form}
        layout="vertical"
        onFinish={submit}
        onValuesChange={() => {
          setDirty(true);
          setSaved(false);
        }}
      >
        <div className="config-grid">
          <Card
            className="surface-card config-card"
            title={<CardHeading title="审查与静态分析" hint="下次审查生效" />}
          >
            <Form.Item label="默认审查模式" name={['review', 'mode']}>
              <Select
                options={[
                  { label: 'Fast（仅高风险文件）', value: 'fast' },
                  { label: 'Full（高风险 + 普通文件）', value: 'full' },
                ]}
              />
            </Form.Item>
            <Form.Item
              label="审查维度"
              name={['review', 'dimensions']}
              extra="关闭的维度不再调用对应 LLM Agent（不产生 token 消耗）；可维护性由静态分析工具覆盖。"
            >
              <Select mode="multiple" options={DIMENSION_OPTIONS} />
            </Form.Item>
            <Form.Item
              label="忽略模式"
              name={['review', 'ignorePatterns']}
              extra="支持 glob；匹配的文件不会进入审查上下文。"
            >
              <Select mode="tags" placeholder="例如 pnpm-lock.yaml、dist/**" open={false} />
            </Form.Item>
            <Form.Item
              label="阻断阈值"
              name={['review', 'blockOn']}
              extra="达到该严重度即判定为阻断；Hook 与 CI 据此返回退出码 1。"
            >
              <Select
                options={[
                  { label: 'BLOCKER', value: 'BLOCKER' },
                  { label: 'WARNING', value: 'WARNING' },
                  { label: 'NIT', value: 'NIT' },
                ]}
              />
            </Form.Item>
            <Form.Item
              label="单次审查文件上限"
              name={['review', 'maxFiles']}
              extra="超出后按风险分降序截断，被截断的文件只做静态分析并在报告中标注"
            >
              <InputNumber min={1} max={2000} className="full-width" />
            </Form.Item>
            <Form.Item
              label="单次审查变更行上限"
              name={['review', 'maxChangedLines']}
              extra="additions + deletions 之和；同样按文件截断并标注"
            >
              <InputNumber min={100} max={200_000} className="full-width" />
            </Form.Item>
            <Form.Item label="启用工具" name={['staticAnalysis', 'enabledTools']}>
              <Select mode="multiple" options={TOOL_OPTIONS} />
            </Form.Item>
            <Form.Item
              label="复杂度阈值"
              name={['staticAnalysis', 'complexityThreshold']}
              extra="圈复杂度超过该值的函数会被静态分析标记。"
            >
              <InputNumber min={1} max={100} className="full-width" />
            </Form.Item>
            <Form.Item
              label="包含 RAG 上下文"
              name={['rag', 'enabled']}
              valuePropName="checked"
              extra="关闭后审查不再检索知识库，Token 消耗更低。"
            >
              <Switch />
            </Form.Item>
          </Card>

          <Card className="surface-card config-card" title={<CardHeading title="知识库" />}>
            <Form.Item label="知识库路径" name={['rag', 'knowledgeBasePaths']}>
              <Select mode="tags" placeholder="例如 docs/" />
            </Form.Item>
            <Form.Item label="索引目录" name={['rag', 'indexDir']}>
              <Input />
            </Form.Item>
            <Form.Item
              label="召回数量"
              name={['rag', 'topK']}
              extra="单次审查最多注入的文本块数量。"
            >
              <InputNumber min={1} max={20} className="full-width" />
            </Form.Item>
            <Typography.Paragraph type="secondary" className="config-help">
              修改路径后需到「知识库」页面重建索引，旧索引不会自动迁移。
            </Typography.Paragraph>
          </Card>

          <Card className="surface-card config-card" title={<CardHeading title="报告输出" />}>
            <Form.Item label="默认格式" name={['report', 'format']}>
              <Select
                options={[
                  { label: 'Markdown', value: 'markdown' },
                  { label: 'HTML', value: 'html' },
                  { label: 'JSON', value: 'json' },
                ]}
              />
            </Form.Item>
            <Form.Item label="输出目录" name={['report', 'outputDir']}>
              <Input />
            </Form.Item>
            <Form.Item
              label="包含正向提示"
              name={['report', 'includePraise']}
              valuePropName="checked"
            >
              <Switch />
            </Form.Item>
            <Typography.Paragraph type="secondary" className="config-help">
              报告默认格式用于网页与接口导出；输出目录仅作提示，Web 端导出由浏览器下载完成。
            </Typography.Paragraph>
          </Card>

          <Card
            className="surface-card config-card"
            title={<CardHeading title="审计日志" hint="需重启" />}
          >
            <Form.Item label="启用日志" name={['logging', 'enabled']} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item label="输出到控制台" name={['logging', 'console']} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item label="写入日志文件" name={['logging', 'file']} valuePropName="checked">
              <Switch />
            </Form.Item>
            <Form.Item label="日志目录" name={['logging', 'dir']}>
              <Input placeholder="logs" />
            </Form.Item>
            <Form.Item label="文件保留天数" name={['logging', 'maxDays']} extra="单位：天">
              <InputNumber min={1} max={3650} className="full-width" />
            </Form.Item>
            <Typography.Paragraph type="secondary" className="config-help">
              登录与操作日志按日滚动归档（ai-review-login-YYYY-MM-DD.log），超保留天数自动清理。
            </Typography.Paragraph>
          </Card>

          <Card
            className="surface-card config-card"
            title={<CardHeading title="服务端" hint="需重启" />}
          >
            <Form.Item
              label="允许审查的仓库根目录"
              name={['server', 'allowedRoots']}
              extra="留空表示仅当前工作目录；等价 AI_REVIEW_ALLOWED_ROOTS"
            >
              <Select mode="tags" placeholder="例如 D:/work/repo-a" />
            </Form.Item>
            <Form.Item label="并行审查上限" name={['server', 'maxConcurrent']}>
              <InputNumber min={1} max={64} className="full-width" />
            </Form.Item>
            <Form.Item
              label="会话 Cookie 强制 Secure"
              name={['server', 'cookieSecure']}
              valuePropName="checked"
              extra="生产环境（NODE_ENV=production）下自动开启"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              label="开放注册"
              name={['server', 'allowRegister']}
              valuePropName="checked"
              extra="缺省仅在无任何用户时允许注册（首个管理员引导后关闭）"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              label="信任反向代理"
              name={['server', 'trustProxy']}
              valuePropName="checked"
              extra="nginx 等反代部署时开启，限流/审计改用 X-Forwarded-For 识别真实 IP"
            >
              <Switch />
            </Form.Item>
            <Form.Item
              label="Ollama 回退模型"
              name={['server', 'ollamaModel']}
              extra="云端 provider 不可用时的本地兜底模型"
            >
              <Input placeholder="qwen3-coder:30b" />
            </Form.Item>
            <Form.Item
              label="Hook/CI 审查超时"
              name={['server', 'hookTimeoutMs']}
              extra="单位：毫秒；超时返回退出码 3（不阻断提交）"
            >
              <InputNumber min={10_000} max={600_000} step={10_000} className="full-width" />
            </Form.Item>
            <Form.Item
              label="启用 MCP 端点"
              name={['server', 'mcpEnabled']}
              valuePropName="checked"
              extra="开启后 /api/mcp 以 Streamable HTTP 暴露静态分析工具（需 Bearer 令牌）"
            >
              <Switch />
            </Form.Item>
            <Typography.Paragraph type="secondary" className="config-help">
              已设置的环境变量（AI_REVIEW_*）优先于此处配置。
            </Typography.Paragraph>
          </Card>

          <RuntimeCard runtime={configQuery.data.runtime} />
        </div>

        <div className="config-savebar">
          <span className="config-savebar-status" aria-live="polite">
            {dirty ? (
              <Tag color="warning">有未保存的变更</Tag>
            ) : (
              <Tag color="success">配置与服务端一致</Tag>
            )}
          </span>
          <Space>
            <Popconfirm
              title="撤销未保存的修改？"
              description="表单将恢复为最后一次读取到的服务端配置。"
              onConfirm={discard}
              disabled={!dirty}
            >
              <Button icon={<UndoOutlined />} disabled={!dirty}>
                撤销修改
              </Button>
            </Popconfirm>
            <Button type="primary" htmlType="submit" loading={saveMutation.isPending}>
              保存配置
            </Button>
          </Space>
        </div>
      </Form>
    </div>
  );
}

/** 运行环境只读卡：端口、数据库与静态目录来自服务端启动参数，不可在此编辑。 */
function RuntimeCard(props: { runtime: ServerRuntime }): ReactElement {
  const runtime = props.runtime;
  return (
    <Card
      className="surface-card config-card config-runtime"
      title={<CardHeading title="运行环境" hint="只读" />}
    >
      <Descriptions column={1} size="small" bordered className="knowledge-meta">
        <Descriptions.Item label="监听端口">{runtime.port}</Descriptions.Item>
        <Descriptions.Item label="数据库路径">
          <Typography.Text code>{runtime.dbPath}</Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="配置文件">
          <Typography.Text code>{runtime.configPath}</Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="静态资源目录">
          {runtime.webDistDir === null ? '由 Vite 开发服务器托管' : runtime.webDistDir}
        </Descriptions.Item>
        <Descriptions.Item label="生效的 allowedRoots">
          {runtime.allowedRoots.length === 0 ? (
            <Typography.Text type="secondary">仅当前工作目录</Typography.Text>
          ) : (
            <Space orientation="vertical" size={2}>
              {runtime.allowedRoots.map((root) => (
                <Typography.Text key={root} code>
                  {root}
                </Typography.Text>
              ))}
            </Space>
          )}
        </Descriptions.Item>
      </Descriptions>
      <Typography.Paragraph type="secondary" className="config-help">
        以上值由服务启动参数（命令行 / 环境变量）决定，修改需重启服务。
      </Typography.Paragraph>
    </Card>
  );
}
