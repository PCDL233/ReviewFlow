import { theme as antdTheme } from 'antd';
import type { ThemeConfig } from 'antd';
import type { ThemeMode } from './theme-context';

const FONT_FAMILY =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif';

const FONT_MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", monospace';

/**
 * Ant Design token 与全局 CSS 变量保持同一套色板。
 * 这里集中定义，避免 main.tsx 与 styles 各自维护一份颜色。
 */
const LIGHT = {
  brand: '#4f46e5',
  brandHover: '#4338ca',
  info: '#4f46e5',
  success: '#059669',
  warning: '#d97706',
  error: '#dc2626',
  infoBg: '#eff6ff',
  infoBorder: '#bfdbfe',
  successBg: '#ecfdf5',
  successBorder: '#a7f3d0',
  warningBg: '#fffbeb',
  warningBorder: '#fde68a',
  errorBg: '#fef2f2',
  errorBorder: '#fecaca',
  ink: '#0f172a',
  inkSecondary: '#475569',
  inkTertiary: '#94a3b8',
  line: '#e2e8f0',
  lineSoft: '#eef2f7',
  panel: '#ffffff',
  panelMuted: '#f8fafc',
  canvas: '#f6f7fb',
  headerBg: '#f8fafc',
  headerColor: '#475569',
  rowHover: '#f8fafc',
  selectedBg: '#eef2ff',
  selectedColor: '#4338ca',
  tooltip: '#0f172a',
} as const;

const DARK = {
  brand: '#818cf8',
  brandHover: '#a5b4fc',
  info: '#818cf8',
  success: '#34d399',
  warning: '#fbbf24',
  error: '#f87171',
  infoBg: '#172554',
  infoBorder: '#1e3a8a',
  successBg: '#052e1b',
  successBorder: '#0f5c3f',
  warningBg: '#3a2a0a',
  warningBorder: '#6b4d12',
  errorBg: '#3b1114',
  errorBorder: '#7f1d1d',
  ink: '#f1f5f9',
  inkSecondary: '#cbd5e1',
  inkTertiary: '#94a3b8',
  line: '#334155',
  lineSoft: '#243449',
  panel: '#1e293b',
  panelMuted: '#172033',
  canvas: '#0b1220',
  headerBg: '#172033',
  headerColor: '#cbd5e1',
  rowHover: '#26364d',
  selectedBg: '#312e81',
  selectedColor: '#c7d2fe',
  tooltip: '#020617',
} as const;

export type AntdThemeOptions = {
  /**
   * 用户系统设置开启了「减少动态效果」时为 true。
   * 通过 antd 的 motion token 关闭动画（rc-motion 会走无动画分支），
   * 而不是用 CSS 把时长压到 0——后者会让弹层错过 animationend，永远停在屏外。
   */
  reducedMotion?: boolean;
};

