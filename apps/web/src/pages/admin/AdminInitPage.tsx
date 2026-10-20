import { useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Alert, Button, Card, Result, Typography } from 'antd';
import { CheckCircleOutlined, FileTextOutlined } from '@ant-design/icons';
import { initializeConfig } from '../../api';
import { CardHeading, PageHeader } from '../../components/PageHeader';
import { ErrorAlert } from '../../components/ErrorAlert';
import { getErrorStatus } from '../../parse-response';
import { useNotify } from '../../hooks/use-notify';

const CONFIG_SECTIONS = [
  { title: '模型提供商', description: 'provider、model、默认端点与 token 预算' },
  { title: '审查策略', description: 'Fast / Full 模式、审查维度与阻断阈值' },
  { title: '静态分析', description: '启用的工具与圈复杂度阈值' },
  { title: '知识库与报告', description: 'RAG 路径、召回数量与报告输出格式' },
];

/** 配置初始化：生成默认 .ai-review.yml。 */
export function AdminInitPage(): ReactElement {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { notifyError } = useNotify();
  const [created, setCreated] = useState(false);
  const [conflict, setConflict] = useState(false);

  const initMutation = useMutation({
    mutationFn: initializeConfig,
    onSuccess: () => {
      setConflict(false);
      setCreated(true);
      void queryClient.invalidateQueries({ queryKey: ['admin-config'] });
    },
    onError: (e) => {
      if (getErrorStatus(e) === 409) {
        setConflict(true);
        return;
      }
      notifyError(e, { title: '生成配置失败' });
    },
  });

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Admin / Init"
        title="配置初始化"
        description="为当前工作区生成默认的 .ai-review.yml 配置文件，之后可在系统配置中进一步调整。"
      />
      {created ? (
        <Card className="surface-card">
          <Result
            icon={<CheckCircleOutlined style={{ color: 'var(--success)' }} />}
            title="配置文件已生成"
            subTitle="默认配置已写入 .ai-review.yml。你可以前往 AI 模型配置或系统配置页面继续调整。"
            extra={
              <Button type="primary" onClick={() => void navigate({ to: '/admin/config' })}>
                前往系统配置
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {conflict ? (
            <Alert
              type="warning"
              showIcon
              title="配置文件已存在"
              description="检测到工作区已存在 .ai-review.yml，为避免覆盖现有配置，初始化已取消。如需重置，请先手动备份并删除该文件。"
              action={
                <Button size="small" onClick={() => void navigate({ to: '/admin/config' })}>
                  前往系统配置
                </Button>
              }
            />
          ) : null}
          {initMutation.isError && !conflict ? (
            <ErrorAlert
              error={initMutation.error}
              title="生成配置失败"
              onRetry={() => initMutation.mutate()}
            />
          ) : null}
          <Card className="surface-card" title={<CardHeading title="将创建的配置段" />}>
            <Typography.Paragraph>
              点击下方按钮，系统会根据内置配置 schema 生成一份包含默认值的{' '}
              <Typography.Text code>.ai-review.yml</Typography.Text>：
            </Typography.Paragraph>
            <ul className="report-list">
              {CONFIG_SECTIONS.map((section) => (
                <li key={section.title}>
                  <strong>{section.title}</strong>
                  <span className="table-muted"> · {section.description}</span>
                </li>
              ))}
            </ul>
            <Button
              className="tool-action"
              type="primary"
              icon={<FileTextOutlined />}
              loading={initMutation.isPending}
              onClick={() => initMutation.mutate()}
            >
              生成默认配置
            </Button>
          </Card>
        </>
      )}
    </div>
  );
}
