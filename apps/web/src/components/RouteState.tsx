import type { ReactElement } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Button, Result, Skeleton, Space, Spin } from 'antd';
import { getErrorMessage } from '../parse-response';

/** 统一的路由级加载态。 */
export function RouteLoading(props: { label?: string }): ReactElement {
  return (
    <div className="route-loading" role="status" aria-live="polite">
      <Spin size="large" />
      <span className="route-loading-label">{props.label ?? '正在加载页面…'}</span>
    </div>
  );
}

/** 统一的路由级错误态（懒加载分包失败、beforeLoad 异常等）。 */
export function RouteErrorState(props: { error: unknown }): ReactElement {
  return (
    <div className="route-state">
      <Result
        status="error"
        title="页面加载失败"
        subTitle={getErrorMessage(props.error)}
        extra={
          <Space wrap>
            <Button type="primary" onClick={() => window.location.reload()}>
              刷新重试
            </Button>
            <Button onClick={() => window.history.back()}>返回上一页</Button>
          </Space>
        }
      />
    </div>
  );
}

/** 统一的 404 页面。 */
export function NotFoundPage(): ReactElement {
  const navigate = useNavigate();
  return (
    <div className="route-state">
      <Result
        status="404"
        title="页面不存在"
        subTitle="这个地址可能已被移动或从未存在。回到工作台继续查看审查结果。"
        extra={
          <Space wrap>
            <Button type="primary" onClick={() => void navigate({ to: '/' })}>
              返回工作台
            </Button>
            <Button onClick={() => window.history.back()}>返回上一页</Button>
          </Space>
        }
      />
    </div>
  );
}

/** 页面级骨架屏：用于详情页等首屏结构明确的场景。 */
export function PageSkeleton(props: { rows?: number }): ReactElement {
  return (
    <div className="page-stack">
      <div className="page-skeleton-head">
        <Skeleton active title={{ width: '36%' }} paragraph={{ rows: 1, width: ['64%'] }} />
      </div>
      <div className="surface-card page-skeleton-card">
        <Skeleton active paragraph={{ rows: props.rows ?? 8 }} />
      </div>
    </div>
  );
}
