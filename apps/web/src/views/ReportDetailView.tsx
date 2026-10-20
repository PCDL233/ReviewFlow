import { useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Dropdown,
  Input,
  Progress,
  Select,
  Skeleton,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  MoreOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type { AgentDimension, Severity } from '@ai-review/shared';
import type { IdentifiedFinding, ReviewReportDetail } from '@ai-review/shared/api';
import { FalsePositiveSwitch } from '../components/FalsePositiveSwitch';
import { DiffViewer } from '../components/DiffViewer';
import {
  deleteReview,
  fetchReviewDetail,
  fetchReviewDiff,
  rerunReview,
  reviewExportUrl,
} from '../api';
import { CardHeading, PageHeader } from '../components/PageHeader';
import { ErrorAlert } from '../components/ErrorAlert';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/RouteState';
import { SeverityTag, SEVERITY_LABELS } from '../components/SeverityTag';
import { StatusTag } from '../components/StatusTag';
import { useNotify } from '../hooks/use-notify';
import { formatDuration, formatNumber } from '../format';

const AGENT_LABELS: Record<AgentDimension, string> = {
  correctness: '正确性',
  security: '安全性',
  performance: '性能',
  static: '静态分析',
};

const SEVERITY_ORDER: Severity[] = ['BLOCKER', 'WARNING', 'NIT', 'PRAISE'];

/** 严重度统计小卡（概览区）。 */
function SeveritySummary(props: { findings: readonly IdentifiedFinding[] }): ReactElement {
  return (
    <div className="severity-summary">
      {SEVERITY_ORDER.map((severity) => {
        const count = props.findings.filter((finding) => finding.severity === severity).length;
        return (
          <div key={severity} className={`severity-stat severity-${severity.toLowerCase()}`}>
            <span className="severity-stat-label">{SEVERITY_LABELS[severity]}</span>
            <span className="severity-stat-value">{count}</span>
            <span className="severity-stat-code">{severity}</span>
          </div>
        );
      })}
    </div>
  );
}

function severityCount(detail: ReviewReportDetail, severity: Severity): number {
  return detail.findings.filter((finding) => finding.severity === severity).length;
}

/** 审查报告详情：概览 / 发现 / Diff 三个视图。 */
export function ReportDetailView(props: { reviewId: string; onBack: () => void }): ReactElement {
  const { message } = App.useApp();
  const { notifyError } = useNotify();
  const queryClient = useQueryClient();
  const [severityFilter, setSeverityFilter] = useState<Severity | 'ALL'>('ALL');
  const [agentFilter, setAgentFilter] = useState<AgentDimension | 'ALL'>('ALL');
  const [keyword, setKeyword] = useState('');
  const [hideFalsePositive, setHideFalsePositive] = useState(false);

  const detailQuery = useQuery({
    queryKey: ['review', props.reviewId],
    queryFn: () => fetchReviewDetail(props.reviewId),
  });
  const diffQuery = useQuery({
    queryKey: ['review-diff', props.reviewId],
    queryFn: () => fetchReviewDiff(props.reviewId),
  });
  const rerunMutation = useMutation({
    mutationFn: () => rerunReview(props.reviewId),
    onSuccess: (reviewId) => {
      void message.success(`已创建新的审查任务：${reviewId}`);
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
      props.onBack();
    },
    onError: (error) => notifyError(error, { title: '重跑失败' }),
  });
  const deleteMutation = useMutation({
    mutationFn: () => deleteReview(props.reviewId),
    onSuccess: () => {
      void message.success('审查记录已删除');
      void queryClient.invalidateQueries({ queryKey: ['reviews'] });
      props.onBack();
    },
    onError: (error) => notifyError(error, { title: '删除失败' }),
  });

  const { modal } = App.useApp();

  if (detailQuery.isPending) return <PageSkeleton rows={10} />;
  if (detailQuery.isError) {
    return (
      <div className="page-stack">
        <PageHeader
          eyebrow="Review report"
          title="审查报告"
          back={{ label: '返回历史', onClick: props.onBack }}
        />
        <ErrorAlert
          error={detailQuery.error}
          title="报告加载失败"
          onRetry={() => void detailQuery.refetch()}
        />
      </div>
    );
  }

  const detail = detailQuery.data;
  const status = detail.meta.status ?? 'completed';
  const blockerCount = severityCount(detail, 'BLOCKER');
  const warningCount = severityCount(detail, 'WARNING');
  const blocking = blockerCount > 0;

  const normalizedKeyword = keyword.trim().toLowerCase();
  const filteredFindings = detail.findings.filter((finding) => {
    if (severityFilter !== 'ALL' && finding.severity !== severityFilter) return false;
    if (agentFilter !== 'ALL' && finding.agent !== agentFilter) return false;
    if (hideFalsePositive && finding.isFalsePositive) return false;
    if (normalizedKeyword !== '') {
      const haystack = `${finding.title} ${finding.description} ${finding.filePath}`.toLowerCase();
      if (!haystack.includes(normalizedKeyword)) return false;
    }
    return true;
  });

  const overview = (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Alert
        type={blocking ? 'error' : 'success'}
        showIcon
        title={detail.assessment}
        description={`共 ${detail.findings.length} 个发现 · BLOCKER ${blockerCount} · WARNING ${warningCount} · 风险分 ${detail.meta.riskScore}/100`}
      />
      {status !== 'completed' && detail.meta.errorMessage !== undefined ? (
        <Alert
          type={status === 'failed' ? 'error' : 'warning'}
          showIcon
          title={status === 'failed' ? '审查失败' : '审查已取消'}
          description={detail.meta.errorMessage}
        />
      ) : null}
      {detail.degradedToStatic.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          title="预算受限，部分文件已降级为仅静态分析"
          description={detail.degradedToStatic.join('、')}
        />
      ) : null}
      <SeveritySummary findings={detail.findings} />
      <Card className="surface-card" title={<CardHeading title="变更概述" />}>
        <Typography.Paragraph className="report-copy">{detail.summary}</Typography.Paragraph>
      </Card>
      <Card className="surface-card" title={<CardHeading title="审查元信息" />}>
        <Descriptions
          className="meta-grid"
          column={{ xs: 1, sm: 2, lg: 3 }}
          items={[
            { key: 'repo', label: '仓库', children: detail.meta.repoPath },
            { key: 'branch', label: '分支', children: detail.meta.branch },
            ...(detail.meta.commitHash === undefined
              ? []
              : [
                  {
                    key: 'commit',
                    label: '提交',
                    children: (
                      <Typography.Text code copyable={{ text: detail.meta.commitHash }}>
                        {detail.meta.commitHash.slice(0, 10)}
                      </Typography.Text>
                    ),
                  },
                ]),
            { key: 'model', label: '审查模型', children: detail.meta.model },
            { key: 'duration', label: '耗时', children: formatDuration(detail.meta.durationMs) },
            { key: 'token', label: 'Token', children: formatNumber(detail.meta.tokenUsed) },
          ]}
        />
      </Card>
      <div className="report-columns">
        <Card className="surface-card" title={<CardHeading title="代码质量考量" />}>
          {detail.qualityNotes.length > 0 ? (
            <ul className="report-list">
              {detail.qualityNotes.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <EmptyState title="暂无额外质量说明" description="本次审查未补充质量层面的观察。" />
          )}
        </Card>
        <Card className="surface-card" title={<CardHeading title="改进建议" />}>
          {detail.suggestions.length > 0 ? (
            <ul className="report-list">
              {detail.suggestions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <EmptyState title="暂无改进建议" description="没有需要额外采纳的改进项。" />
          )}
        </Card>
      </div>
    </Space>
  );

  const findingsView = (
    <div className="finding-view">
      <Card className="surface-card filter-card">
        <div className="filter-grid">
          <label className="filter-field">
            <span className="filter-label">严重度</span>
            <Select<Severity | 'ALL'>
              value={severityFilter}
              onChange={(value) => setSeverityFilter(value)}
              options={[
                { value: 'ALL', label: '全部严重度' },
                ...SEVERITY_ORDER.map((severity) => ({
                  value: severity,
                  label: `${severity} · ${SEVERITY_LABELS[severity]}`,
                })),
              ]}
            />
          </label>
          <label className="filter-field">
            <span className="filter-label">Agent</span>
            <Select<AgentDimension | 'ALL'>
              value={agentFilter}
              onChange={(value) => setAgentFilter(value)}
              options={[
                { value: 'ALL', label: '全部 Agent' },
                ...(Object.keys(AGENT_LABELS) as AgentDimension[]).map((agent) => ({
                  value: agent,
                  label: AGENT_LABELS[agent],
                })),
              ]}
            />
          </label>
          <label className="filter-field filter-field-wide">
            <span className="filter-label">关键词</span>
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="搜索标题、描述或文件路径"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
          </label>
          <label className="filter-field filter-field-inline">
            <span className="filter-label">隐藏误报</span>
            <Switch
              checked={hideFalsePositive}
              onChange={setHideFalsePositive}
              aria-label="隐藏已标记为误报的发现"
            />
          </label>
        </div>
        <div className="filter-actions">
          <Typography.Text type="secondary">
            显示 {filteredFindings.length} / {detail.findings.length} 条发现
          </Typography.Text>
        </div>
      </Card>

      {detail.findings.length === 0 ? (
        <EmptyState
          title="本次未发现问题"
          description="这个提交没有触发任何规则或 Agent 的告警，可以放心合入。"
        />
      ) : filteredFindings.length === 0 ? (
        <EmptyState
          title="没有匹配的发现"
          description="调整严重度、Agent 或关键词筛选后再试。"
          action={
            <Button
              onClick={() => {
                setSeverityFilter('ALL');
                setAgentFilter('ALL');
                setKeyword('');
                setHideFalsePositive(false);
              }}
            >
              清空筛选
            </Button>
          }
        />
      ) : (
        <div className="finding-list">
          {filteredFindings.map((finding) => (
            <FindingCard key={finding.id} finding={finding} reviewId={props.reviewId} />
          ))}
        </div>
      )}
    </div>
  );

  const diffView = diffQuery.isError ? (
    <ErrorAlert
      error={diffQuery.error}
      title="Diff 加载失败"
      onRetry={() => void diffQuery.refetch()}
    />
  ) : diffQuery.isPending ? (
    <Card className="surface-card">
      <Skeleton active paragraph={{ rows: 12 }} />
    </Card>
  ) : (
    <Card className="surface-card" title={<CardHeading title="代码变更" />}>
      <DiffViewer diffText={diffQuery.data} findings={detail.findings} />
    </Card>
  );

  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="Review report"
        title="审查报告"
        description={`任务 ${detail.meta.reviewId} · ${detail.meta.repoPath} · ${detail.meta.branch}`}
        back={{ label: '返回历史', onClick: props.onBack }}
        extra={
          <Button
            icon={<CopyOutlined />}
            onClick={() =>
              void navigator.clipboard.writeText(detail.meta.reviewId).then(
                () => void message.success('审查 ID 已复制'),
                () => void message.error('复制失败'),
              )
            }
          >
            复制 ID
          </Button>
        }
        actions={
          <Space wrap>
            <Tag color={detail.meta.mode === 'full' ? 'blue' : 'default'}>
              {detail.meta.mode.toUpperCase()}
            </Tag>
            <StatusTag status={status} />
            <Progress
              type="circle"
              size={44}
              percent={Math.min(100, Math.max(0, Math.round(detail.meta.riskScore)))}
              strokeColor={blocking ? 'var(--error)' : 'var(--success)'}
              railColor="var(--line-soft)"
              format={(percent) => <span className="report-risk-value">{percent}</span>}
            />
            <Space.Compact>
              <Button
                icon={<DownloadOutlined />}
                href={reviewExportUrl(props.reviewId, 'markdown')}
                target="_blank"
              >
                导出 Markdown
              </Button>
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    {
                      key: 'html',
                      label: (
                        <a
                          href={reviewExportUrl(props.reviewId, 'html')}
                          target="_blank"
                          rel="noreferrer"
                        >
                          导出 HTML
                        </a>
                      ),
                    },
                    {
                      key: 'json',
                      label: (
                        <a
                          href={reviewExportUrl(props.reviewId, 'json')}
                          target="_blank"
                          rel="noreferrer"
                        >
                          导出 JSON
                        </a>
                      ),
                    },
                  ],
                }}
              >
                <Button icon={<MoreOutlined />} aria-label="更多导出格式" />
              </Dropdown>
            </Space.Compact>
            <Button
              icon={<ReloadOutlined />}
              loading={rerunMutation.isPending}
              onClick={() => rerunMutation.mutate()}
            >
              重新审查
            </Button>
            <Button
              danger
              icon={<DeleteOutlined />}
              loading={deleteMutation.isPending}
              onClick={() =>
                void modal.confirm({
                  title: '确定删除这条审查记录吗？',
                  content: '删除后报告、发现和 Diff 将无法恢复。',
                  okText: '删除',
                  okButtonProps: { danger: true },
                  cancelText: '取消',
                  onOk: () => deleteMutation.mutate(),
                })
              }
            >
              删除
            </Button>
          </Space>
        }
      />
      <Tabs
        defaultActiveKey="overview"
        items={[
          { key: 'overview', label: '概览', children: overview },
          {
            key: 'findings',
            label: `发现列表 · ${detail.findings.length}`,
            children: findingsView,
          },
          { key: 'diff', label: 'Diff 视图', children: diffView },
        ]}
      />
    </div>
  );
}

