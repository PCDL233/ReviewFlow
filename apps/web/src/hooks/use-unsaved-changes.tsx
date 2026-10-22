import type { ReactElement } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { Modal } from 'antd';

/**
 * 未保存变更守卫：表单变脏后拦截站内跳转与刷新/关闭标签页，先让用户确认。
 * 配置类页面此前直接丢弃未保存的修改且没有任何提示，这里统一补齐。
 * @param dirty 是否存在未保存的修改
 * @returns 需要渲染到页面中的确认弹窗（无冲突时为空）
 */
export function useUnsavedChanges(dirty: boolean): ReactElement | null {
  const blocker = useBlocker({
    shouldBlockFn: () => dirty,
    withResolver: true,
    // 页面关闭/刷新走浏览器原生提示（文案由浏览器决定，无法自定义）
    enableBeforeUnload: true,
  });

  if (blocker.status !== 'blocked') return null;

  return (
    <Modal
      open
      title="放弃未保存的修改？"
      okText="放弃并离开"
      cancelText="继续编辑"
      okButtonProps={{ danger: true }}
      onOk={() => blocker.proceed()}
      onCancel={() => blocker.reset()}
      maskClosable={false}
    >
      当前页面还有未保存的配置变更，离开后这些修改将会丢失。
    </Modal>
  );
}
