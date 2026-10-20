import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  Button,
  Card,
  Col,
  Form,
  Input,
  Popconfirm,
  Progress,
  Radio,
  Row,
  Select,
  Space,
  Steps,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import {
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloseCircleOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { STAGE_GROUPS, terminalLabel, useReviewEvents } from '../hooks/use-review-events';
import type { CompletedResult } from '../hooks/use-review-events';
import { cancelReview, startReview } from '../api';
import { CardHeading, PageHeader } from '../components/PageHeader';
import { useNotify } from '../hooks/use-notify';
import { ErrorAlert } from '../components/ErrorAlert';
import { RiskScore } from '../components/RiskScore';
import { formatDuration } from '../format';

type RunFormValues = {
  repoPath: string;
  mode?: 'fast' | 'full';
  blockOn?: 'BLOCKER' | 'WARNING' | 'NIT';
};

export type RunReviewViewProps = {
  /** 只有用户点击「查看完整报告」时才回调，避免审查完成即跳走。 */
  onOpenReport: (reviewId: string) => void;
};

const MODE_OPTIONS = [
  {
    value: 'fast' as const,
    title: 'Fast · 快速反馈',
    detail: '只审查高风险文件，适合提交前的快速检查。',
  },
  {
    value: 'full' as const,
    title: 'Full · 完整分析',
    detail: '全量文件 + 全部维度，适合合并前的深度审查。',
  },
];

const CONNECTION_LABEL: Record<string, { text: string; color: string }> = {
  connecting: { text: '连接中', color: 'processing' },
  open: { text: '已连接', color: 'success' },
  error: { text: '连接中断', color: 'error' },
  closed: { text: '连接已关闭', color: 'default' },
};

/** 发起审查：左侧配置，右侧流程说明；完成态保留在页面并等待用户查看报告。 */
export function RunReviewView(props: RunReviewViewProps): ReactElement {
  const [form] = Form.useForm<RunFormValues>();
  const [runningId, setRunningId] = useState<string | undefined>(undefined);
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAtRef = useRef<number | undefined>(undefined);
  const queryClient = useQueryClient();
  const { notifyError } = useNotify();

  const startMutation = useMutation({
    mutationFn: (values: RunFormValues) =>
      startReview(values.repoPath.trim(), values.mode, values.blockOn),
    onSuccess: (reviewId) => {
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setRunningId(reviewId);
    },
    onError: (e) => notifyError(e, { title: '发起审查失败' }),
  });
  const cancelMutation = useMutation({
    mutationFn: () => cancelReview(runningId ?? ''),
    onError: (e) => notifyError(e, { title: '取消审查失败' }),
  });

  const progress = useReviewEvents(runningId, (failed) => {
    void queryClient.invalidateQueries({ queryKey: ['reviews'] });
    void queryClient.invalidateQueries({ queryKey: ['stats'] });
    if (!failed) void queryClient.invalidateQueries({ queryKey: ['review'] });
  });

  // 本地计时器：仅在运行中推进，终态后停止
  useEffect(() => {
    if (runningId === undefined || progress.finished) return;
    const timer = window.setInterval(() => {
      if (startedAtRef.current !== undefined) {
        setElapsedMs(Date.now() - startedAtRef.current);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [runningId, progress.finished]);

  const status = terminalLabel(progress);
  const connection = CONNECTION_LABEL[progress.connection] ?? {
    text: '未知',
    color: 'default',
  };
  const running = runningId !== undefined && !progress.finished;

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Review workspace"
        title="发起一次代码审查"
        description="选择仓库、审查模式和阻断阈值，实时跟踪分析进度，完成后查看报告。"
      />
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={14}>
          <Card className="surface-card" title={<CardHeading title="审查配置" />}>
            <Form<RunFormValues>
              form={form}
              className="review-form"
              layout="vertical"
              initialValues={{ mode: 'fast' }}
              onFinish={(values) => startMutation.mutate(values)}
            >
              <Form.Item
                label="仓库路径"
                name="repoPath"
                rules={[
                  { required: true, whitespace: true, message: '请输入仓库路径' },
                  {
                    validator: (_rule, value: string | undefined) => {
                      if (value === undefined || value.trim() === '') return Promise.resolve();
                      if (!/[\\/]/.test(value.trim())) {
                        return Promise.reject(new Error('请输入完整的绝对路径'));
                      }
                      return Promise.resolve();
                    },
                  },
                ]}
              >
                <Input
                  size="large"
                  prefix={<FolderOpenOutlined />}
                  placeholder="例如：D:/Code/your-project"
                  disabled={running}
                />
              </Form.Item>
              <Form.Item
                label="审查模式"
                name="mode"
                extra="Fast 只审查高风险文件，Full 会覆盖全部变更文件。"
              >
                <Radio.Group className="mode-group" disabled={running}>
                  {MODE_OPTIONS.map((option) => (
                    <Radio.Button key={option.value} value={option.value} className="mode-option">
                      <span className="mode-option-title">{option.title}</span>
                      <span className="mode-option-desc">{option.detail}</span>
                    </Radio.Button>
                  ))}
                </Radio.Group>
              </Form.Item>
              <Form.Item
                label={
                  <Tooltip title="达到该严重度时，审查判定为阻断；未选择时使用系统配置的默认阈值。">
                    <span>阻断阈值</span>
                  </Tooltip>
                }
                name="blockOn"
                extra="不选择则沿用系统配置中的默认阈值。"
              >
                <Select
                  size="large"
                  placeholder="使用系统默认"
                  allowClear
                  disabled={running}
                  options={[
                    { value: 'BLOCKER', label: 'BLOCKER · 仅严重问题阻断' },
                    { value: 'WARNING', label: 'WARNING · 警告及以上阻断' },
                    { value: 'NIT', label: 'NIT · 任何问题都阻断' },
                  ]}
                />
              </Form.Item>
              <Form.Item className="review-form-actions">
                <Space wrap>
                  <Button
                    type="primary"
                    size="large"
                    htmlType="submit"
                    icon={<ThunderboltOutlined />}
                    loading={startMutation.isPending}
                    disabled={running}
                  >
                    {running ? '审查进行中…' : '开始审查'}
                  </Button>
                  {running ? (
                    <Popconfirm
                      title="取消当前审查？"
                      description="已产生的部分结果不会保留。"
                      okText="取消审查"
                      cancelText="继续等待"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => cancelMutation.mutate()}
                    >
                      <Button danger loading={cancelMutation.isPending}>
                        取消审查
                      </Button>
                    </Popconfirm>
                  ) : null}
                  {runningId !== undefined && progress.finished ? (
                    <Button
                      icon={<ReloadOutlined />}
                      onClick={() => {
                        setRunningId(undefined);
                        setElapsedMs(0);
                        startedAtRef.current = undefined;
                      }}
                    >
                      再运行一次
                    </Button>
                  ) : null}
                </Space>
              </Form.Item>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card className="surface-card" title={<CardHeading title="审查如何工作" />}>
            <ol className="how-it-works">
              <li>
                <strong>解析暂存区变更</strong>
                <span>读取当前分支与基准分支的 diff，按文件构建上下文。</span>
              </li>
              <li>
                <strong>风险规划</strong>
                <span>按变更规模与类型评分，决定深度审查还是仅静态分析。</span>
              </li>
              <li>
                <strong>多 Agent 并行</strong>
                <span>正确性、安全性、性能与静态分析同时执行。</span>
              </li>
              <li>
                <strong>交叉验证与报告</strong>
                <span>重算严重度与置信度，去重后生成五段式报告。</span>
              </li>
            </ol>
            <div className="how-it-works-meta">
              <div>
                <ClockCircleOutlined /> Fast 通常 30–90 秒，Full 可能数分钟。
              </div>
              <div>
                <CheckCircleOutlined /> 阻断阈值决定 CLI 退出码，不影响报告生成。
              </div>
            </div>
          </Card>
        </Col>
      </Row>

      {startMutation.isError ? (
        <ErrorAlert
          error={startMutation.error}
          title="发起审查失败"
          description="请检查仓库路径是否在允许的根目录内，或稍后重试。"
        />
      ) : null}

      {runningId !== undefined ? (
        <Card
          className="surface-card progress-card"
          title={<CardHeading title="实时进度" />}
          extra={
            <Space size={6} wrap>
              <Tag color={connection.color}>{connection.text}</Tag>
              <Tag
                color={
                  progress.failed
                    ? 'error'
                    : progress.cancelled
                      ? 'default'
                      : progress.finished
                        ? 'success'
                        : 'processing'
                }
              >
                {status}
              </Tag>
            </Space>
          }
        >
          <div className="progress-panel">
            <div className="progress-meta">
              <div className="progress-id">
                <span className="progress-id-label">审查任务</span>
                <Typography.Text copyable code>
                  {runningId}
                </Typography.Text>
              </div>
              <div className="progress-timing">
                <span className="progress-id-label">已耗时</span>
                <span className="numeric-cell">{formatDuration(elapsedMs)}</span>
              </div>
            </div>
            <Steps
              className="progress-steps"
              responsive
              current={progress.step}
              status={
                progress.failed || progress.cancelled
                  ? 'error'
                  : progress.finished
                    ? 'finish'
                    : 'process'
              }
              items={STAGE_GROUPS.map((group, index) => ({
                title: group.label,
                description:
                  index === progress.step && progress.detail !== undefined
                    ? progress.detail
                    : undefined,
              }))}
            />
            {progress.detail !== undefined && !progress.finished ? (
              <div className="progress-detail" aria-live="polite">
                {progress.detail}
              </div>
            ) : null}
            {progress.failed || progress.cancelled ? (
              <Alert
                type={progress.cancelled ? 'warning' : 'error'}
                showIcon
                title={progress.cancelled ? '审查已取消' : '审查失败'}
                description={progress.message ?? '未获取到失败原因，可稍后在审查历史中查看详情。'}
                action={
                  <Button size="small" onClick={() => setRunningId(undefined)}>
                    返回修改配置
                  </Button>
                }
              />
            ) : null}
            {progress.connection === 'error' && !progress.finished ? (
              <Alert
                type="warning"
                showIcon
                title="实时连接中断"
                description="进度推送已断开，审查可能仍在服务端运行。请稍后到「审查历史」查看结果。"
              />
            ) : null}
            {progress.result !== undefined ? (
              <CompletedResultPanel
                result={progress.result}
                onOpenReport={() => props.onOpenReport(runningId)}
              />
            ) : null}
          </div>
        </Card>
      ) : (
        <Card className="surface-card empty-state-card">
          <Typography.Paragraph type="secondary" className="empty-state-copy">
            填写上方配置并点击「开始审查」即可发起新一轮代码审查；进度会实时显示在这里。
          </Typography.Paragraph>
        </Card>
      )}
    </div>
  );
}

/** 完成态摘要：风险环 + 发现计数 + 阻断结论，只有点击按钮才跳转报告。 */
function CompletedResultPanel(props: {
  result: CompletedResult;
  onOpenReport: () => void;
}): ReactElement {
  const result = props.result;
  return (
    <div className={`result-panel ${result.blocking ? 'is-blocking' : 'is-passing'}`}>
      <div className="result-summary">
        <div className="result-risk">
          <Progress
            type="circle"
            percent={Math.min(100, Math.max(0, Math.round(result.riskScore)))}
            size={104}
            strokeColor={result.blocking ? 'var(--error)' : 'var(--success)'}
            railColor="var(--line-soft)"
            format={(percent) => (
              <span className="result-risk-value">
                {percent}
                <span className="result-risk-suffix">/100</span>
              </span>
            )}
          />
          <span className="result-risk-label">风险评分</span>
        </div>
        <div className="result-copy">
          <div className="result-title">
            {result.blocking ? (
              <>
                <CloseCircleOutlined /> 审查完成：达到阻断阈值
              </>
            ) : (
              <>
                <CheckCircleOutlined /> 审查完成：未达阻断阈值
              </>
            )}
          </div>
          <div className="result-meta">
            <Tag color="error">BLOCKER × {result.blockerCount}</Tag>
            <RiskScore score={result.riskScore} showBar={false} compact />
          </div>
          <p className="result-hint">
            报告已生成，包含发现详情、变更概述与改进建议。审查结果不会自动跳转，你可以先确认摘要。
          </p>
        </div>
      </div>
      <Space>
        <Button type="primary" onClick={props.onOpenReport}>
          查看完整报告
        </Button>
      </Space>
    </div>
  );
}
