import { describe, expect, it } from 'vitest';
import { adminGroupKeyOf, buildAdminMenu, isAdminMenuGroup } from '../src/admin-menu';

describe('buildAdminMenu', () => {
  it("'*' 权限显示全部：概览 + 4 个分组 + 指标，共 6 项", () => {
    const menu = buildAdminMenu(['*']);
    expect(menu).toHaveLength(6);
    expect(menu[0]).toMatchObject({ key: '/admin', label: '系统概览' });
    expect(menu.at(-1)).toMatchObject({ key: '/admin/metrics', label: '系统指标' });

    const logs = menu.find((entry) => entry.key === 'group:logs');
    expect(logs).toBeDefined();
    expect(isAdminMenuGroup(logs!)).toBe(true);
    if (logs !== undefined && isAdminMenuGroup(logs)) {
      expect(logs.label).toBe('系统日志');
      expect(logs.children.map((child) => child.key)).toEqual([
        '/admin/login-logs',
        '/admin/operation-logs',
      ]);
    }
  });

  it('无权限子项时整组隐藏（仅持有登录日志权限）', () => {
    const menu = buildAdminMenu(['/admin/login-logs']);
    expect(menu).toHaveLength(1);
    const logs = menu[0];
    expect(logs).toBeDefined();
    expect(isAdminMenuGroup(logs!)).toBe(true);
    if (logs !== undefined && isAdminMenuGroup(logs)) {
      expect(logs.key).toBe('group:logs');
      expect(logs.children.map((child) => child.key)).toEqual(['/admin/login-logs']);
    }
  });

  it('仅单页权限时只显示所属分组（自定义规则 → 审查配置）', () => {
    const menu = buildAdminMenu(['/admin/rules']);
    expect(menu).toHaveLength(1);
    const review = menu[0];
    expect(review).toBeDefined();
    expect(review?.key).toBe('group:review');
    if (review !== undefined && isAdminMenuGroup(review)) {
      expect(review.children.map((child) => child.key)).toEqual(['/admin/rules']);
    }
  });

  it('平铺项按自身权限显示（仅持有指标权限时只显示指标）', () => {
    const menu = buildAdminMenu(['/admin/metrics']);
    expect(menu.map((entry) => entry.key)).toEqual(['/admin/metrics']);
  });

  it('持有 /admin 概览权限时（前缀授权）显示全部分组', () => {
    expect(buildAdminMenu(['/admin'])).toHaveLength(6);
  });

  it('空权限时不显示任何管理菜单', () => {
    expect(buildAdminMenu([])).toHaveLength(0);
  });
});

describe('adminGroupKeyOf', () => {
  it('叶子路径映射到所属分组', () => {
    expect(adminGroupKeyOf('/admin/users')).toBe('group:access');
    expect(adminGroupKeyOf('/admin/roles')).toBe('group:access');
    expect(adminGroupKeyOf('/admin/rules')).toBe('group:review');
    expect(adminGroupKeyOf('/admin/knowledge')).toBe('group:review');
    expect(adminGroupKeyOf('/admin/tools')).toBe('group:review');
    expect(adminGroupKeyOf('/admin/ai')).toBe('group:settings');
    expect(adminGroupKeyOf('/admin/config')).toBe('group:settings');
    expect(adminGroupKeyOf('/admin/init')).toBe('group:settings');
    expect(adminGroupKeyOf('/admin/hook')).toBe('group:settings');
    expect(adminGroupKeyOf('/admin/login-logs')).toBe('group:logs');
    expect(adminGroupKeyOf('/admin/operation-logs')).toBe('group:logs');
  });

  it('平铺项（概览/指标）无分组，返回 null', () => {
    expect(adminGroupKeyOf('/admin')).toBeNull();
    expect(adminGroupKeyOf('/admin/metrics')).toBeNull();
    expect(adminGroupKeyOf('/unknown')).toBeNull();
  });
});
