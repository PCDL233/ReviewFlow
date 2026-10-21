import type Database from 'better-sqlite3';

/**
 * 轻量迁移框架：以版本号记录已执行的 DDL，启动时幂等补齐。
 * 为什么不再用 `ALTER ... try/catch`：列一多就无法区分“已存在”“拼写错误”“权限失败”，
 * 也无法知道某个库到底跑过哪些变更。后续新增列/表只追加一个 Migration。
 */
type Migration = {
  version: number;
  name: string;
  apply(sqlite: Database.Database): void;
};

function tableColumns(sqlite: Database.Database, table: string): Set<string> {
  const rows = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function addColumn(
  sqlite: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  if (tableColumns(sqlite, table).has(column)) return;
  // 表名/列名/定义均为本文件常量，不含外部输入
  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'reviews-metric-columns',
    apply(sqlite) {
      addColumn(sqlite, 'reviews', 'created_by', 'TEXT');
      addColumn(sqlite, 'reviews', 'diff_text', 'TEXT');
      addColumn(sqlite, 'reviews', 'error_message', 'TEXT');
      addColumn(sqlite, 'reviews', 'block_on', 'TEXT');
      addColumn(sqlite, 'reviews', 'target', 'TEXT');
      addColumn(sqlite, 'reviews', 'source_label', 'TEXT');
      addColumn(sqlite, 'reviews', 'change_risk_score', 'REAL');
      addColumn(sqlite, 'reviews', 'review_score', 'REAL');
      addColumn(sqlite, 'reviews', 'llm_status', 'TEXT');
      addColumn(sqlite, 'reviews', 'prompt_version', 'TEXT');
      addColumn(sqlite, 'reviews', 'cache_hits', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(sqlite, 'reviews', 'heal_rounds', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(sqlite, 'reviews', 'dimensions', 'TEXT');
      addColumn(sqlite, 'reviews', 'parent_review_id', 'TEXT');
    },
  },
  {
    version: 2,
    name: 'findings-lifecycle-columns',
    apply(sqlite) {
      addColumn(sqlite, 'findings', 'fingerprint', 'TEXT');
      addColumn(sqlite, 'findings', 'origin', 'TEXT');
      addColumn(sqlite, 'findings', 'line_scope', 'TEXT');
      addColumn(sqlite, 'findings', 'agents', 'TEXT');
      addColumn(sqlite, 'findings', 'status', "TEXT NOT NULL DEFAULT 'open'");
      addColumn(sqlite, 'findings', 'rule_id', 'TEXT');
      addColumn(sqlite, 'findings', 'review_round', 'INTEGER NOT NULL DEFAULT 0');
      addColumn(sqlite, 'findings', 'updated_at', 'TEXT');
    },
  },
  {
    version: 3,
    name: 'users-avatar-column',
    apply(sqlite) {
      addColumn(sqlite, 'users', 'avatar_url', 'TEXT');
    },
  },
  {
    version: 4,
    name: 'query-indexes',
    apply(sqlite) {
      sqlite.exec(
        'CREATE INDEX IF NOT EXISTS idx_findings_fingerprint ON findings(fingerprint)',
      );
      sqlite.exec(
        'CREATE INDEX IF NOT EXISTS idx_reviews_repo_created ON reviews(repo_path, created_at)',
      );
    },
  },
  {
    version: 5,
    name: 'llm-calls',
    apply(sqlite) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS llm_calls (
          id                INTEGER PRIMARY KEY AUTOINCREMENT,
          review_id         TEXT NOT NULL REFERENCES reviews(id),
          dimension         TEXT NOT NULL,
          provider          TEXT NOT NULL,
          model             TEXT NOT NULL,
          status            TEXT NOT NULL,
          round             INTEGER NOT NULL DEFAULT 0,
          prompt_tokens     INTEGER NOT NULL DEFAULT 0,
          completion_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens      INTEGER NOT NULL DEFAULT 0,
          estimated         INTEGER NOT NULL DEFAULT 0,
          latency_ms        INTEGER NOT NULL DEFAULT 0,
          prompt_chars      INTEGER NOT NULL DEFAULT 0,
          fallback_used     INTEGER NOT NULL DEFAULT 0,
          attempts_json     TEXT NOT NULL DEFAULT '[]',
          created_at        TEXT NOT NULL
        );
      `);
      sqlite.exec(
        'CREATE INDEX IF NOT EXISTS idx_llm_calls_review ON llm_calls(review_id)',
      );
      sqlite.exec(
        'CREATE INDEX IF NOT EXISTS idx_llm_calls_created ON llm_calls(created_at)',
      );
    },
  },
  {
    version: 6,
    name: 'finding-lifecycle',
    apply(sqlite) {
      addColumn(sqlite, 'reviews', 'decision', 'TEXT');
      addColumn(sqlite, 'reviews', 'decision_comment', 'TEXT');
      addColumn(sqlite, 'reviews', 'decided_by', 'TEXT');
      addColumn(sqlite, 'reviews', 'decided_at', 'TEXT');
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS finding_comments (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          finding_id INTEGER NOT NULL REFERENCES findings(id),
          user_id    TEXT,
          username   TEXT NOT NULL,
          body       TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      sqlite.exec(
        'CREATE INDEX IF NOT EXISTS idx_finding_comments_finding ON finding_comments(finding_id)',
      );
    },
  },
  {
    version: 7,
    name: 'review-stages',
    apply(sqlite) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS review_stages (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          review_id   TEXT NOT NULL,
          node        TEXT NOT NULL,
          status      TEXT NOT NULL,
          started_at  TEXT NOT NULL,
          finished_at TEXT NOT NULL,
          duration_ms INTEGER NOT NULL DEFAULT 0,
          detail      TEXT
        );
      `);
      sqlite.exec(
        'CREATE INDEX IF NOT EXISTS idx_review_stages_review ON review_stages(review_id)',
      );
    },
  },
  {
    version: 8,
    name: 'review-decision-events',
    apply(sqlite) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS review_decision_events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          review_id  TEXT NOT NULL,
          decision   TEXT NOT NULL,
          comment    TEXT,
          decided_by TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
      sqlite.exec(
        'CREATE INDEX IF NOT EXISTS idx_review_decision_events_review ON review_decision_events(review_id)',
      );
    },
  },
  {
    version: 9,
    name: 'langgraph-checkpoints',
    apply(sqlite) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS langgraph_checkpoints (
          thread_id            TEXT NOT NULL,
          checkpoint_ns        TEXT NOT NULL,
          checkpoint_id        TEXT NOT NULL,
          parent_checkpoint_id TEXT,
          checkpoint           BLOB NOT NULL,
          metadata             BLOB NOT NULL,
          created_at           TEXT NOT NULL,
          PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
        );
        CREATE TABLE IF NOT EXISTS langgraph_writes (
          thread_id     TEXT NOT NULL,
          checkpoint_ns TEXT NOT NULL,
          checkpoint_id TEXT NOT NULL,
          write_key     TEXT NOT NULL,
          task_id       TEXT NOT NULL,
          channel       TEXT NOT NULL,
          value         BLOB NOT NULL,
          PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, write_key)
        );
      `);
    },
  },
  {
    version: 10,
    name: 'review-jobs',
    apply(sqlite) {
      sqlite.exec(`
        CREATE TABLE IF NOT EXISTS review_jobs (
          review_id    TEXT PRIMARY KEY,
          options_json TEXT NOT NULL,
          status       TEXT NOT NULL,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_review_jobs_status ON review_jobs(status);
      `);
    },
  },
];

/**
 * 执行所有未应用的迁移（幂等）。
 * @param sqlite better-sqlite3 连接（与 ReviewStore 共用）
 */
export function runMigrations(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    (sqlite.prepare('SELECT version FROM schema_migrations').all() as Array<{ version: number }>).map(
      (row) => Number(row.version),
    ),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const transaction = sqlite.transaction(() => {
      migration.apply(sqlite);
      sqlite
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
    });
    transaction();
  }
}
