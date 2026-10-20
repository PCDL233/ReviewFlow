import type { ReactElement } from 'react';
import {
  AppstoreOutlined,
  AuditOutlined,
  BookOutlined,
  BugOutlined,
  FileAddOutlined,
  FileSearchOutlined,
  FileTextOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  TeamOutlined,
  ToolOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons';
import { canAccessPath } from './permissions';

/** 管理后台侧栏叶子菜单项：key 为真实路由路径，点击直接导航 */
export type AdminMenuLeaf = {
  key: string;
  label: string;
  icon: ReactElement;
};

/** 管理后台侧栏分组：key 以 `group:` 前缀标识（非路由），点击展开二级菜单 */
export type AdminMenuGroup = {
  key: string;
  label: string;
  icon: ReactElement;
  children: AdminMenuLeaf[];
};

export type AdminMenuEntry = AdminMenuLeaf | AdminMenuGroup;

export function isAdminMenuGroup(entry: AdminMenuEntry): entry is AdminMenuGroup {
  return 'children' in entry;
}

/**
 * 侧栏导航分组结构：系统概览/系统指标为平铺项，其余归入可折叠分组，
 * 子项 key 即路由路径。分组 key 以 `group:` 前缀标识，避免与路由路径冲突。
 */
const ADMIN_MENU: AdminMenuEntry[] = [
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
      { key: '/admin/hook', label: 'Hook 安装', icon: <BugOutlined /> },
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

/**
 * 按用户权限过滤侧栏菜单：平铺项需自身可访问；分组仅当至少一个子项可访问时出现，
 * 且只保留有权限的子项。
 */
export function buildAdminMenu(permissions: string[]): AdminMenuEntry[] {
  const entries: AdminMenuEntry[] = [];
  for (const entry of ADMIN_MENU) {
    if (isAdminMenuGroup(entry)) {
      const children = entry.children.filter((child) => canAccessPath(permissions, child.key));
      if (children.length > 0) {
        entries.push({ ...entry, children });
      }
    } else if (canAccessPath(permissions, entry.key)) {
      entries.push(entry);
    }
  }
  return entries;
}

/**
 * 当前路径 → 所属分组 key；平铺项（概览/指标）返回 null。
 * 用于侧栏默认展开当前所在分组（含动态子路径前缀匹配）。
 */
export function adminGroupKeyOf(pathname: string): string | null {
  for (const entry of ADMIN_MENU) {
    if (!isAdminMenuGroup(entry)) continue;
    if (
      entry.children.some((child) => pathname === child.key || pathname.startsWith(`${child.key}/`))
    ) {
      return entry.key;
    }
  }
  return null;
}
