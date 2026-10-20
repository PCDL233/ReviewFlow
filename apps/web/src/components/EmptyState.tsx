import type { ReactElement, ReactNode } from 'react';
import { Empty } from 'antd';

export type EmptyStateProps = {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  /** 使用 AntD 默认插画或简洁插画，默认简洁版。 */
  image?: ReactNode;
  className?: string;
};

/** 空态：标题 + 解释 + 可选主操作，避免各页面出现裸文本“暂无数据”。 */
export function EmptyState(props: EmptyStateProps): ReactElement {
  return (
    <div className={`empty-state${props.className === undefined ? '' : ` ${props.className}`}`}>
      <Empty
        image={props.image ?? Empty.PRESENTED_IMAGE_SIMPLE}
        description={
          <div className="empty-state-copy">
            <div className="empty-state-title">{props.title}</div>
            {props.description ? (
              <div className="empty-state-description">{props.description}</div>
            ) : null}
          </div>
        }
      >
        {props.action ? <div className="empty-state-action">{props.action}</div> : null}
      </Empty>
    </div>
  );
}
