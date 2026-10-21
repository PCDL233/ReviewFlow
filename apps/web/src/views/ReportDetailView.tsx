import { useState } from 'react';
import type { ReactElement } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  Card,
  Descriptions,
  Drawer,
  Dropdown,
  Empty,
  Input,
  Modal,
  Progress,
  Select,
  Skeleton,
  Space,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  CommentOutlined,
  CopyOutlined,
  DeleteOutlined,
  DiffOutlined,
  DownloadOutlined,
  FileTextOutlined,
  MoreOutlined,
  PrinterOutlined,
  ReloadOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { AgentDimension, Severity } from '@ai-review/shared';
import { describeLlmStatus, severityMeetsThreshold } from '@ai-review/shared/api';
import type {
  FindingComment,
  FindingStatus,
  IdentifiedFinding,
  ReviewCompare,
  ReviewDecision,
  ReviewDecisionEvent,
  ReviewReportDetail,
  ReviewTrace,
} from '@ai-review/shared/api';
import { FalsePositiveSwitch } from '../components/FalsePositiveSwitch';
import { DiffViewer } from '../components/DiffViewer';
import {
  addFindingComment,
  deleteReview,
  fetchFindingComments,
  fetchReviewCompare,
  fetchReviewDecisions,
  fetchReviewDetail,
  fetchReviewDiff,
  fetchReviewExport,
  fetchReviewPage,
  fetchReviewTrace,
  rerunReview,
  reviewExportUrl,
  submitReviewDecision,
  updateFindingStatus,
} from '../api';
import { openReportWindow, printReportInto } from '../lib/report-export';
import { CardHeading, PageHeader } from '../components/PageHeader';
import { ErrorAlert } from '../components/ErrorAlert';
import { EmptyState } from '../components/EmptyState';
import { PageSkeleton } from '../components/RouteState';
import { SeverityTag, SEVERITY_LABELS } from '../components/SeverityTag';
import { StatusTag } from '../components/StatusTag';
import { useNotify } from '../hooks/use-notify';
import { formatDateTime, formatDuration, formatNumber } from '../format';

const AGENT_LABELS: Record<AgentDimension, string> = {
  correctness: '正确性',
  security: '安全性',
  performance: '性能',
  static: '静态分析',
};

