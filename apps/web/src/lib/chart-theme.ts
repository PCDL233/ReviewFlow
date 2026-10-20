/** ECharts 主题工厂：所有图表的坐标轴、tooltip、图例与色板都随明暗主题生成。 */

export type ChartThemeMode = 'light' | 'dark';

export type ChartPalette = {
  text: string;
  muted: string;
  axisLine: string;
  splitLine: string;
  tooltipBg: string;
  tooltipBorder: string;
  tooltipText: string;
  confidence: string;
  brand: string;
  brandSoft: string;
  teal: string;
  severity: Record<'BLOCKER' | 'WARNING' | 'NIT' | 'PRAISE', string>;
};

const LIGHT: ChartPalette = {
  text: '#64748b',
  muted: '#94a3b8',
  axisLine: '#e2e8f0',
  splitLine: '#eef2f7',
  tooltipBg: 'rgba(255,255,255,0.97)',
  tooltipBorder: '#e2e8f0',
  tooltipText: '#0f172a',
  confidence: '0 8px 24px rgba(15,23,42,.12)',
  brand: '#4f46e5',
  brandSoft: '#a5b4fc',
  teal: '#14b8a6',
  severity: { BLOCKER: '#dc2626', WARNING: '#d97706', NIT: '#2563eb', PRAISE: '#059669' },
};

const DARK: ChartPalette = {
  text: '#94a3b8',
  muted: '#64748b',
  axisLine: '#334155',
  splitLine: '#243449',
  tooltipBg: 'rgba(30,41,59,0.97)',
  tooltipBorder: '#334155',
  tooltipText: '#f1f5f9',
  confidence: '0 8px 24px rgba(2,6,23,.55)',
  brand: '#818cf8',
  brandSoft: '#6366f1',
  teal: '#2dd4bf',
  severity: { BLOCKER: '#f87171', WARNING: '#fbbf24', NIT: '#60a5fa', PRAISE: '#34d399' },
};

const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';

/** 按主题返回调色板；未知值回落到浅色。 */
export function chartPalette(mode: ChartThemeMode): ChartPalette {
  return mode === 'dark' ? DARK : LIGHT;
}

/** 图表通用的文字样式。 */
export function chartTextStyle(palette: ChartPalette): {
  color: string;
  fontFamily: string;
  fontSize: number;
} {
  return { color: palette.text, fontFamily: FONT_FAMILY, fontSize: 12 };
}

/** 坐标轴与分割线样式。 */
export function chartAxisStyles(palette: ChartPalette): {
  axisLine: { lineStyle: { color: string } };
  splitLine: { lineStyle: { color: string; type: 'dashed' } };
} {
  return {
    axisLine: { lineStyle: { color: palette.axisLine } },
    splitLine: { lineStyle: { color: palette.splitLine, type: 'dashed' } },
  };
}

/** tooltip 样式（含暗色阴影与圆角）。 */
export function chartTooltipStyle(palette: ChartPalette): Record<string, unknown> {
  return {
    backgroundColor: palette.tooltipBg,
    borderColor: palette.tooltipBorder,
    borderWidth: 1,
    padding: [10, 14],
    textStyle: { color: palette.tooltipText, fontFamily: FONT_FAMILY, fontSize: 12 },
    extraCssText: `box-shadow: ${palette.confidence}; border-radius: 10px;`,
  };
}

/** 图例样式。 */
export function chartLegendStyle(palette: ChartPalette): Record<string, unknown> {
  return {
    textStyle: chartTextStyle(palette),
    icon: 'roundRect',
    itemWidth: 10,
    itemHeight: 10,
  };
}

/** 折线渐变填充（颜色 + alpha）。 */
export function areaGradient(color: string): Record<string, unknown> {
  return {
    type: 'linear',
    x: 0,
    y: 0,
    x2: 0,
    y2: 1,
    colorStops: [
      { offset: 0, color: `${color}40` },
      { offset: 1, color: `${color}00` },
    ],
  };
}