export function createAntdTheme(mode: ThemeMode, options: AntdThemeOptions = {}): ThemeConfig {
  const isDark = mode === 'dark';
  const palette = isDark ? DARK : LIGHT;

  return {
    algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: palette.brand,
      colorInfo: palette.info,
      colorSuccess: palette.success,
      colorWarning: palette.warning,
      colorError: palette.error,
      // seed 色由 antd 派生 10 阶色板，其 [1] 阶（*Bg）会明显偏灰绿；
      // 这里显式覆盖语义背景/描边，使 tag / alert / progress 与设计变量一致。
      colorInfoBg: palette.infoBg,
      colorInfoBorder: palette.infoBorder,
      colorSuccessBg: palette.successBg,
      colorSuccessBorder: palette.successBorder,
      colorWarningBg: palette.warningBg,
      colorWarningBorder: palette.warningBorder,
      colorErrorBg: palette.errorBg,
      colorErrorBorder: palette.errorBorder,
      motion: options.reducedMotion !== true,
      colorLink: palette.brand,
      colorText: palette.ink,
      colorTextSecondary: palette.inkSecondary,
      colorTextTertiary: palette.inkTertiary,
      colorTextDescription: palette.inkTertiary,
      colorBorder: palette.line,
      colorBorderSecondary: palette.lineSoft,
      colorSplit: palette.lineSoft,
      colorBgContainer: palette.panel,
      colorBgElevated: palette.panel,
      colorBgLayout: palette.canvas,
      colorFillAlter: palette.panelMuted,
      colorFillSecondary: palette.lineSoft,
      colorFillTertiary: palette.panelMuted,
      borderRadius: 10,
      borderRadiusLG: 14,
      borderRadiusSM: 8,
      controlHeight: 38,
      controlHeightLG: 42,
      fontFamily: FONT_FAMILY,
      fontFamilyCode: FONT_MONO,
      fontSize: 14,
      lineHeight: 1.65,
      boxShadow: isDark ? '0 12px 32px rgba(2, 6, 23, 0.45)' : '0 12px 32px rgba(15, 23, 42, 0.08)',
      boxShadowSecondary: isDark
        ? '0 16px 40px rgba(2, 6, 23, 0.55)'
        : '0 16px 40px rgba(15, 23, 42, 0.1)',
    },
    components: {
      Layout: {
        siderBg: palette.panel,
        headerBg: palette.panel,
        bodyBg: palette.canvas,
      },
      Button: {
        borderRadius: 9,
        fontWeight: 500,
        primaryShadow: 'none',
        defaultShadow: 'none',
        dangerShadow: 'none',
      },
      Card: {
        borderRadiusLG: 14,
        headerFontSize: 15,
        paddingLG: 22,
      },
      Table: {
        headerBg: palette.headerBg,
        headerColor: palette.headerColor,
        headerSplitColor: palette.lineSoft,
        borderColor: palette.lineSoft,
        rowHoverBg: palette.rowHover,
        cellPaddingBlock: 13,
        cellPaddingInline: 14,
        headerBorderRadius: 10,
      },
      Menu: {
        itemBg: 'transparent',
        itemColor: palette.inkSecondary,
        itemHoverBg: palette.panelMuted,
        itemHoverColor: palette.ink,
        itemSelectedBg: palette.selectedBg,
        itemSelectedColor: palette.selectedColor,
        itemBorderRadius: 9,
        itemHeight: 42,
        itemMarginInline: 8,
        subMenuItemBg: 'transparent',
        groupTitleColor: palette.inkTertiary,
      },
      Input: { borderRadius: 9 },
      InputNumber: { borderRadius: 9 },
      Select: { borderRadius: 9 },
      DatePicker: { borderRadius: 9 },
      Tabs: {
        inkBarColor: palette.brand,
        itemSelectedColor: palette.brand,
        itemHoverColor: palette.brandHover,
        titleFontSize: 14,
      },
      Segmented: {
        itemSelectedBg: palette.panel,
        itemSelectedColor: palette.ink,
        itemColor: palette.inkSecondary,
        trackBg: palette.panelMuted,
        borderRadius: 9,
      },
      Modal: {
        contentBg: palette.panel,
        headerBg: palette.panel,
        borderRadiusLG: 14,
      },
      Descriptions: {
        labelBg: palette.panelMuted,
        titleColor: palette.ink,
        contentColor: palette.ink,
      },
      Statistic: {
        titleFontSize: 13,
        contentFontSize: 28,
      },
      Progress: {
        defaultColor: palette.brand,
        remainingColor: palette.lineSoft,
      },
      Alert: {
        defaultPadding: '10px 14px',
        withDescriptionPadding: '14px 16px',
      },
      Tooltip: {
        colorBgSpotlight: palette.tooltip,
      },
      Form: {
        labelColor: palette.inkSecondary,
        labelFontSize: 13,
        verticalLabelPadding: '0 0 6px',
      },
      Tag: {
        defaultBg: palette.panelMuted,
        defaultColor: palette.inkSecondary,
      },
      Pagination: {
        itemActiveBg: palette.panel,
      },
      Empty: {
        colorTextDescription: palette.inkTertiary,
      },
    },
  };
}
