import type { ReactElement, ReactNode } from 'react';
import { ArrowLeftOutlined } from '@ant-design/icons';
import { Button, Typography } from 'antd';

export type PageHeaderProps = {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
  extra?: ReactNode;
  /** 可选的返回入口，渲染在标题上方（用于报告详情等二级页面）。 */
  back?: { label?: string; onClick: () => void };
};

/** 页面级标题区：所有业务页共用同一套字号、间距与操作区排布。 */
export function PageHeader(props: PageHeaderProps): ReactElement {
  return (
    <div className="page-header">
      <div className="page-header-copy">
        {props.back ? (
          <Button
            className="page-header-back"
            type="text"
            size="small"
            icon={<ArrowLeftOutlined />}
            onClick={props.back.onClick}
          >
            {props.back.label ?? '返回'}
          </Button>
        ) : null}
        {props.eyebrow ? <div className="page-eyebrow">{props.eyebrow}</div> : null}
        <Typography.Title level={2} className="page-title">
          {props.title}
        </Typography.Title>
        {props.description ? (
          <Typography.Paragraph className="page-subtitle">{props.description}</Typography.Paragraph>
        ) : null}
      </div>
      {props.extra || props.actions ? (
        <div className="page-header-extra">
          {props.extra}
          {props.actions}
        </div>
      ) : null}
    </div>
  );
}

export function CardHeading(props: { title: string; hint?: string }): ReactElement {
  return (
    <div className="card-heading">
      <span className="card-heading-dot" aria-hidden="true" />
      <span className="card-heading-title">{props.title}</span>
      {props.hint ? <span className="card-heading-hint">{props.hint}</span> : null}
    </div>
  );
}
