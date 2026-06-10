import type Database from 'better-sqlite3-multiple-ciphers';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach,beforeEach, describe, expect, test, vi } from 'vitest';

let dbInstance: Database.Database;
let tmpDir: string;
let mockFetch: ReturnType<typeof vi.fn>;

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test', getName: () => 'Test' },
}));
vi.mock('../utils/sqlcipherKey', () => ({
  deriveSqlcipherKey: () => Buffer.alloc(32, 1),
}));
vi.mock('../utils/cloudApiBaseUrl', () => ({
  getCloudApiBaseUrl: () => 'https://test.example.com',
}));

describe('CloudUserDeviceService', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-test-'));
    const Database = (await import('better-sqlite3-multiple-ciphers')).default;
    dbInstance = new Database(path.join(tmpDir, 'test.db'));
    dbInstance.pragma(`cipher='sqlcipher'`);
    dbInstance.pragma(`key="x'${'00'.repeat(32)}'"`);
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
    `);
    mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0 }) });
    (globalThis as any).fetch = mockFetch;
    vi.resetModules();
  });

  afterEach(() => {
    dbInstance.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('init generates a uuid deviceId when none exists', async () => {
    const { CloudUserDeviceService } = await import('./cloudUserDeviceService');
    const svc = new CloudUserDeviceService(dbInstance);
    await svc.init();
    const id = await svc.getDeviceId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  test('init reuses existing deviceId', async () => {
    const { CloudUserDeviceStore } = await import('./cloudUserDeviceStore');
    const store = new CloudUserDeviceStore(dbInstance);
    await store.save({ deviceId: 'existing-uuid-1234', createdAt: Date.now() });
    const { CloudUserDeviceService } = await import('./cloudUserDeviceService');
    const svc = new CloudUserDeviceService(dbInstance);
    await svc.init();
    expect(await svc.getDeviceId()).toBe('existing-uuid-1234');
  });

  test('afterLogin calls register endpoint', async () => {
    const { CloudUserDeviceService } = await import('./cloudUserDeviceService');
    const svc = new CloudUserDeviceService(dbInstance);
    await svc.init();
    await svc.afterLogin();
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/app-api/claw/user/device/register'),
      expect.objectContaining({ method: 'POST' })
    );
  });

  test('heartbeat short-circuits when no token', async () => {
    const { CloudUserDeviceService } = await import('./cloudUserDeviceService');
    const svc = new CloudUserDeviceService(dbInstance);
    await svc.init();
    await svc.heartbeat();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('clear removes deviceId and stops interval', async () => {
    const { CloudUserDeviceService } = await import('./cloudUserDeviceService');
    const svc = new CloudUserDeviceService(dbInstance);
    await svc.init();
    await svc.clear();
    expect(await svc.getDeviceId()).toBeNull();
  });
});
