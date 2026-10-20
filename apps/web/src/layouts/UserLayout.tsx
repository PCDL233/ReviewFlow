import { Outlet } from '@tanstack/react-router';
import type { ReactElement } from 'react';
import { AppShell } from '../components/AppShell';
import { useAuth } from '../hooks/use-auth';
import { canAccessPath } from '../permissions';
import { USER_NAV, isNavGroup } from '../navigation';
import type { NavEntry } from '../navigation';

/** 用户端布局：导航项按 RBAC 权限过滤后交给统一 AppShell。 */
export function UserLayout(): ReactElement {
  const { user } = useAuth();
  const permissions = user?.permissions ?? [];
  const nav: NavEntry[] = USER_NAV.filter(
    (item) => isNavGroup(item) || canAccessPath(permissions, item.key),
  );

  return (
    <AppShell variant="user" nav={nav} brandSubtitle="CODE REVIEW CONSOLE">
      <Outlet />
    </AppShell>
  );
}
