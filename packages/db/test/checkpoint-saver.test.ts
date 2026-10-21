import Database from 'better-sqlite3';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { describe, expect, it } from 'vitest';
import { ReviewStore, SqliteCheckpointSaver } from '../src/index.js';

describe('SqliteCheckpointSaver', () => {
  it('persists checkpoints/writes and reloads them for the same thread', async () => {
    const sqlite = new Database(':memory:');
    // ReviewStore 负责建表与迁移；saver 与它共用同一连接
    new ReviewStore(sqlite);
    const saver = new SqliteCheckpointSaver(sqlite);
    const checkpoint: Checkpoint = {
      v: 4,
      id: 'checkpoint-1',
      ts: new Date().toISOString(),
      channel_values: { context: { files: [] } },
      channel_versions: { context: 1 },
      versions_seen: {},
    };
    const metadata: CheckpointMetadata = { source: 'input', step: 0, parents: {} };
    const config = await saver.put(
      { configurable: { thread_id: 'thread-1' } },
      checkpoint,
      metadata,
    );
    expect(config.configurable?.checkpoint_id).toBe('checkpoint-1');
    await saver.putWrites(config, [['context', { files: [] }]], 'task-1');

    const reloaded = new SqliteCheckpointSaver(sqlite);
    const tuple = await reloaded.getTuple({ configurable: { thread_id: 'thread-1' } });
    expect(tuple?.checkpoint.channel_values).toEqual({ context: { files: [] } });
    expect(tuple?.pendingWrites).toHaveLength(1);

    await reloaded.deleteThread('thread-1');
    expect(await reloaded.getTuple({ configurable: { thread_id: 'thread-1' } })).toBeUndefined();
    sqlite.close();
  });

  it('prunes expired checkpoints but keeps running jobs', async () => {
    const sqlite = new Database(':memory:');
    const store = new ReviewStore(sqlite);
    const saver = new SqliteCheckpointSaver(sqlite);
    const checkpoint: Checkpoint = {
      v: 4,
      id: 'checkpoint-old',
      ts: new Date().toISOString(),
      channel_values: { context: {} },
      channel_versions: { context: 1 },
      versions_seen: {},
    };
    const metadata: CheckpointMetadata = { source: 'input', step: 0, parents: {} };
    await saver.put({ configurable: { thread_id: 'finished' } }, checkpoint, metadata);
    await saver.put({ configurable: { thread_id: 'running' } }, checkpoint, metadata);
    store.saveReviewJob('running', { repoPath: 'D:/repo', mode: 'fast' });

    expect(store.pruneLanggraphCheckpoints(new Date(Date.now() + 1_000).toISOString())).toBe(1);
    expect(await saver.getTuple({ configurable: { thread_id: 'finished' } })).toBeUndefined();
    expect(await saver.getTuple({ configurable: { thread_id: 'running' } })).toBeDefined();
    sqlite.close();
  });
});
