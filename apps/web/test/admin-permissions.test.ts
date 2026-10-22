import { describe, expect, it } from 'vitest';
import {
  ALL_ROUTE_PERMISSIONS,
  DEFAULT_USER_PATHS,
  WILDCARD_PERMISSION,
  canAccessPath,
  firstPermittedAdminPath,
  hasAdminAccess,
} from '../src/permissions';
import { adminGroupKeyOf, buildAdminMenu } from '../src/admin-menu';
import { pageTitleOf } from '../src/navigation';

/** 管理后台每个路由都必须可被授予，否则该页面只能靠 '*' 才能访问。 */
describe('ALL_ROUTE_PERMISSIONS 覆盖管理后台全部路由', () => {
  const adminPaths = ALL_ROUTE_PERMISSIONS.filter((item) => item.group === 'admin').map(
    (item) => item.path,
  );

  it('包含管理后台侧栏的每一个叶子路径', () => {
    const menuLeaves = buildAdminMenu([WILDCARD_PERMISSION]).flatMap((entry) =>
      'children' in entry ? entry.children.map((child) => child.key) : [entry.key],
    );
    for (const leaf of menuLeaves) {
      expect(adminPaths).toContain(leaf);
    }
  });

  it('模型调用审计页既可授予也可分组定位', () => {
    expect(adminPaths).toContain('/admin/observability');
    expect(canAccessPath(['/admin/observability'], '/admin/observability')).toBe(true);
    expect(adminGroupKeyOf('/admin/observability')).toBe('group:logs');
    expect(pageTitleOf('/admin/observability')).toBe('模型调用审计');
  });

  it('仅授予审计页权限即可进入管理后台', () => {
    expect(hasAdminAccess(['/admin/observability'], 'user')).toBe(true);
    expect(firstPermittedAdminPath(['/admin/observability'])).toBe('/admin/observability');
  });

  it('路径唯一且标签非空', () => {
    const paths = ALL_ROUTE_PERMISSIONS.map((item) => item.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const item of ALL_ROUTE_PERMISSIONS) {
      expect(item.label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('通配权限', () => {
  it('常量与 canAccessPath 的判定语义一致', () => {
    expect(WILDCARD_PERMISSION).toBe('*');
    expect(canAccessPath([WILDCARD_PERMISSION], '/admin/observability')).toBe(true);
    expect(canAccessPath([WILDCARD_PERMISSION], '/anything/else')).toBe(true);
  });
});

describe('DEFAULT_USER_PATHS', () => {
  it('仅覆盖用户端页面，不隐含任何管理权限', () => {
    for (const path of DEFAULT_USER_PATHS) {
      expect(canAccessPath(DEFAULT_USER_PATHS, path)).toBe(true);
    }
    expect(DEFAULT_USER_PATHS.some((path) => path.startsWith('/admin'))).toBe(false);
  });
});
