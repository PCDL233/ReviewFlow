import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { desc, eq, isNull, and } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { HookToken } from '@ai-review/shared';
import { hookTokens } from './schema.js';

/** 令牌明文字节数：24 字节 → 32 位 base64url，满足 192 位熵 */
const TOKEN_BYTES = 24;
/** 展示前缀长度 */
const PREFIX_LENGTH = 8;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Hook / CI 令牌存储。
 * 与 UserStore 一样接受同一个 better-sqlite3 连接（见 openSqlite），
 * 令牌摘要单独成表，避免把凭据混进会话表被打包进备份。
 */
export class HookTokenStore {
  private readonly db: BetterSQLite3Database;

  constructor(sqlite: Database.Database) {
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS hook_tokens (
        id           TEXT PRIMARY KEY,
        token_hash   TEXT NOT NULL UNIQUE,
        prefix       TEXT NOT NULL,
        label        TEXT NOT NULL DEFAULT 'hook',
        created_by   TEXT,
        created_at   TEXT NOT NULL,
        expires_at   TEXT,
        last_used_at TEXT,
        revoked_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hook_tokens_hash ON hook_tokens(token_hash);
    `);
    this.db = drizzle(sqlite);
  }

  /**
   * 签发令牌。
   * @param input 标签、签发人与有效期
   * @returns 令牌行（不含明文）与明文（仅此一次可见）
   */
  public create(input: { label: string; createdBy?: string; expiresInDays: number }): {
    token: HookToken;
    plainText: string;
  } {
    const plainText = `air_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1000);
    this.db
      .insert(hookTokens)
      .values({
        id,
        tokenHash: hashToken(plainText),
        prefix: plainText.slice(0, PREFIX_LENGTH),
        label: input.label,
        createdBy: input.createdBy ?? null,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      })
      .run();
    return {
      token: {
        id,
        label: input.label,
        prefix: plainText.slice(0, PREFIX_LENGTH),
        createdBy: input.createdBy ?? null,
        createdAt: now.toISOString(),
        lastUsedAt: null,
        revokedAt: null,
      },
      plainText,
    };
  }

  /** 列出全部令牌（按签发时间倒序）；不回传摘要或明文。 */
  public list(): HookToken[] {
    return this.db
      .select()
      .from(hookTokens)
      .orderBy(desc(hookTokens.createdAt))
      .all()
      .map((row) => ({
        id: row.id,
        label: row.label,
        prefix: row.prefix,
        createdBy: row.createdBy,
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        revokedAt: row.revokedAt,
      }));
  }

  /**
   * 校验明文令牌。
   * @param plainText 请求头携带的明文
   * @returns 有效时返回令牌行；不存在/已吊销/已过期均返回 undefined
   */
  public verify(plainText: string): HookToken | undefined {
    if (plainText === '') return undefined;
    const row = this.db
      .select()
      .from(hookTokens)
      .where(and(eq(hookTokens.tokenHash, hashToken(plainText)), isNull(hookTokens.revokedAt)))
      .get();
    if (row === undefined) return undefined;
    if (row.expiresAt !== null && row.expiresAt <= new Date().toISOString()) return undefined;
    this.db
      .update(hookTokens)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(eq(hookTokens.id, row.id))
      .run();
    return {
      id: row.id,
      label: row.label,
      prefix: row.prefix,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      revokedAt: row.revokedAt,
    };
  }

  /**
   * 吊销令牌（幂等：已吊销时返回 true）。
   * @returns 令牌存在时为 true，不存在为 false
   */
  public revoke(id: string): boolean {
    const row = this.db.select().from(hookTokens).where(eq(hookTokens.id, id)).get();
    if (row === undefined) return false;
    if (row.revokedAt === null) {
      this.db
        .update(hookTokens)
        .set({ revokedAt: new Date().toISOString() })
        .where(eq(hookTokens.id, id))
        .run();
    }
    return true;
  }
}
