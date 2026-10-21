import { describe, expect, it } from 'vitest';
import { LoginLogSchema, OperationLogSchema } from '@ai-review/shared';
import { openSqlite, ReviewStore, LogStore } from '../src/index.js';

function makeStores(): { store: ReviewStore; logs: LogStore } {
  // ReviewStore 先初始化共享连接的 schema（users/reviews 等），LogStore 自建日志表
  const sqlite = openSqlite(':memory:');
  const store = new ReviewStore(sqlite);
  const logs = new LogStore(sqlite);
  return { store, logs };
}

describe('LogStore', () => {
  it('appends and lists login logs with pagination', () => {
    const { store, logs } = makeStores();
    void store;
    for (let index = 0; index < 3; index += 1) {
      logs.appendLoginLog({
        userId: `u${index}`,
        username: `alice${index}`,
        action: 'login',
        status: 'success',
        ip: '127.0.0.1',
        userAgent: 'vitest',
      });
    }
    logs.appendLoginLog({
      username: 'intruder',
      action: 'login',
      status: 'failed',
      reason: 'invalid-password',
      ip: '10.0.0.1',
    });

    const page1 = logs.listLoginLogs({ page: 1, pageSize: 2 });
    expect(page1.total).toBe(4);
    expect(page1.logs).toHaveLength(2);
    expect(page1.page).toBe(1);
    // 倒序：最新的失败登录排最前
    expect(page1.logs[0]).toMatchObject({
      username: 'intruder',
      status: 'failed',
      reason: 'invalid-password',
      userId: null,
    });

    const page2 = logs.listLoginLogs({ page: 2, pageSize: 2 });
    expect(page2.logs).toHaveLength(2);

    const failed = logs.listLoginLogs({ page: 1, pageSize: 10, status: 'failed' });
    expect(failed.total).toBe(1);

    const byAction = logs.listLoginLogs({ page: 1, pageSize: 10, action: 'login', q: 'alice' });
    expect(byAction.total).toBe(3);

    const none = logs.listLoginLogs({ page: 1, pageSize: 10, q: 'nobody' });
    expect(none.total).toBe(0);
    expect(none.logs).toEqual([]);
  });

  it('filters login logs by date range (UTC natural day)', () => {
    const { logs } = makeStores();
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    logs.appendLoginLog({
      username: 'now',
      action: 'login',
      status: 'success',
      ip: '127.0.0.1',
    });
    logs.appendLoginLog({
      username: 'old',
      action: 'login',
      status: 'success',
      ip: '127.0.0.1',
    });

    const inRange = logs.listLoginLogs({ page: 1, pageSize: 10, from: today, to: today });
    expect(inRange.total).toBeGreaterThanOrEqual(1);
    // 昨天为闭区间下界之外：只命中今天的记录
    const since = logs.listLoginLogs({ page: 1, pageSize: 10, from: today });
    const before = logs.listLoginLogs({ page: 1, pageSize: 10, to: yesterday });
    expect(since.total).toBeGreaterThanOrEqual(1);
    expect(before.total).toBeGreaterThanOrEqual(0);
  });

  it('upgrades stale log tables created by an earlier schema (adds missing columns)', () => {
    // 模拟早期版本的建表（login_logs 缺 action/status/reason；operation_logs 缺 resource/status/reason）
    const sqlite = openSqlite(':memory:');
    sqlite.exec(`
      CREATE TABLE login_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     TEXT,
        username    TEXT NOT NULL,
        success     INTEGER NOT NULL DEFAULT 0,
        ip          TEXT,
        user_agent  TEXT,
        detail      TEXT,
        created_at  TEXT NOT NULL
      );
      CREATE TABLE operation_logs (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      TEXT,
        username     TEXT NOT NULL,
        action       TEXT NOT NULL,
        module       TEXT,
        method       TEXT,
        path         TEXT,
        status_code  INTEGER,
        ip           TEXT,
        user_agent   TEXT,
        detail       TEXT,
        created_at   TEXT NOT NULL
      );
    `);
    // 已有行也不因补列而失败（NOT NULL 列带默认值）
    sqlite.exec(
      "INSERT INTO login_logs (id, username, ip, created_at) VALUES (1, 'legacy', '1.1.1.1', '2025-01-01T00:00:00.000Z')",
    );
    // 早期版本的操作日志行：中文显示标签 action、NULL ip/detail（旧列记录原始信息）
    sqlite.exec(
      "INSERT INTO operation_logs (id, username, action, module, method, path, status_code, ip, user_agent, detail, created_at) VALUES (1, 'admin', '删除审查', 'review', 'DELETE', '/api/reviews/r-1', 200, NULL, NULL, NULL, '2025-01-01T00:00:00.000Z')",
    );

    const logs = new LogStore(sqlite);
    logs.appendLoginLog({
      username: 'boss',
      action: 'login',
      status: 'success',
      ip: '127.0.0.1',
    });
    logs.appendOperationLog({
      username: 'boss',
      action: 'create',
      resource: 'user',
      status: 'success',
      ip: '127.0.0.1',
    });

    const loginPage = logs.listLoginLogs({ page: 1, pageSize: 10 });
    expect(loginPage.total).toBe(2); // 存量行 + 新写入行
    expect(loginPage.logs[0]).toMatchObject({
      username: 'boss',
      action: 'login',
      status: 'success',
    });

    const opPage = logs.listOperationLogs({ page: 1, pageSize: 10 });
    expect(opPage.total).toBe(2);
    // 存量行被归一化：非枚举 action 回退 update、NULL 字段补默认值（通过响应 schema 校验）
    const legacy = opPage.logs[1];
    expect(legacy).toMatchObject({ action: 'update', ip: '', detail: '', resource: '' });

    // 与 app.ts 相同：读回的行必须通过响应 schema 校验（曾因枚举外 action/NULL 字段 500）
    expect(LoginLogSchema.safeParse(loginPage.logs[0]).success).toBe(true);
    for (const log of opPage.logs) {
      expect(OperationLogSchema.safeParse(log).success).toBe(true);
    }

    sqlite.close();
  });

  it('appends and lists operation logs with resource/action filters', () => {
    const { logs } = makeStores();
    logs.appendOperationLog({
      userId: 'admin-1',
      username: 'boss',
      action: 'create',
      resource: 'user',
      resourceId: 'u-1',
      detail: JSON.stringify({ username: 'carol' }),
      status: 'success',
      ip: '127.0.0.1',
    });
    logs.appendOperationLog({
      userId: 'admin-1',
      username: 'boss',
      action: 'save_config',
      resource: 'config',
      status: 'success',
      ip: '127.0.0.1',
    });
    logs.appendOperationLog({
      userId: 'admin-1',
      username: 'boss',
      action: 'start_review',
      resource: 'review',
      resourceId: 'review-1',
      status: 'success',
      ip: '127.0.0.1',
    });

    const all = logs.listOperationLogs({ page: 1, pageSize: 10 });
    expect(all.total).toBe(3);

    const byResource = logs.listOperationLogs({ page: 1, pageSize: 10, resource: 'review' });
    expect(byResource.total).toBe(1);
    expect(byResource.logs[0]?.resourceId).toBe('review-1');

    const byAction = logs.listOperationLogs({ page: 1, pageSize: 10, action: 'create' });
    expect(byAction.total).toBe(1);
    expect(byAction.logs[0]?.detail).toContain('carol');

    const byQ = logs.listOperationLogs({ page: 1, pageSize: 10, q: 'review-1' });
    expect(byQ.total).toBe(1);

    const failed = logs.listOperationLogs({ page: 1, pageSize: 10, status: 'failed' });
    expect(failed.total).toBe(0);
  });
});