const DECISION_LABELS: Record<ReviewDecision, string> = {
  approve: '已通过',
  request_changes: '要求修改',
  comment: '已评论',
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
  const { message, modal } = App.useApp();
  const { notifyError } = useNotify();
  const queryClient = useQueryClient();
  const [severityFilter, setSeverityFilter] = useState<Severity | 'ALL'>('ALL');
  const [agentFilter, setAgentFilter] = useState<AgentDimension | 'ALL'>('ALL');
  const [keyword, setKeyword] = useState('');
  const [hideFalsePositive, setHideFalsePositive] = useState(false);
  const [commentFinding, setCommentFinding] = useState<IdentifiedFinding | undefined>(undefined);
  const [compareOpen, setCompareOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedFindingId, setSelectedFindingId] = useState<number | undefined>(undefined);

  /** Diff 行尾标记 → 切到发现列表并滚动/高亮目标发现 */
  const focusFinding = (finding: IdentifiedFinding): void => {
    setActiveTab('findings');
    setSelectedFindingId(finding.id);
    setSeverityFilter('ALL');
    setAgentFilter('ALL');
    setKeyword('');
    setHideFalsePositive(false);
    window.requestAnimationFrame(() => {
      document
        .getElementById(`finding-${finding.id}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  const detailQuery = useQuery({
    queryKey: ['review', props.reviewId],
    queryFn: () => fetchReviewDetail(props.reviewId),
  });
  const diffQuery = useQuery({
    queryKey: ['review-diff', props.reviewId],
    queryFn: () => fetchReviewDiff(props.reviewId),
  });
  const traceQuery = useQuery({
    queryKey: ['review-trace', props.reviewId],
    queryFn: () => fetchReviewTrace(props.reviewId),
  });
  const decisionsQuery = useQuery({
    queryKey: ['review-decisions', props.reviewId],
    queryFn: () => fetchReviewDecisions(props.reviewId),
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
  const decisionMutation = useMutation({
    mutationFn: (decision: ReviewDecision) => submitReviewDecision(props.reviewId, decision),
    onSuccess: () => {
      void message.success('审查决策已记录');
      void queryClient.invalidateQueries({ queryKey: ['review', props.reviewId] });
      void queryClient.invalidateQueries({ queryKey: ['review-decisions', props.reviewId] });
    },
    onError: (error) => notifyError(error, { title: '提交决策失败' }),
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
  const [exporting, setExporting] = useState<'markdown' | 'print' | null>(null);

  /** 复制 Markdown 源文本，便于直接粘进 PR / 文档。 */
  const handleCopyMarkdown = async (): Promise<void> => {
    setExporting('markdown');
    try {
      const markdown = await fetchReviewExport(props.reviewId, 'markdown');
      await navigator.clipboard.writeText(markdown);
      void message.success('Markdown 已复制到剪贴板');
    } catch (error) {
      notifyError(error, { title: '复制 Markdown 失败' });
    } finally {
      setExporting(null);
    }
  };

  /**
   * 打印 / 另存为 PDF。
   * 新窗口必须在点击手势内同步打开，异步取回 HTML 后再 open 会被浏览器拦截。
   */
  const handlePrint = async (): Promise<void> => {
    const win = openReportWindow();
    if (win === null) {
      void message.error('浏览器阻止了新窗口，请允许弹窗后重试');
      return;
    }
    setExporting('print');
    try {
      const html = await fetchReviewExport(props.reviewId, 'html');
      printReportInto(win, html);
    } catch (error) {
      win.close();
      notifyError(error, { title: '打印失败' });
    } finally {
      setExporting(null);
    }
  };

  const handleExportMenuClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'copy-markdown') void handleCopyMarkdown();
    if (key === 'print') void handlePrint();
  };

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
  // 阻断判定与 Hook/CI 同口径：按审查时的 blockOn 阈值，且忽略误报
  const blockOn = detail.meta.blockOn ?? 'BLOCKER';
  const blocking = detail.findings.some(
    (finding) => !finding.isFalsePositive && severityMeetsThreshold(finding.severity, blockOn),
  );

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
        description={`共 ${detail.findings.length} 个发现 · BLOCKER ${blockerCount} · WARNING ${warningCount} · 审查结论分 ${detail.meta.reviewScore ?? detail.meta.riskScore}/100 · 变更风险分 ${detail.meta.changeRiskScore ?? '—'}/100`}
      />
      {status !== 'completed' && detail.meta.errorMessage !== undefined ? (
        <Alert
          type={status === 'failed' ? 'error' : 'warning'}
          showIcon
          title={status === 'failed' ? '审查失败' : '审查已取消'}
          description={detail.meta.errorMessage}
        />
      ) : null}
      {detail.meta.llmStatus !== undefined && detail.meta.llmStatus !== 'ok' ? (
        <Alert
          type={detail.meta.llmStatus === 'unavailable' ? 'error' : 'warning'}
          showIcon
          title="模型审查状态"
          description={describeLlmStatus(detail.meta.llmStatus)}
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
            { key: 'blockOn', label: '阻断阈值', children: blockOn },
            ...(detail.meta.dimensions === undefined
              ? []
              : [
                  {
                    key: 'dimensions',
                    label: '审查维度',
                    children: detail.meta.dimensions.join('、') || '未启用',
                  },
                ]),
            ...(detail.meta.cacheHits === undefined
              ? []
              : [
                  {
                    key: 'cache',
                    label: '缓存命中',
                    children: `${detail.meta.cacheHits} 个文件`,
                  },
                ]),
            ...(detail.meta.healRounds === undefined
              ? []
              : [
                  {
                    key: 'heal',
                    label: '自愈轮次',
                    children: `${detail.meta.healRounds} 轮`,
                  },
                ]),
          ]}
        />
      </Card>
      <Card className="surface-card" title={<CardHeading title="决策历史" />}>
        {decisionsQuery.data === undefined ? (
          <Skeleton active paragraph={{ rows: 2 }} />
        ) : decisionsQuery.data.length === 0 ? (
          <Empty description="尚无人工决策" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Space orientation="vertical" size={12} style={{ width: '100%' }}>
            {decisionsQuery.data.map((event: ReviewDecisionEvent) => (
              <div key={event.id}>
                <Space wrap>
                  <Tag
                    color={
                      event.decision === 'approve'
                        ? 'success'
                        : event.decision === 'request_changes'
                          ? 'error'
                          : 'default'
                    }
                  >
                    {DECISION_LABELS[event.decision]}
                  </Tag>
                  <Typography.Text type="secondary">
                    {formatDateTime(event.createdAt)} · {event.decidedBy}
                  </Typography.Text>
                </Space>
                {event.comment === null || event.comment === '' ? null : (
                  <Typography.Paragraph style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>
                    {event.comment}
                  </Typography.Paragraph>
                )}
              </div>
            ))}
          </Space>
        )}
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
            <FindingCard
              key={finding.id}
              finding={finding}
              reviewId={props.reviewId}
              focused={selectedFindingId === finding.id}
              onOpenComments={setCommentFinding}
            />
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
      <DiffViewer
        diffText={diffQuery.data}
        findings={detail.findings}
        onSelectFinding={focusFinding}
      />
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
            {detail.meta.decision === undefined ? null : (
              <Tag
                color={
                  detail.meta.decision === 'approve'
                    ? 'success'
                    : detail.meta.decision === 'request_changes'
                      ? 'error'
                      : 'default'
                }
              >
                {DECISION_LABELS[detail.meta.decision]}
              </Tag>
            )}
            <Button
              size="small"
              type="primary"
              loading={decisionMutation.isPending}
              onClick={() => decisionMutation.mutate('approve')}
            >
              通过
            </Button>
            <Button
              size="small"
              danger
              loading={decisionMutation.isPending}
              onClick={() => decisionMutation.mutate('request_changes')}
            >
              要求修改
            </Button>
            <Button size="small" icon={<DiffOutlined />} onClick={() => setCompareOpen(true)}>
              对比历史
            </Button>
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
                placement="bottomRight"
                menu={{
                  items: [
                    {
                      key: 'copy-markdown',
                      // 图标用图标组件而非裸字符，保证与菜单其他项对齐
                      icon: <CopyOutlined />,
                      label: exporting === 'markdown' ? '正在复制…' : '复制 Markdown',
                      disabled: exporting !== null,
                    },
                    { type: 'divider' },
                    {
                      key: 'html',
                      icon: <DownloadOutlined />,
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
                      icon: <FileTextOutlined />,
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
                    { type: 'divider' },
                    {
                      key: 'print',
                      icon: <PrinterOutlined />,
                      label: exporting === 'print' ? '正在准备打印…' : '打印 / 另存为 PDF',
                      disabled: exporting !== null,
                    },
                  ],
                  onClick: handleExportMenuClick,
                }}
              >
                <Button
                  icon={<MoreOutlined />}
                  aria-label="更多导出格式"
                  loading={exporting !== null}
                />
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
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: 'overview', label: '概览', children: overview },
          {
            key: 'findings',
            label: `发现列表 · ${detail.findings.length}`,
            children: findingsView,
          },
          { key: 'diff', label: 'Diff 视图', children: diffView },
          {
            key: 'trace',
            label: '调用明细',
            children: (
              <TracePanel
                trace={traceQuery.data}
                loading={traceQuery.isLoading}
                failed={traceQuery.isError}
                onRetry={() => void traceQuery.refetch()}
              />
            ),
          },
        ]}
      />
      <Modal
        open={compareOpen}
        onCancel={() => setCompareOpen(false)}
        footer={null}
        width={760}
        title="与历史审查对比"
      >
        <ComparePanel
          reviewId={props.reviewId}
          repoPath={detail.meta.repoPath}
          branch={detail.meta.branch}
        />
      </Modal>
      <Drawer
        title={commentFinding === undefined ? '发现评论' : `评论 · ${commentFinding.title}`}
        open={commentFinding !== undefined}
        onClose={() => setCommentFinding(undefined)}
        width={480}
      >
        {commentFinding === undefined ? null : <CommentThread findingId={commentFinding.id} />}
      </Drawer>
    </div>
  );
}

/** 单条发现卡片：左侧严重度色条 + 元信息 + 误报开关 + 处置状态。 */
function FindingCard(props: {
  finding: IdentifiedFinding;
  reviewId: string;
  focused: boolean;
  onOpenComments: (finding: IdentifiedFinding) => void;
}): ReactElement {
  const finding = props.finding;
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const statusMutation = useMutation({
    mutationFn: (status: FindingStatus) => updateFindingStatus(finding.id, status),
    onSuccess: () => {
      void message.success('处置状态已更新');
      void queryClient.invalidateQueries({ queryKey: ['review', props.reviewId] });
    },
    onError: (error) => {
      void message.error(error instanceof Error ? error.message : '状态更新失败');
    },
  });
  return (
    <article
      id={`finding-${finding.id}`}
      className={`finding-card severity-${finding.severity.toLowerCase()}${
        props.focused ? ' is-focused' : ''
      }`}
    >
      <div className="finding-head">
        <SeverityTag severity={finding.severity} />
        {finding.lowConfidence === true ? <Tag color="gold">低置信度</Tag> : null}
        {finding.lineScope === 'context' ? <Tag color="blue">上下文行（不阻断）</Tag> : null}
        {finding.isFalsePositive ? <Tag>已标记误报</Tag> : null}
        <span className="finding-confidence">
          置信度 {Math.round(finding.confidence * 100)}% · {AGENT_LABELS[finding.agent]}
          {finding.agents !== undefined && finding.agents.length > 1
            ? ` 等 ${finding.agents.length} 个维度`
            : ''}
          {finding.cweId === undefined ? '' : ` · ${finding.cweId}`}
        </span>
        <FalsePositiveSwitch finding={finding} reviewId={props.reviewId} />
        <Button
          size="small"
          icon={<CommentOutlined />}
          onClick={() => props.onOpenComments(finding)}
        >
          评论
        </Button>
        <Select<FindingStatus>
          size="small"
          value={finding.status ?? 'open'}
          loading={statusMutation.isPending}
          onChange={(status) => statusMutation.mutate(status)}
          style={{ width: 112 }}
          options={[
            { value: 'open', label: '待处理' },
            { value: 'acknowledged', label: '已确认' },
            { value: 'fixed', label: '已修复' },
            { value: 'ignored', label: '已忽略' },
            { value: 'false_positive', label: '误报' },
          ]}
        />
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

/** 模型调用明细：每个维度/自愈轮次一行，回答“是否降级、花了多少 token”。 */
function TracePanel(props: {
  trace: ReviewTrace | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
}): ReactElement {
  if (props.loading) return <Skeleton active />;
  if (props.failed) {
    return (
      <Alert
        type="error"
        showIcon
        title="调用明细加载失败"
        action={
          <Button size="small" onClick={props.onRetry}>
            重试
          </Button>
        }
      />
    );
  }
  const trace = props.trace;
  if (trace === undefined) return <Empty description="暂无调用明细" />;
  const statusColor: Record<string, string> = {
    ok: 'success',
    degraded: 'warning',
    mock: 'default',
    unavailable: 'error',
  };
  const columns: ColumnsType<ReviewTrace['llmCalls'][number]> = [
    {
      title: '维度 / 轮次',
      key: 'dimension',
      width: 130,
      render: (_value, record) => (
        <Space size={4}>
          <Tag>{record.dimension}</Tag>
          <Typography.Text type="secondary">#{record.round}</Typography.Text>
        </Space>
      ),
    },
    {
      title: '服务商 / 模型',
      key: 'model',
      render: (_value, record) => `${record.provider} · ${record.model}`,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (status: string) => <Tag color={statusColor[status] ?? 'default'}>{status}</Tag>,
    },
    {
      title: 'Token（入/出/总）',
      key: 'tokens',
      width: 160,
      render: (_value, record) =>
        `${record.promptTokens}/${record.completionTokens}/${record.totalTokens}${
          record.estimated ? '（估算）' : ''
        }`,
    },
    {
      title: '耗时',
      dataIndex: 'latencyMs',
      width: 90,
      render: (value: number) => formatDuration(value),
    },
    {
      title: '尝试',
      key: 'attempts',
      width: 100,
      render: (_value, record) =>
        record.attempts.length > 1 ? `${record.attempts.length} 次` : '1 次',
    },
  ];
  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap>
        <Tag>tokens {formatNumber(trace.summary.tokenUsed)}</Tag>
        <Tag>耗时 {formatDuration(trace.summary.durationMs)}</Tag>
        <Tag>结论分 {trace.summary.reviewScore}</Tag>
        {trace.summary.llmStatus === undefined ? null : (
          <Tag>{describeLlmStatus(trace.summary.llmStatus)}</Tag>
        )}
        <Tag>缓存命中 {trace.summary.cacheHits}</Tag>
        <Tag>自愈 {trace.summary.healRounds} 轮</Tag>
      </Space>
      {trace.llmCalls.length === 0 ? (
        <Empty description="本次未调用模型（可能仅完成静态分析）" />
      ) : (
        <Table
          size="small"
          rowKey={(record) =>
            `${record.dimension}-${record.round}-${record.provider}-${record.latencyMs}`
          }
          columns={columns}
          dataSource={trace.llmCalls}
          pagination={false}
          scroll={{ x: 800 }}
        />
      )}
      <Card size="small" title="节点检查点">
        {trace.stages.length === 0 ? (
          <Empty description="本次没有节点检查点" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <Space wrap>
            {trace.stages.map((stage) => (
              <Tag key={stage.id} color={stage.status === 'failed' ? 'error' : 'default'}>
                {stage.node} · {formatDuration(stage.durationMs)}
                {stage.status === 'failed' ? ' · 失败' : ''}
              </Tag>
            ))}
          </Space>
        )}
      </Card>
    </Space>
  );
}

/** 单条发现的评论线程（人工协作；不参与审查判定）。 */
function CommentThread(props: { findingId: number }): ReactElement {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const commentsQuery = useQuery({
    queryKey: ['finding-comments', props.findingId],
    queryFn: () => fetchFindingComments(props.findingId),
  });
  const mutation = useMutation({
    mutationFn: () => addFindingComment(props.findingId, body.trim()),
    onSuccess: () => {
      setBody('');
      void message.success('评论已提交');
      void queryClient.invalidateQueries({ queryKey: ['finding-comments', props.findingId] });
    },
    onError: (error: unknown) => {
      void message.error(error instanceof Error ? error.message : '评论提交失败');
    },
  });
  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      {commentsQuery.data === undefined ? (
        <Skeleton active />
      ) : commentsQuery.data.length === 0 ? (
        <Empty description="还没有评论" />
      ) : (
        commentsQuery.data.map((comment: FindingComment) => (
          <Card key={comment.id} size="small">
            <Space orientation="vertical" size={4}>
              <Space>
                <Typography.Text strong>{comment.username}</Typography.Text>
                <Typography.Text type="secondary">
                  {formatDateTime(comment.createdAt)}
                </Typography.Text>
              </Space>
              <Typography.Paragraph style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                {comment.body}
              </Typography.Paragraph>
            </Space>
          </Card>
        ))
      )}
      <Input.TextArea
        rows={3}
        maxLength={2000}
        showCount
        value={body}
        placeholder="补充复核结论、修复说明或误报理由…"
        onChange={(event) => setBody(event.target.value)}
      />
      <Button
        type="primary"
        loading={mutation.isPending}
        disabled={body.trim() === ''}
        onClick={() => mutation.mutate()}
      >
        提交评论
      </Button>
    </Space>
  );
}

function CompareFindingRow(props: { finding: IdentifiedFinding }): ReactElement {
  return (
    <div className="compare-row">
      <SeverityTag severity={props.finding.severity} />
      <Typography.Text code>
        {props.finding.filePath}:{props.finding.lineStart}
      </Typography.Text>
      <span>{props.finding.title}</span>
    </div>
  );
}

function CompareFindingList(props: {
  title: string;
  findings: IdentifiedFinding[];
  emptyText: string;
}): ReactElement {
  return (
    <Card size="small" title={`${props.title} · ${props.findings.length}`}>
      {props.findings.length === 0 ? (
        <Empty description={props.emptyText} image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <Space orientation="vertical" size={8} style={{ width: '100%' }}>
          {props.findings.slice(0, 20).map((finding) => (
            <CompareFindingRow key={finding.id} finding={finding} />
          ))}
          {props.findings.length > 20 ? (
            <Typography.Text type="secondary">
              其余 {props.findings.length - 20} 条见完整报告
            </Typography.Text>
          ) : null}
        </Space>
      )}
    </Card>
  );
}

/** 选择同一仓库/分支的历史审查并与当前报告对比。 */
function ComparePanel(props: { reviewId: string; repoPath: string; branch: string }): ReactElement {
  const [baseId, setBaseId] = useState<string | undefined>(undefined);
  const candidatesQuery = useQuery({
    queryKey: ['compare-candidates', props.repoPath, props.branch],
    queryFn: () => fetchReviewPage({ repo: props.repoPath, branch: props.branch, pageSize: 50 }),
  });
  const compareQuery = useQuery({
    queryKey: ['compare', props.reviewId, baseId],
    queryFn: () => fetchReviewCompare(props.reviewId, baseId ?? ''),
    enabled: baseId !== undefined,
  });
  const candidates = (candidatesQuery.data?.reviews ?? []).filter(
    (review) => review.reviewId !== props.reviewId,
  );
  return (
    <Space orientation="vertical" size={16} style={{ width: '100%' }}>
      <Select
        placeholder="选择要对比的历史审查"
        value={baseId ?? null}
        onChange={(value: string) => setBaseId(value)}
        loading={candidatesQuery.isLoading}
        style={{ width: '100%' }}
        options={candidates.map((review) => ({
          value: review.reviewId,
          label: `${formatDateTime(review.createdAt)} · ${review.riskScore} 分 · ${review.blockerCount} BLOCKER · ${review.reviewId}`,
        }))}
      />
      {baseId === undefined ? (
        <Empty description="选择一次历史审查后开始对比" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : compareQuery.isLoading ? (
        <Skeleton active />
      ) : compareQuery.isError ? (
        <ErrorAlert
          error={compareQuery.error}
          title="对比失败"
          onRetry={() => void compareQuery.refetch()}
        />
      ) : compareQuery.data === undefined ? null : (
        <CompareResult compare={compareQuery.data} />
      )}
    </Space>
  );
}

function CompareResult(props: { compare: ReviewCompare }): ReactElement {
  const compare = props.compare;
  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      <Space wrap>
        <Tag color="error">新增 {compare.summary.added}</Tag>
        <Tag color="success">已修复 {compare.summary.resolved}</Tag>
        <Tag color="warning">仍存在 {compare.summary.persisting}</Tag>
      </Space>
      <CompareFindingList title="本次新增" findings={compare.added} emptyText="没有新增问题" />
      <CompareFindingList
        title="上次已修复"
        findings={compare.resolved}
        emptyText="没有已修复的问题"
      />
      <CompareFindingList
        title="两次仍存在"
        findings={compare.persisting}
        emptyText="没有持续存在的问题"
      />
    </Space>
  );
}
