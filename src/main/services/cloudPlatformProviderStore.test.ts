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
vi.mock('../utils/sqlcipherKey', () => ({
  deriveSqlcipherKey: () => Buffer.alloc(32, 1),
}));

describe('CloudPlatformProviderStore', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-test-'));
    const Database = (await import('better-sqlite3-multiple-ciphers')).default;
    dbInstance = new Database(path.join(tmpDir, 'test.db'));
    dbInstance.pragma(`cipher='sqlcipher'`);
    dbInstance.pragma(`key="x'${'00'.repeat(32)}'"`);
    vi.resetModules();
  });

  afterEach(() => {
    dbInstance.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('save then load returns same record', async () => {
    const { CloudPlatformProviderStore } = await import('./cloudPlatformProviderStore');
    const store = new CloudPlatformProviderStore(dbInstance);
    const record = { baseUrl: 'https://a/v1', apiKey: 'sk', lastSyncedAt: 1000 };
    await store.save(record);
    const loaded = await store.load();
    expect(loaded).toEqual(record);
  });

  test('load returns null when empty', async () => {
    const { CloudPlatformProviderStore } = await import('./cloudPlatformProviderStore');
    const store = new CloudPlatformProviderStore(dbInstance);
    expect(await store.load()).toBeNull();
  });

  test('clear removes record', async () => {
    const { CloudPlatformProviderStore } = await import('./cloudPlatformProviderStore');
    const store = new CloudPlatformProviderStore(dbInstance);
    await store.save({ baseUrl: 'a', apiKey: 'b', lastSyncedAt: 1 });
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  test('save preserves userOverride field', async () => {
    const { CloudPlatformProviderStore } = await import('./cloudPlatformProviderStore');
    const store = new CloudPlatformProviderStore(dbInstance);
    const record = {
      baseUrl: 'https://cloud/v1', apiKey: 'cloud-key', lastSyncedAt: 100,
      userOverride: { baseUrl: 'https://override/v1' },
    };
    await store.save(record);
    const loaded = await store.load();
    expect(loaded?.userOverride?.baseUrl).toBe('https://override/v1');
  });

  test('save overwrites previous record', async () => {
    const { CloudPlatformProviderStore } = await import('./cloudPlatformProviderStore');
    const store = new CloudPlatformProviderStore(dbInstance);
    await store.save({ baseUrl: 'a', apiKey: '1', lastSyncedAt: 1 });
    await store.save({ baseUrl: 'b', apiKey: '2', lastSyncedAt: 2 });
    const loaded = await store.load();
    expect(loaded?.baseUrl).toBe('b');
    expect(loaded?.apiKey).toBe('2');
  });
});
