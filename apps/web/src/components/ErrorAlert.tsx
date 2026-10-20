import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { Alert, Button } from 'antd';
import { getErrorMessage } from '../parse-response';

export type ErrorAlertProps = {
  /** 原始错误对象或已翻译的错误字符串 */
  error: unknown;
  /** 统一错误标题，缺省按场景区分：ErrorAlert → "操作失败"，LoadErrorState → "加载失败" */
  title?: string;
  /** 提供后展示"重试"按钮（查询失败时绑定 refetch） */
  onRetry?: () => void;
  retryLabel?: string;
  /** 覆盖默认的自动翻译描述 */
  description?: ReactNode;
  closable?: boolean;
  onClose?: () => void;
  className?: string;
  style?: CSSProperties;
};

/**
 * 统一错误提示条：所有页面的错误呈现入口。
 * 标题 + 自动翻译描述 + 可选重试按钮，替换此前散落的 Alert/message/裸文本。
 */
export function ErrorAlert(props: ErrorAlertProps): ReactElement {
  const { error, title, onRetry, retryLabel, description, ...rest } = props;
  return (
    <Alert
      type="error"
      showIcon
      title={title ?? '操作失败'}
      description={description ?? getErrorMessage(error)}
      action={
        onRetry !== undefined ? (
          <Button size="small" onClick={onRetry}>
            {retryLabel ?? '重试'}
          </Button>
        ) : undefined
      }
      {...rest}
    />
  );
}

/** 整块加载失败状态：查询失败时替代内容区（支持"重试"重新拉取） */
export function LoadErrorState(props: ErrorAlertProps): ReactElement {
  return <ErrorAlert {...props} title={props.title ?? '加载失败'} />;
}
