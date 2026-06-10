import type Database from 'better-sqlite3-multiple-ciphers';

const CLEANUP_KEY = 'urs_cleanup_at';
const LEGACY_KEYS = ['auth_tokens', 'server_models_meta'];

export async function run(db: Database.Database): Promise<void> {
  // Idempotent: skip if already done
  const existing = db.prepare('SELECT 1 FROM kv WHERE key = ?').get(CLEANUP_KEY);
  if (existing) return;

  // Delete legacy URS kvs (idempotent on each — DELETE is a no-op if missing)
  for (const key of LEGACY_KEYS) {
    db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  // Mark complete
  db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
    CLEANUP_KEY,
    new Date().toISOString()
  );

  console.log('[Migration] URS legacy auth state cleared');
}
