import { Outlet } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { AppShell } from '../components/AppShell';
import { useAuth } from '../hooks/use-auth';
import { buildAdminMenu, isAdminMenuGroup } from '../admin-menu';
import type { NavEntry } from '../navigation';

/** 管理后台布局：沿用 admin-menu 的 RBAC 过滤，外观与用户端共用 AppShell。 */
export function AdminLayout(): ReactElement {
  const { user } = useAuth();
  const menu = buildAdminMenu(user?.permissions ?? []);
  const nav: NavEntry[] = menu.map((entry) =>
    isAdminMenuGroup(entry)
      ? {
          key: entry.key,
          label: entry.label,
          icon: entry.icon,
          children: entry.children.map((child) => ({
            key: child.key,
            label: child.label,
            icon: child.icon,
          })),
        }
      : { key: entry.key, label: entry.label, icon: entry.icon },
  );

  return (
    <AppShell variant="admin" nav={nav} brandSubtitle="ADMIN CONSOLE">
      <Outlet />
    </AppShell>
  );
}
