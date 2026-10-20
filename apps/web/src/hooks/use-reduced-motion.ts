import { useSyncExternalStore } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

function getMediaQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  return window.matchMedia(QUERY);
}

function subscribe(onChange: () => void): () => void {
  const query = getMediaQuery();
  if (query === null) return () => undefined;
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  return getMediaQuery()?.matches ?? false;
}

/** 非浏览器环境（SSR / 单测）默认关掉"减少动效"，与 antd 默认行为一致。 */
function getServerSnapshot(): boolean {
  return false;
}

/**
 * 是否开启了系统级「减少动态效果」。
 *
 * 用于把该偏好传给 antd 的 motion token：由 rc-motion 走无动画分支，
 * 而非在 CSS 里把动画时长压成 0（那会让弹层的 animationend 早于监听注册，
 * 定位永远停在屏外，表现为下拉菜单不出现 + 页面反复闪动）。
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
