import type { ReactElement } from 'react';
import { Tag } from 'antd';

export type ReviewStatus = 'completed' | 'failed' | 'cancelled';

const STATUS_META: Record<ReviewStatus, { label: string; color: string }> = {
  completed: { label: '已完成', color: 'success' },
  failed: { label: '失败', color: 'error' },
  cancelled: { label: '已取消', color: 'default' },
};

/** 审查状态标签：列表、报告与进度面板共用，保证状态文案与颜色一致。 */
export function StatusTag(props: { status: ReviewStatus | undefined }): ReactElement {
  const status = props.status ?? 'completed';
  const meta = STATUS_META[status];
  return (
    <Tag className={`status-tag status-${status}`} color={meta.color} variant="filled">
      <span className="status-dot" aria-hidden="true" />
      {meta.label}
    </Tag>
  );
}
