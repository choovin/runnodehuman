import type Database from 'better-sqlite3-multiple-ciphers';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let dbInstance: Database.Database;
const tempDirs: string[] = [];

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/wesight-test', getName: () => 'WeSight Test' },
}));

vi.mock('../utils/sqlcipherKey', () => ({
  deriveSqlcipherKey: () => Buffer.alloc(32, 1),
}));

describe('CloudAuthTokenStore', () => {
  beforeEach(async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-cloud-auth-'));
    tempDirs.push(userDataDir);
    const dbPath = path.join(userDataDir, 'cloud.sqlite');
    const Database = (await import('better-sqlite3-multiple-ciphers')).default;
    dbInstance = new Database(dbPath);
    dbInstance.pragma(`cipher='sqlcipher'`);
    dbInstance.pragma(`key="x'${'00'.repeat(32)}'"`);
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    vi.resetModules();
  });

  afterEach(() => {
    dbInstance.close();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('save then load returns same tokens', async () => {
    const { CloudAuthTokenStore } = await import('./cloudAuthTokenStore');
    const store = new CloudAuthTokenStore(dbInstance);
    await store.save({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      expiresAt: Date.now() + 7200_000,
    });
    const loaded = await store.load();
    expect(loaded?.accessToken).toBe('at-1');
    expect(loaded?.refreshToken).toBe('rt-1');
    expect(loaded?.expiresAt).toBeGreaterThan(Date.now());
  });

  test('load returns null when empty', async () => {
    const { CloudAuthTokenStore } = await import('./cloudAuthTokenStore');
    const store = new CloudAuthTokenStore(dbInstance);
    const loaded = await store.load();
    expect(loaded).toBeNull();
  });

  test('clear removes tokens', async () => {
    const { CloudAuthTokenStore } = await import('./cloudAuthTokenStore');
    const store = new CloudAuthTokenStore(dbInstance);
    await store.save({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000 });
    await store.clear();
    const loaded = await store.load();
    expect(loaded).toBeNull();
  });

  test('save overwrites previous tokens', async () => {
    const { CloudAuthTokenStore } = await import('./cloudAuthTokenStore');
    const store = new CloudAuthTokenStore(dbInstance);
    await store.save({ accessToken: 'a1', refreshToken: 'r1', expiresAt: Date.now() + 1000 });
    await store.save({ accessToken: 'a2', refreshToken: 'r2', expiresAt: Date.now() + 2000 });
    const loaded = await store.load();
    expect(loaded?.accessToken).toBe('a2');
    expect(loaded?.refreshToken).toBe('r2');
  });
});
