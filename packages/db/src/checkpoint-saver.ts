import type Database from 'better-sqlite3';
import { MemorySaver } from '@langchain/langgraph-checkpoint';

/** MemorySaver 的持久化子类：写穿到 SQLite，进程重启后仍能按 thread_id 续跑。 */
type PutConfig = Parameters<MemorySaver['put']>[0];
type PutCheckpoint = Parameters<MemorySaver['put']>[1];
type PutMetadata = Parameters<MemorySaver['put']>[2];
type PutWrites = Parameters<MemorySaver['putWrites']>[1];

type CheckpointRow = {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  checkpoint: Buffer;
  metadata: Buffer;
};

type WriteRow = {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  write_key: string;
  task_id: string;
  channel: string;
  value: Buffer;
};

/**
 * LangGraph 检查点存储（SQLite）。
 * 复用 MemorySaver 的序列化与读取逻辑，仅在 put/putWrites/deleteThread 时写穿数据库；
 * 启动时把已持久化的 checkpoint 重新装载进内存索引，因此可以直接用同一 thread_id 恢复执行。
 */
export class SqliteCheckpointSaver extends MemorySaver {
  private readonly sqlite: Database.Database;

  constructor(sqlite: Database.Database) {
    super();
    this.sqlite = sqlite;
    this.loadPersisted();
  }

  private loadPersisted(): void {
    const checkpoints = this.sqlite
      .prepare(
        'SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata FROM langgraph_checkpoints',
      )
      .all() as CheckpointRow[];
    for (const row of checkpoints) {
      const byThread = (this.storage[row.thread_id] ??= {});
      const byNamespace = (byThread[row.checkpoint_ns] ??= {});
      byNamespace[row.checkpoint_id] = [
        new Uint8Array(row.checkpoint),
        new Uint8Array(row.metadata),
        row.parent_checkpoint_id ?? undefined,
      ];
    }
    const writes = this.sqlite
      .prepare(
        'SELECT thread_id, checkpoint_ns, checkpoint_id, write_key, task_id, channel, value FROM langgraph_writes',
      )
      .all() as WriteRow[];
    for (const row of writes) {
      const key = JSON.stringify([row.thread_id, row.checkpoint_ns, row.checkpoint_id]);
      const bucket = (this.writes[key] ??= {});
      bucket[row.write_key] = [row.task_id, row.channel, new Uint8Array(row.value)];
    }
  }

  override async put(
    config: PutConfig,
    checkpoint: PutCheckpoint,
    metadata: PutMetadata,
  ): Promise<PutConfig> {
    const saved = await super.put(config, checkpoint, metadata);
    const threadId = saved.configurable?.thread_id;
    const namespace = saved.configurable?.checkpoint_ns ?? '';
    const checkpointId = saved.configurable?.checkpoint_id;
    if (typeof threadId !== 'string' || typeof checkpointId !== 'string') return saved;
    const entry = this.storage[threadId]?.[namespace]?.[checkpointId];
    if (entry === undefined) return saved;
    this.sqlite
      .prepare(
        `INSERT OR REPLACE INTO langgraph_checkpoints
         (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        threadId,
        namespace,
        checkpointId,
        config.configurable?.checkpoint_id ?? null,
        Buffer.from(entry[0]),
        Buffer.from(entry[1]),
        new Date().toISOString(),
      );
    return saved;
  }

  override async putWrites(config: PutConfig, writes: PutWrites, taskId: string): Promise<void> {
    await super.putWrites(config, writes, taskId);
    const threadId = config.configurable?.thread_id;
    const checkpointId = config.configurable?.checkpoint_id;
    const namespace = config.configurable?.checkpoint_ns ?? '';
    if (typeof threadId !== 'string' || typeof checkpointId !== 'string') return;
    const bucket = this.writes[JSON.stringify([threadId, namespace, checkpointId])] ?? {};
    const statement = this.sqlite.prepare(
      `INSERT OR REPLACE INTO langgraph_writes
       (thread_id, checkpoint_ns, checkpoint_id, write_key, task_id, channel, value)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const [writeKey, entry] of Object.entries(bucket)) {
      statement.run(
        threadId,
        namespace,
        checkpointId,
        writeKey,
        entry[0],
        entry[1],
        Buffer.from(entry[2]),
      );
    }
  }

  override async deleteThread(threadId: string): Promise<void> {
    await super.deleteThread(threadId);
    this.sqlite.prepare('DELETE FROM langgraph_checkpoints WHERE thread_id = ?').run(threadId);
    this.sqlite.prepare('DELETE FROM langgraph_writes WHERE thread_id = ?').run(threadId);
  }
}

/**
 * 创建 SQLite 持久化 checkpointer（要求迁移 v9 已执行）。
 * @param sqlite better-sqlite3 连接（与 ReviewStore 共用）
 */
export function createSqliteCheckpointer(sqlite: Database.Database): SqliteCheckpointSaver {
  return new SqliteCheckpointSaver(sqlite);
}
