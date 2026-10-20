import { z } from 'zod';
import {
  AdminCreateUserSchema,
  AdminOverviewResponseSchema,
  AdminRulesResponseSchema,
  AdminRulesUpdateSchema,
  AssignRolesSchema,
  CustomRuleTestRequestSchema,
  CustomRuleTestResultSchema,
  LoginLogListResponseSchema,
  OperationLogListResponseSchema,
  ResetPasswordResponseSchema,
  RoleInputSchema,
  RoleListResponseSchema,
  RoleResponseSchema,
  UserListResponseSchema,
} from '@ai-review/shared/api';
import type {
  AdminCreateUserInput,
  AdminOverview,
  AdminUserPatch,
  CustomRule,
  CustomRuleTestRequest,
  CustomRuleTestResult,
  LoginLogListResponse,
  LoginLogQuery,
  OperationLogListResponse,
  OperationLogQuery,
  Role,
  RoleInput,
  User,
} from '@ai-review/shared/api';
import { parseResponse } from '../parse-response';

const API_BASE = '/api/admin';

const AdminUserResponseSchema = z.object({ user: UserListResponseSchema.shape.users.element });
const DeleteUserResponseSchema = z.object({ deleted: z.boolean() });

/** 用户列表（后台管理页） */
export async function fetchUsers(): Promise<User[]> {
  const body = await parseResponse(UserListResponseSchema, await fetch(`${API_BASE}/users`));
  return body.users;
}

/** 修改用户角色/状态 */
export async function patchUser(userId: string, patch: AdminUserPatch): Promise<User> {
  const response = await fetch(`${API_BASE}/users/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body = await parseResponse(AdminUserResponseSchema, response);
  return body.user;
}

/** 管理员创建普通用户 */
export async function createUser(input: AdminCreateUserInput): Promise<User> {
  const payload = AdminCreateUserSchema.parse(input);
  const response = await fetch(`${API_BASE}/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await parseResponse(AdminUserResponseSchema, response);
  return body.user;
}

/** 重置密码（服务端生成新密码，仅本次响应可见明文） */
export async function resetUserPassword(userId: string): Promise<string> {
  const response = await fetch(`${API_BASE}/users/${encodeURIComponent(userId)}/reset-password`, {
    method: 'POST',
  });
  const body = await parseResponse(ResetPasswordResponseSchema, response);
  return body.newPassword;
}

export async function deleteUser(userId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/users/${encodeURIComponent(userId)}`, {
    method: 'DELETE',
  });
  await parseResponse(DeleteUserResponseSchema, response);
}

/** 给用户分配角色（整体替换） */
export async function assignRoles(userId: string, roleIds: string[]): Promise<User> {
  const payload = AssignRolesSchema.parse({ roleIds });
  const response = await fetch(`${API_BASE}/users/${encodeURIComponent(userId)}/roles`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await parseResponse(AdminUserResponseSchema, response);
  return body.user;
}

/** 角色列表 */
export async function fetchRoles(): Promise<Role[]> {
  const body = await parseResponse(RoleListResponseSchema, await fetch(`${API_BASE}/roles`));
  return body.roles;
}

/** 创建角色 */
export async function createRole(input: RoleInput): Promise<Role> {
  const payload = RoleInputSchema.parse(input);
  const response = await fetch(`${API_BASE}/roles`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await parseResponse(RoleResponseSchema, response);
  return body.role;
}

/** 更新角色 */
export async function updateRole(roleId: string, input: RoleInput): Promise<Role> {
  const payload = RoleInputSchema.parse(input);
  const response = await fetch(`${API_BASE}/roles/${encodeURIComponent(roleId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await parseResponse(RoleResponseSchema, response);
  return body.role;
}

/** 删除角色 */
export async function deleteRole(roleId: string): Promise<void> {
  const response = await fetch(`${API_BASE}/roles/${encodeURIComponent(roleId)}`, {
    method: 'DELETE',
  });
  await parseResponse(z.object({ deleted: z.boolean() }), response);
}

/** 系统概览聚合（后台首页卡片） */
export async function fetchAdminOverview(): Promise<AdminOverview> {
  const body = await parseResponse(
    AdminOverviewResponseSchema,
    await fetch(`${API_BASE}/overview`),
  );
  return body.overview;
}

/** 自定义审查规则列表 */
export async function fetchCustomRules(): Promise<CustomRule[]> {
  const body = await parseResponse(AdminRulesResponseSchema, await fetch(`${API_BASE}/rules`));
  return body.rules;
}

/** 保存自定义审查规则（整体替换） */
export async function updateCustomRules(rules: CustomRule[]): Promise<CustomRule[]> {
  const payload = AdminRulesUpdateSchema.parse({ rules });
  const response = await fetch(`${API_BASE}/rules`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await parseResponse(AdminRulesResponseSchema, response);
  return body.rules;
}

/** 试跑自定义审查规则（返回在示例输入上的命中行） */
export async function testCustomRule(
  request: CustomRuleTestRequest,
): Promise<CustomRuleTestResult> {
  const payload = CustomRuleTestRequestSchema.parse(request);
  const response = await fetch(`${API_BASE}/rules/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return parseResponse(CustomRuleTestResultSchema, response);
}

/** 组装查询字符串（省略未定义的筛选字段） */
function toQueryString(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

/** 登录日志分页查询（管理后台） */
export async function fetchLoginLogs(query: LoginLogQuery): Promise<LoginLogListResponse> {
  const body = await parseResponse(
    LoginLogListResponseSchema,
    await fetch(`${API_BASE}/login-logs?${toQueryString(query)}`),
  );
  return body;
}

/** 操作日志分页查询（管理后台） */
export async function fetchOperationLogs(
  query: OperationLogQuery,
): Promise<OperationLogListResponse> {
  const body = await parseResponse(
    OperationLogListResponseSchema,
    await fetch(`${API_BASE}/operation-logs?${toQueryString(query)}`),
  );
  return body;
}
