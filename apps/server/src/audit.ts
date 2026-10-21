import type { LogStore } from '@ai-review/db';
import type {
  LoginLog,
  LoginLogAction,
  LoginLogQuery,
  OperationLog,
  OperationLogAction,
  OperationLogQuery,
} from '@ai-review/shared';
import { Logger, type AuditLogEntry } from './logger.js';

/** 登录日志写入入参（与 login_logs 表列对应） */
export type LoginAuditInput = {
  userId?: string | null;
  username: string;
  action: LoginLogAction;
  status: 'success' | 'failed';
  reason?: string | null;
  ip: string;
  userAgent?: string;
};

/** 操作日志写入入参（与 operation_logs 表列对应） */
export type OperationAuditInput = {
  userId?: string | null;
  username: string;
  action: OperationLogAction;
  resource: string;
  resourceId?: string;
  detail?: string;
  status: 'success' | 'failed';
  reason?: string | null;
  ip: string;
  userAgent?: string;
};

/**
 * 审计日志服务（登录日志 + 操作日志的统一门面）：
 * - 写路径：SQLite（后台页面查询）与 Logger（控制台 + 按日文件归档）双写；
 *   enabled=false 时不再写入新日志（存量日志仍可查询）
 * - 读路径：分页 + 日期/状态/动作/用户名筛选，透传给 LogStore
 */
export class AuditService {
  constructor(
    private readonly store: LogStore | undefined,
    private readonly logger: Logger | undefined,
    private readonly enabled: boolean,
  ) {}

  /** 记录一条登录/认证事件（成功与失败均记录，失败含原因） */
  public login(input: LoginAuditInput): void {
    if (!this.enabled || this.store === undefined || this.logger === undefined) return;
    try {
      this.store.appendLoginLog(input);
      this.logger.write(this.toEntry('login', input));
    } catch (e) {
      // 审计写入失败不应阻断业务主流程（如磁盘满/表损坏）：记录告警后继续
      console.error('[ai-review] audit log write failed (login):', e);
    }
  }

  /** 记录一条操作事件（管理后台/审查写操作审计） */
  public operation(input: OperationAuditInput): void {
    if (!this.enabled || this.store === undefined || this.logger === undefined) return;
    try {
      this.store.appendOperationLog(input);
      this.logger.write(this.toEntry('operation', input));
    } catch (e) {
      // 审计写入失败不应阻断业务主流程（如磁盘满/表损坏）：记录告警后继续
      console.error('[ai-review] audit log write failed (operation):', e);
    }
  }

  /** 登录日志分页查询（不受 enabled 影响：存量日志仍可查询） */
  public listLoginLogs(query: LoginLogQuery): {
    logs: LoginLog[];
    total: number;
    page: number;
    pageSize: number;
  } {
    if (this.store === undefined) {
      return { logs: [], total: 0, page: query.page, pageSize: query.pageSize };
    }
    return this.store.listLoginLogs(query);
  }

  /** 操作日志分页查询 */
  public listOperationLogs(query: OperationLogQuery): {
    logs: OperationLog[];
    total: number;
    page: number;
    pageSize: number;
  } {
    if (this.store === undefined) {
      return { logs: [], total: 0, page: query.page, pageSize: query.pageSize };
    }
    return this.store.listOperationLogs(query);
  }

  private toEntry(
    kind: AuditLogEntry['kind'],
    input: LoginAuditInput | OperationAuditInput,
  ): AuditLogEntry {
    const operation = input as OperationAuditInput;
    return {
      kind,
      level: input.status === 'success' ? 'info' : 'warn',
      userId: input.userId ?? null,
      username: input.username,
      action: input.action,
      resource: operation.resource ?? 'auth',
      resourceId: operation.resourceId ?? '',
      detail: operation.detail ?? '',
      status: input.status,
      reason: input.reason ?? null,
      ip: input.ip,
      userAgent: input.userAgent ?? '',
      createdAt: new Date().toISOString(),
    };
  }
}

/** 未装配审计时的空实现（enabled=false，写路径全部 no-op；查询返回空页） */
export function createNoopAudit(): AuditService {
  return new AuditService(undefined, undefined, false);
}
