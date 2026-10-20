/**
 * 只允许站内绝对路径作为登录回跳目标。
 * 拒绝 `//evil.com`、`/\evil.com` 与带协议的地址，避免开放重定向。
 */
export function safeRedirectTarget(redirect: string | undefined, fallback = '/'): string {
  if (redirect === undefined || redirect === '') return fallback;
  if (!redirect.startsWith('/')) return fallback;
  if (redirect.startsWith('//') || redirect.startsWith('/\\')) return fallback;
  if (redirect.includes('\\')) return fallback;
  return redirect;
}
