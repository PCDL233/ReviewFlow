import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ReactElement } from 'react';
import { Button, Card, Col, Row, Segmented, Skeleton, Typography } from 'antd';
import {
  AlertOutlined,
  ClockCircleOutlined,
  FileSearchOutlined,
  FireOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { EChartsCoreOption } from 'echarts/core';
import type { ReviewStats } from '@ai-review/shared/api';
import { fetchStats } from '../api';
import { getDateRange, formatDuration, formatNumber } from '../format';
import type { DateRangeKey } from '../format';
import { ChartCard } from '../components/StatChart';
import { CardHeading, PageHeader } from '../components/PageHeader';
import { LoadErrorState } from '../components/ErrorAlert';
import { EmptyState } from '../components/EmptyState';
import { StatCard } from '../components/StatCard';
import { useTheme } from '../theme-context';
import {
  areaGradient,
  chartAxisStyles,
  chartLegendStyle,
  chartPalette,
  chartTextStyle,
  chartTooltipStyle,
} from '../lib/chart-theme';
import type { ChartPalette } from '../lib/chart-theme';

function buildTrendOption(stats: ReviewStats, palette: ChartPalette): EChartsCoreOption {
  const { axisLine, splitLine } = chartAxisStyles(palette);
  const textStyle = chartTextStyle(palette);
  return {
    color: [palette.brand, palette.teal],
    tooltip: { ...chartTooltipStyle(palette), trigger: 'axis' },
    legend: { ...chartLegendStyle(palette), top: 0, data: ['平均风险分', '审查次数'] },
    grid: { left: 14, right: 18, top: 64, bottom: 12, containLabel: true },
    xAxis: {
      type: 'category',
      boundaryGap: false,
      data: stats.riskTrend.map((point) => point.date),
      axisLine,
      axisTick: { show: false },
      axisLabel: textStyle,
    },
    yAxis: [
      { type: 'value', max: 100, splitLine, axisLabel: textStyle, axisLine: { show: false } },
      {
        type: 'value',
        splitLine: { show: false },
        axisLabel: textStyle,
        axisLine: { show: false },
      },
    ],
    series: [
      {
        name: '平均风险分',
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        showSymbol: false,
        lineStyle: { width: 3 },
        itemStyle: { color: palette.brand },
        areaStyle: { color: areaGradient(palette.brand) },
        data: stats.riskTrend.map((point) => Number(point.avgRiskScore.toFixed(1))),
      },
      {
        name: '审查次数',
        type: 'bar',
        yAxisIndex: 1,
        barWidth: 14,
        itemStyle: { color: palette.teal, borderRadius: [6, 6, 0, 0] },
        data: stats.riskTrend.map((point) => point.reviews),
      },
    ],
  };
}

function buildSeverityOption(stats: ReviewStats, palette: ChartPalette): EChartsCoreOption {
  const { axisLine, splitLine } = chartAxisStyles(palette);
  const textStyle = chartTextStyle(palette);
  return {
    tooltip: { ...chartTooltipStyle(palette), trigger: 'axis' },
    grid: { left: 16, right: 16, top: 22, bottom: 18, containLabel: true },
    xAxis: {
      type: 'category',
      data: stats.severityDistribution.map((item) => item.severity),
      axisLine,
      axisTick: { show: false },
      axisLabel: textStyle,
    },
    yAxis: { type: 'value', splitLine, axisLabel: textStyle, axisLine: { show: false } },
    series: [
      {
        type: 'bar',
        barWidth: 36,
        data: stats.severityDistribution.map((item) => ({
          value: item.count,
          itemStyle: {
            color: palette.severity[item.severity],
            borderRadius: [8, 8, 0, 0],
          },
        })),
      },
    ],
  };
}

function buildAgentOption(stats: ReviewStats, palette: ChartPalette): EChartsCoreOption {
  const { axisLine, splitLine } = chartAxisStyles(palette);
  const textStyle = chartTextStyle(palette);
  return {
    tooltip: { ...chartTooltipStyle(palette), trigger: 'axis' },
    grid: { left: 18, right: 18, top: 22, bottom: 18, containLabel: true },
    xAxis: {
      type: 'category',
      data: stats.agentDistribution.map((item) => item.agent),
      axisLine,
      axisTick: { show: false },
      axisLabel: textStyle,
    },
    yAxis: { type: 'value', splitLine, axisLabel: textStyle, axisLine: { show: false } },
    series: [
      {
        type: 'bar',
        barWidth: 30,
        itemStyle: { color: palette.brand, borderRadius: [6, 6, 0, 0] },
        data: stats.agentDistribution.map((item) => item.count),
      },
    ],
  };
}

function buildTokenOption(stats: ReviewStats, palette: ChartPalette): EChartsCoreOption {
  const { axisLine, splitLine } = chartAxisStyles(palette);
  const textStyle = chartTextStyle(palette);
  return {
    tooltip: { ...chartTooltipStyle(palette), trigger: 'axis' },
    grid: { left: 18, right: 18, top: 22, bottom: 18, containLabel: true },
    xAxis: {
      type: 'category',
      data: stats.tokenTrend.map((item) => item.date),
      axisLine,
      axisTick: { show: false },
      axisLabel: textStyle,
    },
    yAxis: { type: 'value', splitLine, axisLabel: textStyle, axisLine: { show: false } },
    series: [
      {
        type: 'line',
        smooth: true,
        symbol: 'circle',
        symbolSize: 6,
        itemStyle: { color: palette.teal },
        lineStyle: { color: palette.teal, width: 2.5 },
        areaStyle: { color: areaGradient(palette.teal) },
        data: stats.tokenTrend.map((item) => item.tokenUsed),
      },
    ],
  };
}

function buildRiskyFilesOption(stats: ReviewStats, palette: ChartPalette): EChartsCoreOption {
  const { axisLine, splitLine } = chartAxisStyles(palette);
  const textStyle = chartTextStyle(palette);
  const files = [...stats.topRiskyFiles].reverse();
  return {
    tooltip: { ...chartTooltipStyle(palette), trigger: 'axis' },
    legend: { ...chartLegendStyle(palette), top: 0, data: ['发现数', 'BLOCKER'] },
    grid: { left: 8, right: 18, top: 64, bottom: 8, containLabel: true },
    xAxis: { type: 'value', splitLine, axisLabel: textStyle, axisLine: { show: false } },
    yAxis: {
      type: 'category',
      data: files.map((file) => file.filePath),
      axisLine,
      axisTick: { show: false },
      axisLabel: { ...textStyle, width: 120, overflow: 'truncate' },
    },
    series: [
      {
        name: '发现数',
        type: 'bar',
        itemStyle: { color: palette.brandSoft, borderRadius: [0, 6, 6, 0] },
        data: files.map((file) => file.findingCount),
      },
      {
        name: 'BLOCKER',
        type: 'bar',
        itemStyle: { color: palette.severity.BLOCKER, borderRadius: [0, 6, 6, 0] },
        data: files.map((file) => file.blockerCount),
      },
    ],
  };
}

const RANGE_OPTIONS: Array<{ label: string; value: DateRangeKey }> = [
  { label: '近 7 天', value: '7d' },
  { label: '近 30 天', value: '30d' },
  { label: '全部', value: 'all' },
];

/** 统计分析：风险趋势、严重度/Agent 分布、Token 成本与高风险文件。 */
export function StatisticsView(): ReactElement {
  const [range, setRange] = useState<DateRangeKey>('7d');
  const { mode } = useTheme();
  const palette = chartPalette(mode);
  const statsQuery = useQuery({
    queryKey: ['stats', range],
    queryFn: () => fetchStats(getDateRange(range)),
  });

  const header = (
    <PageHeader
      eyebrow="Team insights"
      title="统计分析"
      description="用趋势和分布图快速了解团队的代码风险、审查效率与资源消耗。"
      extra={
        <div className="page-header-controls">
          <Segmented<DateRangeKey>
            value={range}
            onChange={(value) => setRange(value)}
            options={RANGE_OPTIONS}
          />
          <Button
            icon={<ReloadOutlined />}
            loading={statsQuery.isFetching}
            onClick={() => void statsQuery.refetch()}
          >
            刷新
          </Button>
        </div>
      }
    />
  );

  if (statsQuery.isPending) {
    return (
      <div className="page-stack">
        {header}
        <Row gutter={[16, 16]}>
          {[1, 2, 3, 4, 5, 6].map((item) => (
            <Col key={item} xs={12} md={8} lg={4}>
              <Card className="surface-card">
                <Skeleton active paragraph={{ rows: 1 }} />
              </Card>
            </Col>
          ))}
        </Row>
        <Card className="surface-card">
          <Skeleton active paragraph={{ rows: 8 }} />
        </Card>
      </div>
    );
  }
  if (statsQuery.isError) {
    return (
      <div className="page-stack">
        {header}
        <LoadErrorState
          error={statsQuery.error}
          title="统计数据加载失败"
          onRetry={() => void statsQuery.refetch()}
        />
      </div>
    );
  }

  const stats = statsQuery.data;
  if (stats.totalReviews === 0) {
    return (
      <div className="page-stack">
        {header}
        <Card className="surface-card">
          <EmptyState
            title="还没有可统计的审查数据"
            description="完成第一次代码审查后，这里会出现风险趋势、严重度分布与 Token 消耗。"
          />
        </Card>
      </div>
    );
  }

  const hasFindings = stats.totalFindings > 0;
  return (
    <div className="page-stack">
      {header}
      <Row gutter={[16, 16]}>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            title="审查总数"
            value={formatNumber(stats.totalReviews)}
            icon={<FileSearchOutlined />}
            accent="indigo"
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            title="发现总数"
            value={formatNumber(stats.totalFindings)}
            icon={<AlertOutlined />}
            accent="amber"
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            title="误报标记"
            value={formatNumber(stats.falsePositiveCount)}
            icon={<WarningOutlined />}
            accent="teal"
            hint="手动标记为误报的发现数"
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            title="平均风险分"
            value={stats.avgRiskScore.toFixed(1)}
            suffix="/100"
            icon={<FireOutlined />}
            accent="rose"
            hint={stats.avgRiskScore >= 70 ? '整体风险偏高' : '整体风险可控'}
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            title="平均耗时"
            value={formatDuration(stats.avgDurationMs)}
            icon={<ClockCircleOutlined />}
            accent="indigo"
            hint="单次审查平均耗时"
          />
        </Col>
        <Col xs={12} md={8} lg={4}>
          <StatCard
            title="Token 消耗"
            value={formatNumber(stats.totalTokenUsed)}
            icon={<ThunderboltOutlined />}
            accent="teal"
            hint="当前时间范围内累计"
          />
        </Col>
      </Row>

      <ChartCard
        title="风险趋势"
        description="折线为每日平均风险分（0–100），柱状为当日审查次数；风险分持续走高通常意味着变更集中或质量下滑。"
        extra={<Typography.Text type="secondary">按自然日统计</Typography.Text>}
        option={stats.riskTrend.length === 0 ? undefined : buildTrendOption(stats, palette)}
        empty={{ title: '该时间范围内没有审查记录', description: '切换为「全部」查看历史数据。' }}
        label="风险分与审查次数趋势图"
        height={320}
      />

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <ChartCard
            title="严重度分布"
            description="BLOCKER 占比越高，说明提交需要更早介入修复。"
            option={hasFindings ? buildSeverityOption(stats, palette) : undefined}
            empty={{ title: '该范围内未发现问题', description: '没有可统计的发现记录。' }}
            label="严重度分布柱状图"
            height={280}
          />
        </Col>
        <Col xs={24} lg={12}>
          <ChartCard
            title="Agent 命中分布"
            description="各审查维度的发现数量，用于判断哪类问题最集中。"
            option={
              stats.agentDistribution.length === 0 ? undefined : buildAgentOption(stats, palette)
            }
            empty={{ title: '暂无 Agent 命中', description: '审查未产生发现。' }}
            label="审查 Agent 命中分布柱状图"
            height={280}
          />
        </Col>
        <Col xs={24} lg={12}>
          <ChartCard
            title="Token 成本趋势"
            description="每日 Token 消耗；开启缓存与 Fast 模式可显著降低该曲线。"
            option={stats.tokenTrend.length === 0 ? undefined : buildTokenOption(stats, palette)}
            empty={{ title: '暂无 Token 消耗', description: '该范围内没有调用 LLM 的审查。' }}
            label="Token 消耗趋势图"
            height={280}
          />
        </Col>
        <Col xs={24} lg={12}>
          <ChartCard
            title="Top 高风险文件"
            description="按发现数排序的文件；红色为 BLOCKER 数量。"
            option={
              stats.topRiskyFiles.length === 0 ? undefined : buildRiskyFilesOption(stats, palette)
            }
            empty={{ title: '暂无高风险文件', description: '没有文件被标记出问题。' }}
            label="高风险文件排行条形图"
            height={280}
          />
        </Col>
      </Row>
      <Typography.Paragraph type="secondary" className="stats-footnote">
        数据来源：审结记录与发现明细的实时聚合，统计范围{' '}
        {range === 'all' ? '全部历史' : range === '7d' ? '近 7 天' : '近 30 天'}。
      </Typography.Paragraph>
      <Card className="surface-card chart-hint-card" title={<CardHeading title="解读提示" />}>
        <ul className="chart-hint-list">
          <li>风险趋势下降但发现数上升时，检查阻断阈值是否设置过低。</li>
          <li>Token 消耗异常升高通常与 Full 模式或知识库召回数量过大有关。</li>
          <li>误报标记数量用于校准 Agent 提示词，可在报告详情中逐条标记。</li>
        </ul>
      </Card>
    </div>
  );
}
