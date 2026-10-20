import { useEffect, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { useLocation, useNavigate } from '@tanstack/react-router';
import {
  ArrowLeftOutlined,
  DownOutlined,
  LogoutOutlined,
  MenuOutlined,
  MoonOutlined,
  SettingOutlined,
  SafetyCertificateOutlined,
  SunOutlined,
} from '@ant-design/icons';
import { Button, Drawer, Dropdown, Layout, Menu, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import type { ItemType } from 'antd/es/menu/interface';
import { useAuth, useLogout } from '../hooks/use-auth';
import { canAccessPath, hasAdminAccess } from '../permissions';
import { useTheme } from '../theme-context';
import { isNavGroup, pageTitleOf, sectionOf, selectedKeyOf } from '../navigation';
import type { NavEntry } from '../navigation';
import { BrandMark } from './Brand';
import { UserAvatar } from './UserAvatar';

export type AppShellProps = {
  variant: 'user' | 'admin';
  nav: NavEntry[];
  brandSubtitle: string;
  children: ReactNode;
};

function toMenuItems(entries: NavEntry[]): ItemType[] {
  return entries.map((entry) =>
    isNavGroup(entry)
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
}

function leafKeysOf(entries: NavEntry[]): Set<string> {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (isNavGroup(entry)) {
      for (const child of entry.children) keys.add(child.key);
    } else {
      keys.add(entry.key);
    }
  }
  return keys;
}

function activeGroupKey(entries: NavEntry[], pathname: string): string | null {
  for (const entry of entries) {
    if (!isNavGroup(entry)) continue;
    if (
      entry.children.some((child) => pathname === child.key || pathname.startsWith(`${child.key}/`))
    ) {
      return entry.key;
    }
  }
  return null;
}

/**
 * 全站应用外壳：桌面粘性侧栏、移动端抽屉导航、顶栏面包屑、主题切换与用户菜单。
 * 用户端与管理端只通过 nav / variant / brandSubtitle 区分，避免两套布局长期分叉。
 */
export function AppShell(props: AppShellProps): ReactElement {
  const { user } = useAuth();
  const logoutMutation = useLogout();
  const { mode, toggle } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [openKeys, setOpenKeys] = useState<string[]>([]);

  const pathname = location.pathname;
  const title = pageTitleOf(pathname);
  const section = sectionOf(pathname);
  const currentGroup = activeGroupKey(props.nav, pathname);
  const leafKeys = leafKeysOf(props.nav);
  const isAdmin = props.variant === 'admin';
  const canSeeProfile = canAccessPath(user?.permissions ?? [], '/profile');
  const canSeeAdmin = user !== null && hasAdminAccess(user.permissions, user.role);

  useEffect(() => {
    document.title = `${title} · ReviewFlow`;
  }, [title]);

  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (currentGroup !== null) {
      setOpenKeys((current) =>
        current.includes(currentGroup) ? current : [...current, currentGroup],
      );
    }
  }, [currentGroup]);

  const menuItems = toMenuItems(props.nav);
  const selectedKeys = [selectedKeyOf(pathname)];

  const handleNavigate = (key: string): void => {
    if (!leafKeys.has(key)) return;
    void navigate({ to: key });
    setDrawerOpen(false);
  };

  const handleLogout = async (): Promise<void> => {
    try {
      await logoutMutation.mutateAsync();
    } finally {
      void navigate({ to: '/login', replace: true });
    }
  };

  const dropdownItems: MenuProps['items'] = [
    ...(canSeeProfile
      ? [
          {
            key: 'profile',
            label: '个人设置',
            icon: <SettingOutlined />,
          },
        ]
      : []),
    ...(isAdmin || !canSeeAdmin
      ? []
      : [
          {
            key: 'admin',
            label: '管理后台',
            icon: <SafetyCertificateOutlined />,
          },
        ]),
    { type: 'divider' as const },
    {
      key: 'logout',
      label: '退出登录',
      icon: <LogoutOutlined />,
      danger: true,
    },
  ];

  const handleDropdownClick: MenuProps['onClick'] = ({ key }) => {
    if (key === 'profile') {
      void navigate({ to: '/profile' });
      return;
    }
    if (key === 'admin') {
      void navigate({ to: '/admin' });
      return;
    }
    if (key === 'logout') void handleLogout();
  };

  const renderMenu = (onNavigate: (key: string) => void): ReactElement => (
    <Menu
      className="app-menu"
      theme="light"
      mode="inline"
      items={menuItems}
      selectedKeys={selectedKeys}
      openKeys={openKeys}
      onOpenChange={(keys) => setOpenKeys(keys)}
      onClick={({ key }) => onNavigate(key)}
    />
  );

  const userCard = (
    <div className="sidebar-user">
      <UserAvatar user={user} className="sidebar-user-avatar" />
      <div className="sidebar-user-meta">
        <div className="sidebar-user-name">{user?.username ?? '当前用户'}</div>
        <div className="sidebar-user-role">{user?.role === 'admin' ? '管理员' : '团队成员'}</div>
      </div>
      {canSeeProfile ? <SettingOutlined className="sidebar-user-settings" /> : null}
    </div>
  );

  const sidebarFooter = (
    <div className="app-sidebar-footer">
      {canSeeProfile ? (
        <button
          type="button"
          className="sidebar-user-button"
          onClick={() => void navigate({ to: '/profile' })}
          aria-label="打开个人设置"
        >
          {userCard}
        </button>
      ) : (
        userCard
      )}
      {isAdmin ? (
        <Button
          block
          className="app-sidebar-switch"
          icon={<ArrowLeftOutlined />}
          onClick={() => void navigate({ to: '/' })}
        >
          返回用户端
        </Button>
      ) : null}
    </div>
  );

  return (
    <Layout className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <Layout.Sider className="app-sider app-sider-desktop" width={240} theme="light">
        <button
          type="button"
          className="app-brand app-brand-button"
          onClick={() => void navigate({ to: isAdmin ? '/admin' : '/' })}
          aria-label="回到首页"
        >
          <BrandMark />
          <div className="app-brand-copy">
            <div className="app-brand-title">ReviewFlow</div>
            <div className="app-brand-subtitle">{props.brandSubtitle}</div>
          </div>
        </button>
        <div className="app-menu-scroll">
          <div className="app-menu-label">{section}</div>
          {renderMenu(handleNavigate)}
        </div>
        {sidebarFooter}
      </Layout.Sider>

      <Layout className="app-main">
        <header className="app-topbar">
          <div className="app-topbar-left">
            <Button
              className="app-menu-trigger"
              type="text"
              icon={<MenuOutlined />}
              aria-label="打开导航菜单"
              onClick={() => setDrawerOpen(true)}
            />
            <div className="app-breadcrumb" aria-label="当前位置">
              <span className="app-breadcrumb-section">{section}</span>
              <span className="app-breadcrumb-sep" aria-hidden="true">
                /
              </span>
              <span className="app-breadcrumb-current">{title}</span>
            </div>
          </div>
          <div className="app-topbar-actions">
            <Tooltip title={mode === 'dark' ? '切换为浅色模式' : '切换为深色模式'}>
              <Button
                type="text"
                className="app-icon-button"
                aria-label={mode === 'dark' ? '切换为浅色模式' : '切换为深色模式'}
                icon={mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
                onClick={toggle}
              />
            </Tooltip>
            <Dropdown
              trigger={['click']}
              menu={{ items: dropdownItems, onClick: handleDropdownClick }}
              placement="bottomRight"
            >
              <Button className="app-user-trigger" type="text" aria-label="打开用户菜单">
                <UserAvatar user={user} className="app-user-avatar" />
                <span className="app-user-name">{user?.username ?? '当前用户'}</span>
                <DownOutlined className="app-user-chevron" />
              </Button>
            </Dropdown>
          </div>
        </header>
        <Layout.Content className="app-content">
          <main id="main-content" className="app-main-content">
            {props.children}
          </main>
        </Layout.Content>
      </Layout>

      <Drawer
        className="app-nav-drawer"
        placement="left"
        size={286}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        title={
          <div className="app-brand app-brand-drawer">
            <BrandMark />
            <div className="app-brand-copy">
              <div className="app-brand-title">ReviewFlow</div>
              <div className="app-brand-subtitle">{props.brandSubtitle}</div>
            </div>
          </div>
        }
      >
        <div className="app-drawer-menu">
          <div className="app-menu-label">{section}</div>
          {renderMenu(handleNavigate)}
        </div>
        {sidebarFooter}
      </Drawer>
    </Layout>
  );
}