/** 单条发现卡片：左侧严重度色条 + 元信息 + 误报开关。 */
function FindingCard(props: { finding: IdentifiedFinding; reviewId: string }): ReactElement {
  const finding = props.finding;
  return (
    <article className={`finding-card severity-${finding.severity.toLowerCase()}`}>
      <div className="finding-head">
        <SeverityTag severity={finding.severity} />
        {finding.lowConfidence === true ? <Tag color="gold">低置信度</Tag> : null}
        {finding.isFalsePositive ? <Tag>已标记误报</Tag> : null}
        <span className="finding-confidence">
          置信度 {Math.round(finding.confidence * 100)}% · {AGENT_LABELS[finding.agent]}
          {finding.cweId === undefined ? '' : ` · ${finding.cweId}`}
        </span>
        <FalsePositiveSwitch finding={finding} reviewId={props.reviewId} />
      </div>
      <h3 className="finding-title">{finding.title}</h3>
      <p className="finding-description">{finding.description}</p>
      <div className="finding-location">
        {finding.filePath}:{finding.lineStart}
        {finding.lineEnd > finding.lineStart ? `-${finding.lineEnd}` : ''}
      </div>
      {finding.codeSnippet === undefined ? null : (
        <pre className="finding-snippet">
          <code>{finding.codeSnippet}</code>
        </pre>
      )}
      {finding.suggestion === undefined ? null : (
        <div className="finding-suggestion">
          <span className="finding-suggestion-label">建议</span>
          <span>{finding.suggestion}</span>
        </div>
      )}
    </article>
  );
}
