import type { ReactElement } from 'react';
import {
  AppstoreOutlined,
  AuditOutlined,
  BarChartOutlined,
  BookOutlined,
  BugOutlined,
  DashboardOutlined,
  FileAddOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  HistoryOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
  ToolOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';

export type NavLeaf = {
  key: string;
  label: string;
  icon: ReactElement;
};

export type NavGroup = {
  key: string;
  label: string;
  icon: ReactElement;
  children: NavLeaf[];
};

export type NavEntry = NavLeaf | NavGroup;

export function isNavGroup(entry: NavEntry): entry is NavGroup {
  return 'children' in entry;
}

/** 用户端导航；个人设置单独放在侧栏底部用户菜单，不占主菜单。 */
export const USER_NAV: NavEntry[] = [
  { key: '/', label: '工作台', icon: <DashboardOutlined /> },
  { key: '/run', label: '发起审查', icon: <PlayCircleOutlined /> },
  { key: '/reviews', label: '审查历史', icon: <HistoryOutlined /> },
  { key: '/stats', label: '统计分析', icon: <BarChartOutlined /> },
];

/** 管理后台分组导航；具体可见项仍由 admin-menu 按 RBAC 过滤。 */
export const ADMIN_NAV_META: NavEntry[] = [
  { key: '/admin', label: '系统概览', icon: <AppstoreOutlined /> },
  {
    key: 'group:access',
    label: '用户与权限',
    icon: <TeamOutlined />,
    children: [
      { key: '/admin/users', label: '用户管理', icon: <TeamOutlined /> },
      { key: '/admin/roles', label: '角色管理', icon: <SafetyCertificateOutlined /> },
    ],
  },
  {
    key: 'group:review',
    label: '审查配置',
    icon: <UnorderedListOutlined />,
    children: [
      { key: '/admin/rules', label: '自定义规则', icon: <UnorderedListOutlined /> },
      { key: '/admin/knowledge', label: '知识库', icon: <BookOutlined /> },
      { key: '/admin/tools', label: '分析工具', icon: <ToolOutlined /> },
    ],
  },
  {
    key: 'group:settings',
    label: '系统设置',
    icon: <SettingOutlined />,
    children: [
      { key: '/admin/ai', label: 'AI 模型', icon: <RobotOutlined /> },
      { key: '/admin/config', label: '系统配置', icon: <SettingOutlined /> },
      { key: '/admin/init', label: '配置初始化', icon: <FileAddOutlined /> },
      { key: '/admin/hook', label: 'Git Hook 与 CI', icon: <BugOutlined /> },
    ],
  },
  {
    key: 'group:logs',
    label: '系统日志',
    icon: <AuditOutlined />,
    children: [
      { key: '/admin/login-logs', label: '登录日志', icon: <FileSearchOutlined /> },
      { key: '/admin/operation-logs', label: '操作日志', icon: <AuditOutlined /> },
    ],
  },
  { key: '/admin/metrics', label: '系统指标', icon: <FileTextOutlined /> },
];

const ADMIN_TITLES: Record<string, string> = {
  '/admin': '系统概览',
  '/admin/users': '用户管理',
  '/admin/roles': '角色管理',
  '/admin/rules': '自定义审查规则',
  '/admin/login-logs': '登录日志',
  '/admin/operation-logs': '操作日志',
  '/admin/ai': 'AI 模型配置',
  '/admin/config': '系统配置',
  '/admin/knowledge': '知识库',
  '/admin/tools': '静态分析工具',
  '/admin/init': '配置初始化',
  '/admin/hook': 'Git Hook 与 CI',
  '/admin/metrics': '系统指标',
};

/** 当前路由对应的页面标题（顶栏面包屑与 document.title 共用）。 */
export function pageTitleOf(pathname: string): string {
  if (pathname === '/') return '工作台';
  if (pathname === '/run') return '发起审查';
  if (pathname === '/reviews') return '审查历史';
  if (pathname.startsWith('/reviews/')) return '审查报告';
  if (pathname === '/stats') return '统计分析';
  if (pathname === '/profile') return '个人设置';
  if (pathname.startsWith('/admin')) return ADMIN_TITLES[pathname] ?? '管理后台';
  return 'ReviewFlow';
}

/** 顶栏左侧的分区名称。 */
export function sectionOf(pathname: string): string {
  return pathname.startsWith('/admin') ? '管理后台' : '工作空间';
}

/** 侧栏选中项：报告详情归入“审查历史”。 */
export function selectedKeyOf(pathname: string): string {
  if (pathname.startsWith('/reviews/')) return '/reviews';
  return pathname;
}
