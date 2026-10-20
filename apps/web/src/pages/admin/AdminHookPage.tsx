import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Row,
  Skeleton,
  Space,
  Steps,
  Tooltip,
  Typography,
} from 'antd';
import { CopyOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons';
import { fetchHookScript } from '../../api';
import { CardHeading, PageHeader } from '../../components/PageHeader';
import { ErrorAlert } from '../../components/ErrorAlert';
import { CodeBlock } from '../../components/CodeBlock';

const MANUAL_COMMAND = [
  'mkdir -p .husky',
  "cat > .husky/pre-commit <<'EOF'",
  '#!/bin/sh',
  'pnpm exec ai-review run --mode fast',
  'EOF',
  'chmod +x .husky/pre-commit',
].join('\n');

/** Git Hook 安装：自动安装命令、手动方式与脚本下载。 */
export function AdminHookPage(): ReactElement {
  const { message } = AntdApp.useApp();
  const scriptQuery = useQuery({
    queryKey: ['admin', 'hook-script'],
    queryFn: fetchHookScript,
  });

  const script = scriptQuery.data;

  const copy = async (text: string, label: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
      void message.success(`${label}已复制`);
    } catch {
      void message.error('复制失败，请手动选择文本复制');
    }
  };

  const download = (): void => {
    if (script === undefined) return;
    const blob = new Blob([script], { type: 'text/x-shellscript;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'pre-commit';
    anchor.click();
    URL.revokeObjectURL(url);
    void message.success('pre-commit 脚本已下载');
  };

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin / Hook"
        title="Git Hook 安装"
        description="安装 pre-commit hook 后，每次提交前会自动运行 fast 模式审查，未达阻断阈值才允许提交。"
        extra={
          <Button
            icon={<ReloadOutlined />}
            loading={scriptQuery.isFetching}
            onClick={() => void scriptQuery.refetch()}
          >
            重新获取
          </Button>
        }
      />
      {scriptQuery.isError ? (
        <ErrorAlert
          error={scriptQuery.error}
          title="Hook 脚本加载失败"
          onRetry={() => void scriptQuery.refetch()}
        />
      ) : null}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={10}>
          <Card className="surface-card" title={<CardHeading title="安装方式" />}>
            <Steps
              orientation="vertical"
              size="small"
              current={-1}
              items={[
                {
                  title: '初始化 husky',
                  content: (
                    <Space orientation="vertical" size={4}>
                      <Typography.Text type="secondary">
                        在仓库根目录启用 husky v9：
                      </Typography.Text>
                      <Typography.Text code copyable>
                        pnpm exec husky init
                      </Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: '一键安装 CLI Hook',
                  content: (
                    <Space orientation="vertical" size={4}>
                      <Typography.Text type="secondary">
                        使用 CLI 自动写入 hook 并绑定审查命令：
                      </Typography.Text>
                      <Typography.Text code copyable>
                        pnpm exec ai-review install-hook
                      </Typography.Text>
                    </Space>
                  ),
                },
                {
                  title: '或手动放置脚本',
                  content: (
                    <Typography.Text type="secondary">
                      将右侧脚本保存为 <Typography.Text code>.husky/pre-commit</Typography.Text>
                      ，并确保文件可执行。
                    </Typography.Text>
                  ),
                },
                {
                  title: '提交时自动审查',
                  content: (
                    <Typography.Text type="secondary">
                      hook 读取暂存区变更；达到阻断阈值时退出码为 1，阻止本次提交。
                    </Typography.Text>
                  ),
                },
              ]}
            />
            <Alert
              className="hook-note"
              type="info"
              showIcon
              title="服务端无法写入你本地的文件系统"
              description="请在本机执行上述命令，或复制脚本后手动创建 hook 文件。"
            />
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card
            className="surface-card"
            title={<CardHeading title="pre-commit 脚本" />}
            extra={
              <Space>
                <Tooltip title={script === undefined ? '脚本尚未加载' : '复制到剪贴板'}>
                  <Button
                    icon={<CopyOutlined />}
                    disabled={script === undefined}
                    onClick={() => void copy(script ?? '', '脚本')}
                  >
                    复制
                  </Button>
                </Tooltip>
                <Button
                  icon={<DownloadOutlined />}
                  disabled={script === undefined}
                  onClick={download}
                >
                  下载
                </Button>
              </Space>
            }
          >
            {scriptQuery.isPending ? (
              <Skeleton active paragraph={{ rows: 6 }} />
            ) : script === undefined ? (
              <Typography.Text type="secondary">暂无可用脚本</Typography.Text>
            ) : (
              <CodeBlock code={script} title=".husky/pre-commit" showLineNumbers maxHeight={420} />
            )}
          </Card>
          <Card
            className="surface-card"
            title={<CardHeading title="手动安装命令" />}
            extra={
              <Button icon={<CopyOutlined />} onClick={() => void copy(MANUAL_COMMAND, '命令')}>
                复制命令
              </Button>
            }
          >
            <CodeBlock code={MANUAL_COMMAND} title="macOS / Linux" maxHeight={240} />
          </Card>
        </Col>
      </Row>
    </div>
  );
}
