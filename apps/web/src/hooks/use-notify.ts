import { App } from 'antd';
import { getErrorMessage } from '../parse-response';

export type NotifyOptions = {
  /** 统一错误前缀标题，如"删除失败"，最终渲染为「标题：原因」 */
  title?: string;
  duration?: number;
};

/**
 * 统一错误反馈入口：封装 antd App.useApp() 的轻提示（页面顶部弹出、自动消失）。
 * - 错误统一走 getErrorMessage 翻译，保证文案风格一致
 * - 以内容作为 toast key：同一错误连续触发时 antd 会替换现有 toast 并重启计时，
 *   而非静默跳过——用户每次操作都能看到反馈
 * - 所有调用带防御：message 实例不可用或 Promise 拒绝时静默降级，绝不向上抛
 */
export function useNotify(): {
  notifyError: (error: unknown, options?: NotifyOptions) => void;
} {
  const { message } = App.useApp();

  const notifyError = (error: unknown, options: NotifyOptions = {}): void => {
    const reason = getErrorMessage(error);
    const content =
      options.title === undefined || options.title === '' ? reason : `${options.title}：${reason}`;
    try {
      Promise.resolve(
        message.error({ content, duration: options.duration ?? 4, key: content }),
      ).catch(() => undefined);
    } catch {
      // message 实例缺失：静默降级（与全局兜底保持同一防御策略）
    }
  };

  return { notifyError };
}
