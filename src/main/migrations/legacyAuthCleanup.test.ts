import type Database from 'better-sqlite3-multiple-ciphers';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let dbInstance: Database.Database;
let tmpDir: string;

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test', getName: () => 'Test' },
}));
vi.mock('../../main/utils/sqlcipherKey', () => ({
  deriveSqlcipherKey: () => Buffer.alloc(32, 1),
}));

describe('legacyAuthCleanup', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-test-'));
    const Database = (await import('better-sqlite3-multiple-ciphers')).default;
    dbInstance = new Database(path.join(tmpDir, 'test.db'));
    dbInstance.pragma(`cipher='sqlcipher'`);
    dbInstance.pragma(`key="x'${'00'.repeat(32)}'"`);
    dbInstance.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    vi.resetModules();
  });

  afterEach(() => {
    dbInstance.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('removes auth_tokens and server_models_meta kvs', async () => {
    dbInstance.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('auth_tokens', '{"accessToken":"old"}');
    dbInstance.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('server_models_meta', '{"models":[]}');
    dbInstance.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('other_setting', 'keep-me');

    const { run } = await import('./legacyAuthCleanup');
    await run(dbInstance);

    const remaining = dbInstance.prepare('SELECT key FROM kv').all() as Array<{ key: string }>;
    const keys = remaining.map((r) => r.key);
    expect(keys).not.toContain('auth_tokens');
    expect(keys).not.toContain('server_models_meta');
    expect(keys).toContain('other_setting');
    expect(keys).toContain('urs_cleanup_at');
  });

  test('is idempotent (running twice does not throw)', async () => {
    const { run } = await import('./legacyAuthCleanup');
    await run(dbInstance);
    await expect(run(dbInstance)).resolves.not.toThrow();
  });
});
