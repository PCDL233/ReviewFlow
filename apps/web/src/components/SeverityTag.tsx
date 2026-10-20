import type { ReactElement } from 'react';
import { Tag } from 'antd';
import type { Severity } from '@ai-review/shared';

const SEVERITY_META: Record<Severity, { color: string; label: string }> = {
  BLOCKER: { color: 'error', label: 'BLOCKER' },
  WARNING: { color: 'warning', label: 'WARNING' },
  NIT: { color: 'processing', label: 'NIT' },
  PRAISE: { color: 'success', label: 'PRAISE' },
};

/** 严重度标签：全站唯一映射，避免各页面自行维护一套颜色。 */
export function SeverityTag(props: { severity: Severity; bordered?: boolean }): ReactElement {
  const meta = SEVERITY_META[props.severity];
  return (
    <Tag
      className={`severity-tag severity-${props.severity.toLowerCase()}`}
      color={meta.color}
      bordered={props.bordered ?? false}
    >
      {meta.label}
    </Tag>
  );
}

/** 严重度的中文解释，用于筛选器与提示文案。 */
export const SEVERITY_LABELS: Record<Severity, string> = {
  BLOCKER: '阻断',
  WARNING: '警告',
  NIT: '建议',
  PRAISE: '亮点',
};
