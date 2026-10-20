import { useEffect, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import * as echarts from 'echarts/core';
import { BarChart, LineChart } from 'echarts/charts';
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
import type { ECharts, EChartsCoreOption } from 'echarts/core';
import { Card } from 'antd';
import { CardHeading } from './PageHeader';
import { EmptyState } from './EmptyState';

echarts.use([
  LineChart,
  BarChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  CanvasRenderer,
]);

export type StatChartProps = {
  option: EChartsCoreOption;
  height?: number;
  /** 无障碍描述：图表的文字替代。 */
  label?: string;
};

/** ECharts 容器：随容器尺寸自适应，并在主题切换时重建实例。 */
export function StatChart(props: StatChartProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const chart = echarts.init(container);
    chartRef.current = chart;
    const resize = (): void => chart.resize();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    observer?.observe(container);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      chart.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(props.option, { notMerge: true, lazyUpdate: true });
  }, [props.option]);

  return (
    <div
      ref={containerRef}
      className="stat-chart"
      role="img"
      aria-label={props.label ?? '统计图表'}
      style={{ width: '100%', height: props.height ?? 320 }}
    />
  );
}

export type ChartCardProps = {
  title: string;
  description?: string;
  extra?: ReactNode;
  option: EChartsCoreOption | undefined;
  empty: { title: string; description?: string };
  label: string;
  height?: number;
};

/** 图表卡片：标题 + 一句解读 + 独立空态，避免空库时只剩空坐标轴。 */
export function ChartCard(props: ChartCardProps): ReactElement {
  return (
    <Card
      className="surface-card chart-card"
      title={<CardHeading title={props.title} />}
      extra={props.extra}
    >
      {props.description === undefined ? null : (
        <p className="chart-description">{props.description}</p>
      )}
      {props.option === undefined ? (
        <EmptyState title={props.empty.title} description={props.empty.description} />
      ) : (
        <StatChart
          option={props.option}
          {...(props.height === undefined ? {} : { height: props.height })}
          label={props.label}
        />
      )}
    </Card>
  );
}
