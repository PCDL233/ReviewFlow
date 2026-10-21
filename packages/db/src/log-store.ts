import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, count, desc, eq, gte, like, lte, or } from 'drizzle-orm';
import type {
  LoginLog,
  LoginLogAction,
  LoginLogQuery,
  OperationLog,
  OperationLogAction,
  OperationLogQuery,
} from '@ai-review/shared';
import { loginLogs, operationLogs } from './schema.js';

export type { LoginLog, OperationLog, LoginLogAction, OperationLogAction };

/**
 * 审计日志存储（SQLite，与 ReviewStore/UserStore 共用连接）。
 * 记录登录日志与操作日志（参照云审计字段规范：时间/操作者/IP/UA/动作/资源/结果/原因）。
 * 本类自建表（幂等 CREATE TABLE IF NOT EXISTS），不依赖构造顺序；新表无存量升级需求。
 */
export class LogStore {
  private readonly db: BetterSQLite3Database;

  constructor(sqlite: Database.Database) {
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS login_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     TEXT,
        username    TEXT NOT NULL,
        action      TEXT NOT NULL,
        status      TEXT NOT NULL,
        reason      TEXT,
        ip          TEXT NOT NULL,
        user_agent  TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_login_logs_created_at ON login_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_login_logs_username ON login_logs(username);
      CREATE TABLE IF NOT EXISTS operation_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     TEXT,
        username    TEXT NOT NULL,
        action      TEXT NOT NULL,
        resource    TEXT NOT NULL,
        resource_id TEXT NOT NULL DEFAULT '',
        detail      TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL,
        reason      TEXT,
        ip          TEXT NOT NULL,
        user_agent  TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at);
      CREATE INDEX IF NOT EXISTS idx_operation_logs_username ON operation_logs(username);
    `);
    // 存量升级（对齐 ReviewStore 的 ALTER 模式）：早期版本的表缺列（login_logs 缺
    // action/status/reason；operation_logs 缺 resource/resource_id/status/reason），
    // CREATE TABLE IF NOT EXISTS 不会补列，须逐列 ALTER；NOT NULL 列带 DEFAULT 以便已有行落值，
    // 重复列报错忽略。
    for (const ddl of [
      "ALTER TABLE login_logs ADD COLUMN action TEXT NOT NULL DEFAULT 'login'",
      "ALTER TABLE login_logs ADD COLUMN status TEXT NOT NULL DEFAULT 'success'",
      'ALTER TABLE login_logs ADD COLUMN reason TEXT',
      "ALTER TABLE login_logs ADD COLUMN ip TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE login_logs ADD COLUMN user_agent TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE operation_logs ADD COLUMN resource TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE operation_logs ADD COLUMN resource_id TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE operation_logs ADD COLUMN status TEXT NOT NULL DEFAULT 'success'",
      'ALTER TABLE operation_logs ADD COLUMN reason TEXT',
      "ALTER TABLE operation_logs ADD COLUMN ip TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE operation_logs ADD COLUMN user_agent TEXT NOT NULL DEFAULT ''",
    ]) {
      try {
        sqlite.exec(ddl);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (!message.includes('duplicate column name')) throw e;
      }
    }
    // 存量数据归一化：早期版本的行可能存在枚举外 action 值（旧设计以 module/method/path
    // 记录 HTTP 审计，动作为显示标签）与 NULL 字段，统一回退为通用动作 update
    // （原始信息仍保留在旧列中），NULL 补默认值，保证读回可通过响应 schema 校验。
    sqlite.exec(`
      UPDATE operation_logs SET action='update'
        WHERE action NOT IN ('create','update','delete','login','logout','register','change_password','reset_password','assign_roles','start_review','rerun_review','cancel_review','delete_review','mark_false_positive','save_config','save_rules','test_rules','reindex_knowledge');
      UPDATE operation_logs SET ip='' WHERE ip IS NULL;
      UPDATE operation_logs SET user_agent='' WHERE user_agent IS NULL;
      UPDATE operation_logs SET detail='' WHERE detail IS NULL;
      UPDATE login_logs SET ip='' WHERE ip IS NULL;
      UPDATE login_logs SET user_agent='' WHERE user_agent IS NULL;
    `);
    this.db = drizzle(sqlite);
  }

  /** 写入一条登录日志（成功与失败均记录，失败含原因；不记录密码/令牌） */
  public appendLoginLog(input: {
    userId?: string | null;
    username: string;
    action: LoginLogAction;
    status: 'success' | 'failed';
    reason?: string | null;
    ip: string;
    userAgent?: string;
  }): void {
    this.db
      .insert(loginLogs)
      .values({
        userId: input.userId ?? null,
        username: input.username,
        action: input.action,
        status: input.status,
        reason: input.reason ?? null,
        ip: input.ip,
        userAgent: input.userAgent ?? '',
      })
      .run();
  }

  /** 写入一条操作日志（审计管理后台/审查写操作） */
  public appendOperationLog(input: {
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
  }): void {
    this.db
      .insert(operationLogs)
      .values({
        userId: input.userId ?? null,
        username: input.username,
        action: input.action,
        resource: input.resource,
        resourceId: input.resourceId ?? '',
        detail: input.detail ?? '',
        status: input.status,
        reason: input.reason ?? null,
        ip: input.ip,
        userAgent: input.userAgent ?? '',
      })
      .run();
  }

  /** 登录日志分页查询（倒序 + 日期/状态/动作/用户名筛选；from/to 按 UTC 自然日闭区间） */
  public listLoginLogs(query: LoginLogQuery): {
    logs: LoginLog[];
    total: number;
    page: number;
    pageSize: number;
  } {
    const filters = [
      query.q === undefined ? undefined : like(loginLogs.username, `%${query.q}%`),
      query.status === undefined ? undefined : eq(loginLogs.status, query.status),
      query.action === undefined ? undefined : eq(loginLogs.action, query.action),
      query.from === undefined
        ? undefined
        : gte(loginLogs.createdAt, `${query.from}T00:00:00.000Z`),
      query.to === undefined ? undefined : lte(loginLogs.createdAt, `${query.to}T23:59:59.999Z`),
    ];
    const where = and(...filters);
    const totalRow = this.db.select({ value: count() }).from(loginLogs).where(where).get();
    const rows = this.db
      .select()
      .from(loginLogs)
      .where(where)
      .orderBy(desc(loginLogs.createdAt), desc(loginLogs.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .all();
    return {
      logs: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        username: row.username,
        action: row.action,
        status: row.status,
        reason: row.reason,
        // 存量行的可空列可能为 NULL（早期 schema），兜底为空串保证响应 schema 可校验
        ip: row.ip ?? '',
        userAgent: row.userAgent ?? '',
        createdAt: row.createdAt,
      })),
      total: totalRow?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** 操作日志分页查询（倒序 + 日期/动作/资源/状态/关键词筛选） */
  public listOperationLogs(query: OperationLogQuery): {
    logs: OperationLog[];
    total: number;
    page: number;
    pageSize: number;
  } {
    const filters = [
      query.q === undefined
        ? undefined
        : or(
            like(operationLogs.username, `%${query.q}%`),
            like(operationLogs.resource, `%${query.q}%`),
            like(operationLogs.resourceId, `%${query.q}%`),
          ),
      query.action === undefined ? undefined : eq(operationLogs.action, query.action),
      query.resource === undefined ? undefined : eq(operationLogs.resource, query.resource),
      query.status === undefined ? undefined : eq(operationLogs.status, query.status),
      query.from === undefined
        ? undefined
        : gte(operationLogs.createdAt, `${query.from}T00:00:00.000Z`),
      query.to === undefined
        ? undefined
        : lte(operationLogs.createdAt, `${query.to}T23:59:59.999Z`),
    ];
    const where = and(...filters);
    const totalRow = this.db.select({ value: count() }).from(operationLogs).where(where).get();
    const rows = this.db
      .select()
      .from(operationLogs)
      .where(where)
      .orderBy(desc(operationLogs.createdAt), desc(operationLogs.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize)
      .all();
    return {
      logs: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        username: row.username,
        action: row.action,
        resource: row.resource,
        resourceId: row.resourceId,
        // 存量行的可空列可能为 NULL（早期 schema），兜底为空串保证响应 schema 可校验
        detail: row.detail ?? '',
        status: row.status,
        reason: row.reason,
        ip: row.ip ?? '',
        userAgent: row.userAgent ?? '',
        createdAt: row.createdAt,
      })),
      total: totalRow?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }
}
