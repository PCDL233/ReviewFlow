import { useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App as AntdApp,
  AutoComplete,
  Button,
  Card,
  Col,
  Descriptions,
  Input,
  Popconfirm,
  Row,
  Skeleton,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CopyOutlined,
  DownloadOutlined,
  KeyOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import type { HookToken } from '@ai-review/shared/api';
import {
  createHookToken,
  fetchHookScript,
  fetchHookTokens,
  fetchRepositories,
  installHook,
  revokeHookToken,
} from '../../api';
import { CardHeading, PageHeader } from '../../components/PageHeader';
import { ErrorAlert } from '../../components/ErrorAlert';
import { EmptyState } from '../../components/EmptyState';
import { CodeBlock } from '../../components/CodeBlock';
import { useNotify } from '../../hooks/use-notify';
import { formatDateTime } from '../../format';

/** CI 工作流片段：与 pre-commit 共用同一个同步端点与退出码契约 */
const CI_SNIPPET = [
  '- name: AI Review',
  '  run: |',
  '    set +e',
  '    curl -sS -X POST "$AI_REVIEW_SERVER/api/hooks/review" \\',
  '      -H "authorization: Bearer $AI_REVIEW_TOKEN" \\',
  '      -H "content-type: application/json" \\',
  '      -d "{\\"repoPath\\":\\"$PWD\\",\\"target\\":\\"range\\",\\"base\\":\\"origin/main\\",\\"mode\\":\\"full\\"}" \\',
  '      -o review.json',
  '    exit_code=$(node -p "require(\'./review.json\').exitCode")',
  '    cat review.json',
  '    exit $exit_code',
].join('\n');

/**
 * Git Hook 与 CI：一键把审查 hook 安装到仓库，并管理调用凭据。
 * 与旧版的差别：这里真实写盘（服务端安装），不再让用户复制命令回终端执行。
 */
export function AdminHookPage(): ReactElement {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const { notifyError } = useNotify();
  const [repoPath, setRepoPath] = useState('');
  const [tokenLabel, setTokenLabel] = useState('pre-commit');
  const [overwrite, setOverwrite] = useState(false);
  const [plainText, setPlainText] = useState<string | null>(null);

  const reposQuery = useQuery({ queryKey: ['repos'], queryFn: fetchRepositories });
  const scriptQuery = useQuery({ queryKey: ['hook-script'], queryFn: () => fetchHookScript() });
  const tokensQuery = useQuery({ queryKey: ['hook-tokens'], queryFn: fetchHookTokens });

  const installMutation = useMutation({
    mutationFn: () => installHook({ repoPath: repoPath.trim(), tokenLabel, overwrite }),
    onSuccess: (result) => {
      setPlainText(result.plainText);
      void queryClient.invalidateQueries({ queryKey: ['hook-tokens'] });
      // 全部文件已存在且未选择覆盖时，服务端不会写入任何内容——此时必须明确告警，
      // 否则上面的“令牌明文”提示会让人误以为安装成功。
      if (!result.installed) {
        void message.warning(
          result.skipped.length > 0
            ? `已存在 ${result.skipped.join('、')}，未覆盖。如需重装请打开「覆盖已有 Hook」。`
            : '未写入任何文件，请检查目标仓库路径。',
        );
        return;
      }
      void message.success(
        result.skipped.length > 0
          ? `已写入 ${result.files.length} 个文件，跳过 ${result.skipped.length} 个已存在文件`
          : `已写入 ${result.files.length} 个文件`,
      );
    },
    onError: (e) => notifyError(e, { title: '安装 Hook 失败' }),
  });

  const tokenMutation = useMutation({
    mutationFn: () => createHookToken(tokenLabel, 90),
    onSuccess: (result) => {
      setPlainText(result.plainText);
      void queryClient.invalidateQueries({ queryKey: ['hook-tokens'] });
      void message.success('已签发令牌，明文仅显示一次，请立即保存');
    },
    onError: (e) => notifyError(e, { title: '签发令牌失败' }),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeHookToken(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['hook-tokens'] });
      void message.success('令牌已吊销');
    },
    onError: (e) => notifyError(e, { title: '吊销令牌失败' }),
  });

  const copy = async (text: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      void message.success(`${label}已复制`);
    } catch {
      void message.error('复制失败，请手动选择文本复制');
    }
  };

  const download = (content: string, filename: string): void => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
    void message.success(`${filename} 已下载`);
  };

  const tokenColumns: ColumnsType<HookToken> = [
    { title: '标签', dataIndex: 'label', width: 160 },
    {
      title: '令牌前缀',
      dataIndex: 'prefix',
      width: 150,
      render: (prefix: string) => <Typography.Text code>{prefix}…</Typography.Text>,
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (value: string) => formatDateTime(value),
    },
    {
      title: '最后使用',
      dataIndex: 'lastUsedAt',
      width: 180,
      render: (value: string | null) =>
        value === null ? <span className="table-muted">从未使用</span> : formatDateTime(value),
    },
    {
      title: '过期时间',
      dataIndex: 'expiresAt',
      width: 170,
      render: (value: string | null) => {
        if (value === null) return <span className="table-muted">永不过期</span>;
        const expired = new Date(value).getTime() <= Date.now();
        return (
          <Space size={4}>
            <span className={expired ? 'numeric-cell' : undefined}>{formatDateTime(value)}</span>
            {expired ? <Tag color="error">已过期</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: '状态',
      key: 'status',
      width: 100,
      render: (_value, record) => {
        if (record.revokedAt !== null) return <Tag>已吊销</Tag>;
        if (record.expiresAt !== null && new Date(record.expiresAt).getTime() <= Date.now()) {
          return <Tag color="error">已过期</Tag>;
        }
        return <Tag color="success">有效</Tag>;
      },
    },
    {
      title: '操作',
      key: 'actions',
      width: 100,
      render: (_value, record) =>
        record.revokedAt === null ? (
          <Popconfirm
            title="吊销该令牌？"
            description="使用该令牌的 Hook 与 CI 将立即失效。"
            okText="吊销"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => revokeMutation.mutate(record.id)}
          >
            <Button
              size="small"
              danger
              loading={revokeMutation.isPending && revokeMutation.variables === record.id}
            >
              吊销
            </Button>
          </Popconfirm>
        ) : null,
    },
  ];

  const script = scriptQuery.data;

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin / Hook & CI"
        title="Git Hook 与 CI"
        description="由服务端把审查 hook 直接写入仓库，无需在本地执行任何命令；写入后每次提交都会自动审查。"
        extra={
          <Button
            icon={<ReloadOutlined />}
            loading={scriptQuery.isFetching}
            onClick={() => {
              void scriptQuery.refetch();
              void tokensQuery.refetch();
            }}
          >
            刷新
          </Button>
        }
      />

      {plainText !== null ? (
        <Alert
          type="success"
          showIcon
          title="令牌明文（仅本次显示）"
          description={
            <Space orientation="vertical" size={4} className="full-width">
              <Typography.Text code copyable>
                {plainText}
              </Typography.Text>
              <Typography.Text type="secondary">
                安装时已自动写入目标的{' '}
                <Typography.Text code>.ai-review-cache/hook-token</Typography.Text>
                （已加入 .gitignore）。此处仅用于核对或手工配置其他环境。
              </Typography.Text>
            </Space>
          }
          closable
          onClose={() => setPlainText(null)}
        />
      ) : null}

      <Row gutter={[16, 16]} align="stretch">
        <Col xs={24} xl={12}>
          <Card className="surface-card card-fill" title={<CardHeading title="一键安装" />}>
            <Space orientation="vertical" size={12} className="full-width">
              <div>
                <Typography.Text strong>目标仓库</Typography.Text>
                <AutoComplete
                  className="full-width"
                  value={repoPath}
                  onChange={setRepoPath}
                  placeholder="选择仓库，或粘贴绝对路径"
                  options={(reposQuery.data ?? []).map((repo) => ({
                    value: repo.path,
                    label: `${repo.name}${repo.reviewed ? ' · 历史' : ''} — ${repo.path}`,
                  }))}
                  filterOption={(input, option) =>
                    String(option?.value ?? '')
                      .toLowerCase()
                      .includes(input.toLowerCase())
                  }
                />
              </div>
              <div>
                <Typography.Text strong>令牌标签</Typography.Text>
                <Input
                  value={tokenLabel}
                  onChange={(event) => setTokenLabel(event.target.value)}
                  placeholder="pre-commit"
                />
                <Typography.Text type="secondary" className="config-help">
                  安装会签发一个新令牌并写入目标仓库，可在下方列表中随时吊销。
                </Typography.Text>
              </div>
              <Space>
                <Switch checked={overwrite} onChange={setOverwrite} />
                <Typography.Text>覆盖已有 Hook</Typography.Text>
              </Space>
              <Button
                type="primary"
                icon={<SafetyCertificateOutlined />}
                loading={installMutation.isPending}
                disabled={repoPath.trim() === '' || tokenLabel.trim() === ''}
                onClick={() => installMutation.mutate()}
              >
                安装到此仓库
              </Button>
              <Alert
                type="info"
                showIcon
                title="服务端会写入两个文件"
                description={
                  <span>
                    <Typography.Text code>.husky/pre-commit</Typography.Text>（入口）与{' '}
                    <Typography.Text code>.ai-review/hooks/pre-commit.mjs</Typography.Text>
                    （Node 运行器）。审查服务不可达时退出码为 3，不阻断提交。
                  </span>
                }
              />
            </Space>
          </Card>
        </Col>

        <Col xs={24} xl={12}>
          <Card
            className="surface-card card-fill hook-script-card"
            title={<CardHeading title="Hook 脚本内容" />}
            extra={
              <Button
                size="small"
                icon={<DownloadOutlined />}
                disabled={script === undefined}
                onClick={() => download(script?.runner ?? '', 'pre-commit.mjs')}
              >
                下载运行器
              </Button>
            }
          >
            {scriptQuery.isPending ? (
              <Skeleton active paragraph={{ rows: 6 }} />
            ) : scriptQuery.isError ? (
              <ErrorAlert
                error={scriptQuery.error}
                title="脚本加载失败"
                onRetry={() => void scriptQuery.refetch()}
              />
            ) : script === undefined ? (
              <EmptyState title="暂无可用脚本" description="请检查服务端配置后刷新。" />
            ) : (
              <Tabs
                className="hook-script-tabs"
                items={[
                  {
                    key: 'shell',
                    label: '入口脚本',
                    children: (
                      <CodeBlock code={script.shell} title={script.paths.shell} maxHeight={300} />
                    ),
                  },
                  {
                    key: 'runner',
                    label: 'Node 运行器',
                    children: (
                      <CodeBlock
                        code={script.runner}
                        title={script.paths.runner}
                        showLineNumbers
                        maxHeight={360}
                      />
                    ),
                  },
                ]}
              />
            )}
          </Card>
        </Col>
      </Row>

      <Card
        className="surface-card"
        title={<CardHeading title="CI 集成" hint="GitHub Actions 示例" />}
        extra={
          <Button icon={<CopyOutlined />} onClick={() => void copy(CI_SNIPPET, 'CI 步骤')}>
            复制
          </Button>
        }
      >
        <Typography.Paragraph type="secondary">
          CI 使用同一个同步端点与令牌：响应中的 <Typography.Text code>exitCode</Typography.Text> 沿用
          0 通过 / 1 阻断 / 2 配置环境错误 / 3 超时的契约。
        </Typography.Paragraph>
        <CodeBlock code={CI_SNIPPET} title=".github/workflows/ai-review.yml" maxHeight={280} />
      </Card>

      <Card
        className="surface-card"
        title={<CardHeading title="访问令牌" hint="用于 Hook 与 CI" />}
        extra={
          <Button
            icon={<KeyOutlined />}
            loading={tokenMutation.isPending}
            onClick={() => tokenMutation.mutate()}
          >
            签发新令牌
          </Button>
        }
      >
        {tokensQuery.isError ? (
          <ErrorAlert
            error={tokensQuery.error}
            title="令牌列表加载失败"
            onRetry={() => void tokensQuery.refetch()}
          />
        ) : (
          <Table<HookToken>
            size="small"
            rowKey="id"
            loading={tokensQuery.isPending}
            dataSource={tokensQuery.data ?? []}
            columns={tokenColumns}
            pagination={false}
            locale={{ emptyText: '尚无令牌，安装 Hook 或点击「签发新令牌」即可创建。' }}
          />
        )}
        <Descriptions className="knowledge-meta" column={1} bordered size="small">
          <Descriptions.Item label="调用地址">
            <Typography.Text code>/api/hooks/review</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="鉴权方式">
            <Typography.Text code>Authorization: Bearer &lt;token&gt;</Typography.Text>
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </div>
  );
}
