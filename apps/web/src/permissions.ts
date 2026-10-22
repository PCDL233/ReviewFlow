/**
 * 系统动态路由 → 权限标识的映射（RBAC）。
 * 权限标识即路由路径（'/'、'/run'、'/admin' 等），角色通过 permissions 数组持有。
 * '*' 表示拥有全部路由权限。
 */

export type RoutePermission = {
  path: string;
  label: string;
  group: 'user' | 'admin';
};

/** 全部可分配的路由权限（后台角色管理页的权限选择数据源） */
export const ALL_ROUTE_PERMISSIONS: RoutePermission[] = [
  { path: '/', label: '工作台', group: 'user' },
  { path: '/run', label: '发起审查', group: 'user' },
  { path: '/reviews', label: '审查历史', group: 'user' },
  { path: '/stats', label: '统计分析', group: 'user' },
  { path: '/profile', label: '个人设置', group: 'user' },
  { path: '/admin', label: '系统概览', group: 'admin' },
  { path: '/admin/users', label: '用户管理', group: 'admin' },
  { path: '/admin/roles', label: '角色管理', group: 'admin' },
  { path: '/admin/config', label: '系统配置', group: 'admin' },
  { path: '/admin/rules', label: '自定义规则', group: 'admin' },
  { path: '/admin/login-logs', label: '登录日志', group: 'admin' },
  { path: '/admin/operation-logs', label: '操作日志', group: 'admin' },
  { path: '/admin/observability', label: '模型调用审计', group: 'admin' },
  { path: '/admin/ai', label: 'AI 模型', group: 'admin' },
  { path: '/admin/knowledge', label: '知识库', group: 'admin' },
  { path: '/admin/tools', label: '分析工具', group: 'admin' },
  { path: '/admin/init', label: '配置初始化', group: 'admin' },
  { path: '/admin/hook', label: 'Git Hook 与 CI', group: 'admin' },
  { path: '/admin/metrics', label: '系统指标', group: 'admin' },
];

/** 用户端（非 admin）默认可用路径——用于未配置角色时兜底 */
export const DEFAULT_USER_PATHS = ['/', '/run', '/reviews', '/stats', '/profile'];

/** 通配权限：拥有全部页面与操作权限（内置 admin 角色即持有该值） */
export const WILDCARD_PERMISSION = '*';

/**
 * 判断某用户是否可访问指定路由路径。
 * '/'（工作台/首页）作为登录后通用落地页恒可访问，避免空权限用户被反复重定向造成死循环；
 * 其余路径：拥有 '*' 或精确匹配该路径即视为可访问；
 * 动态子路径（如 /reviews/<id>）按父级前缀授权：持有 '/reviews' 即可访问其下的任意子路径，
 * 否则拒绝。
 */
export function canAccessPath(permissions: string[], path: string): boolean {
  if (path === '/') return true;
  if (permissions.includes('*')) return true;
  if (permissions.includes(path)) return true;
  return permissions.some((p) => p !== '/' && path.startsWith(`${p}/`));
}

/** 是否具备进入管理后台的能力：admin 角色、'*' 权限，或任一 '/admin*' 页面权限。 */
export function hasAdminAccess(permissions: string[], role: 'admin' | 'user'): boolean {
  if (role === 'admin') return true;
  if (permissions.includes('*')) return true;
  return permissions.some((p) => p.startsWith('/admin'));
}

/** 返回用户第一个可访问的管理子页面（不含 /admin 概览），用于无概览权限时的落地跳转；无则 null。 */
export function firstPermittedAdminPath(permissions: string[]): string | null {
  for (const item of ALL_ROUTE_PERMISSIONS) {
    if (item.group !== 'admin' || item.path === '/admin') continue;
    if (permissions.includes(item.path)) return item.path;
  }
  return null;
}
