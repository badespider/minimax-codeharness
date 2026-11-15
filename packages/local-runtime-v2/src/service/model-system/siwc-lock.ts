import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

interface LockDatabase { exec(sql: string): void; close(): void }
type LockDatabaseConstructor = new (path: string) => LockDatabase;

// SQLite uses OS-backed file locks. Holding a write transaction owns the lock
// until rollback or process death, with no stale lockfile deletion. The
// database contains no user data. Its path must never be removed while the app
// is running. On Node versions without built-in SQLite, fail closed.
export async function withChatGptProfileLock<T>(path: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  let DatabaseSync: LockDatabaseConstructor;
  try { ({ DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: LockDatabaseConstructor }); }
  catch { throw new Error('ChatGPT profile locking requires a Node version with SQLite.'); }
  const database = new DatabaseSync(path);
  let acquired = false;
  try {
    database.exec('PRAGMA busy_timeout=0');
    const deadline = Date.now() + 10_000;
    for (;;) {
      signal?.throwIfAborted();
      try { database.exec('BEGIN IMMEDIATE'); acquired = true; break; }
      catch (error) {
        const code = (error as { errcode?: number }).errcode;
        // Only explicit SQLITE_BUSY/SQLITE_LOCKED are retried. Errors such as
        // corrupt files, missing permissions, and unsupported builds fail closed.
        if (code !== 5 && code !== 6) throw new Error('ChatGPT profile lock is unavailable.');
        if (Date.now() >= deadline) throw new Error('ChatGPT profile lock is busy.');
        await delay(100, undefined, { signal });
      }
    }
    signal?.throwIfAborted();
    return await action();
  } finally {
    try { if (acquired) database.exec('ROLLBACK'); } finally { database.close(); }
  }
}
