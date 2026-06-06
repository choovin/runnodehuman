import type Database from 'better-sqlite3-multiple-ciphers';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach,beforeEach, describe, expect, test, vi } from 'vitest';

let dbInstance: Database.Database;
let tmpDir: string;
let mockFetch: ReturnType<typeof vi.fn>;
let broadcaster: EventEmitter;

const mockCloudAuth = {
  getCloudApiBaseUrl: vi.fn().mockReturnValue('https://test.example.com'),
  fetchMemberAuthorized: vi.fn(),
};

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test', getName: () => 'Test' },
}));
vi.mock('../utils/sqlcipherKey', () => ({
  deriveSqlcipherKey: () => Buffer.alloc(32, 1),
}));
vi.mock('../utils/cloudApiBaseUrl', () => ({
  getCloudApiBaseUrl: () => 'https://test.example.com',
}));
vi.mock('./cloudAuth', () => ({
  CloudAuthService: vi.fn(),
}));
vi.mock('../../shared/cloudAuth/constants', () => ({
  CloudAuthChannel: { LoginSuccessEvent: 'cloud:auth:login-success' },
}));

describe('CloudPlatformProviderService', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-test-'));
    const Database = (await import('better-sqlite3-multiple-ciphers')).default;
    dbInstance = new Database(path.join(tmpDir, 'test.db'));
    dbInstance.pragma(`cipher='sqlcipher'`);
    dbInstance.pragma(`key="x'${'00'.repeat(32)}'"`);
    mockFetch = vi.fn();
    (globalThis as any).fetch = mockFetch;
    broadcaster = new EventEmitter();
    mockCloudAuth.fetchMemberAuthorized = vi.fn();
    vi.resetModules();
  });

  afterEach(() => {
    dbInstance.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('sync', () => {
    test('saves record on success and broadcasts updated', async () => {
      mockCloudAuth.fetchMemberAuthorized.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: { baseUrl: 'https://api.example.com', apiKey: 'sk-abc' },
        }),
      });
      const { CloudPlatformProviderService } = await import('./cloudPlatformProviderService');
      const svc = new CloudPlatformProviderService(dbInstance, mockCloudAuth as any, broadcaster);
      const broadcastSpy = vi.fn();
      broadcaster.on('cloud:platform-provider:updated', broadcastSpy);
      const r = await svc.sync();
      expect(r.success).toBe(true);
      const loaded = await svc.get();
      expect(loaded?.baseUrl).toBe('https://api.example.com/v1');
      expect(loaded?.apiKey).toBe('sk-abc');
      expect(loaded?.lastSyncedAt).toBeGreaterThan(Date.now() - 5000);
      expect(broadcastSpy).toHaveBeenCalledOnce();
    });

    test('returns error and broadcasts failed on 5xx', async () => {
      mockCloudAuth.fetchMemberAuthorized.mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({}),
      });
      const { CloudPlatformProviderService } = await import('./cloudPlatformProviderService');
      const svc = new CloudPlatformProviderService(dbInstance, mockCloudAuth as any, broadcaster);
      const failedSpy = vi.fn();
      broadcaster.on('cloud:platform-provider:sync-failed', failedSpy);
      const r = await svc.sync();
      expect(r.success).toBe(false);
      expect(failedSpy).toHaveBeenCalledWith({ error: 'HTTP 503' });
    });

    test('preserves existing record on sync failure', async () => {
      const { CloudPlatformProviderStore } = await import('./cloudPlatformProviderStore');
      const store = new CloudPlatformProviderStore(dbInstance);
      await store.save({ baseUrl: 'https://old/v1', apiKey: 'old', lastSyncedAt: 1 });

      mockCloudAuth.fetchMemberAuthorized.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({}),
      });
      const { CloudPlatformProviderService } = await import('./cloudPlatformProviderService');
      const svc = new CloudPlatformProviderService(dbInstance, mockCloudAuth as any, broadcaster);
      await svc.sync();
      const loaded = await svc.get();
      expect(loaded?.baseUrl).toBe('https://old/v1');
      expect(loaded?.apiKey).toBe('old');
    });

    test('coalesces concurrent sync calls into one fetch', async () => {
      let resolveFn: (v: any) => void;
      mockCloudAuth.fetchMemberAuthorized.mockReturnValueOnce(new Promise((r) => { resolveFn = r; }));

      const { CloudPlatformProviderService } = await import('./cloudPlatformProviderService');
      const svc = new CloudPlatformProviderService(dbInstance, mockCloudAuth as any, broadcaster);
      const p1 = svc.sync();
      const p2 = svc.sync();
      const p3 = svc.sync();

      resolveFn!({
        ok: true,
        json: async () => ({ code: 0, data: { baseUrl: 'https://a', apiKey: 'k' } }),
      });
      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
      expect(r3.success).toBe(true);
      expect(mockCloudAuth.fetchMemberAuthorized).toHaveBeenCalledTimes(1);
    });
  });

  describe('ensureSynced', () => {
    test('skips when lastSyncedAt < 24h ago', async () => {
      const { CloudPlatformProviderStore } = await import('./cloudPlatformProviderStore');
      const store = new CloudPlatformProviderStore(dbInstance);
      await store.save({
        baseUrl: 'https://fresh/v1', apiKey: 'fresh',
        lastSyncedAt: Date.now() - 60 * 60 * 1000,
      });
      const { CloudPlatformProviderService } = await import('./cloudPlatformProviderService');
      const svc = new CloudPlatformProviderService(dbInstance, mockCloudAuth as any, broadcaster);
      await svc.ensureSynced();
      expect(mockCloudAuth.fetchMemberAuthorized).not.toHaveBeenCalled();
    });

    test('triggers sync when lastSyncedAt > 24h ago', async () => {
      const { CloudPlatformProviderStore } = await import('./cloudPlatformProviderStore');
      const store = new CloudPlatformProviderStore(dbInstance);
      await store.save({
        baseUrl: 'https://old/v1', apiKey: 'old',
        lastSyncedAt: Date.now() - 25 * 60 * 60 * 1000,
      });
      mockCloudAuth.fetchMemberAuthorized.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, data: { baseUrl: 'https://new', apiKey: 'new' } }),
      });
      const { CloudPlatformProviderService } = await import('./cloudPlatformProviderService');
      const svc = new CloudPlatformProviderService(dbInstance, mockCloudAuth as any, broadcaster);
      await svc.ensureSynced();
      expect(mockCloudAuth.fetchMemberAuthorized).toHaveBeenCalledTimes(1);
    });

    test('skips sync when userOverride is set', async () => {
      const { CloudPlatformProviderStore } = await import('./cloudPlatformProviderStore');
      const store = new CloudPlatformProviderStore(dbInstance);
      await store.save({
        baseUrl: 'https://old/v1', apiKey: 'old',
        lastSyncedAt: Date.now() - 25 * 60 * 60 * 1000,
        userOverride: { baseUrl: 'https://override/v1' },
      });
      const { CloudPlatformProviderService } = await import('./cloudPlatformProviderService');
      const svc = new CloudPlatformProviderService(dbInstance, mockCloudAuth as any, broadcaster);
      await svc.ensureSynced();
      expect(mockCloudAuth.fetchMemberAuthorized).not.toHaveBeenCalled();
    });

    test('triggers sync when no record exists', async () => {
      mockCloudAuth.fetchMemberAuthorized.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, data: { baseUrl: 'https://a', apiKey: 'k' } }),
      });
      const { CloudPlatformProviderService } = await import('./cloudPlatformProviderService');
      const svc = new CloudPlatformProviderService(dbInstance, mockCloudAuth as any, broadcaster);
      await svc.ensureSynced();
      expect(mockCloudAuth.fetchMemberAuthorized).toHaveBeenCalledTimes(1);
    });
  });

  describe('setOverride', () => {
    test('rejects invalid baseUrl format', async () => {
      const { CloudPlatformProviderStore } = await import('./cloudPlatformProviderStore');
      const store = new CloudPlatformProviderStore(dbInstance);
      await store.save({ baseUrl: 'https://a/v1', apiKey: 'k', lastSyncedAt: 1 });
      const { CloudPlatformProviderService } = await import('./cloudPlatformProviderService');
      const svc = new CloudPlatformProviderService(dbInstance, mockCloudAuth as any, broadcaster);
      const r = await svc.setOverride({ baseUrl: 'ftp://bad' });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/http/);
    });

    test('rejects when no synced record exists', async () => {
      const { CloudPlatformProviderService } = await import('./cloudPlatformProviderService');
      const svc = new CloudPlatformProviderService(dbInstance, mockCloudAuth as any, broadcaster);
      const r = await svc.setOverride({ baseUrl: 'https://x' });
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/no synced/);
    });

    test('saves override and broadcasts updated', async () => {
      const { CloudPlatformProviderStore } = await import('./cloudPlatformProviderStore');
      const store = new CloudPlatformProviderStore(dbInstance);
      await store.save({ baseUrl: 'https://cloud/v1', apiKey: 'cloud-key', lastSyncedAt: 1 });
      const { CloudPlatformProviderService } = await import('./cloudPlatformProviderService');
      const svc = new CloudPlatformProviderService(dbInstance, mockCloudAuth as any, broadcaster);
      const broadcastSpy = vi.fn();
      broadcaster.on('cloud:platform-provider:updated', broadcastSpy);
      const r = await svc.setOverride({ baseUrl: 'https://override/v1' });
      expect(r.success).toBe(true);
      const loaded = await svc.get();
      expect(loaded?.userOverride?.baseUrl).toBe('https://override/v1');
      expect(broadcastSpy).toHaveBeenCalled();
    });
  });

  describe('resetDefault', () => {
    test('clears override and triggers re-sync', async () => {
      const { CloudPlatformProviderStore } = await import('./cloudPlatformProviderStore');
      const store = new CloudPlatformProviderStore(dbInstance);
      await store.save({
        baseUrl: 'https://cloud/v1', apiKey: 'cloud-key', lastSyncedAt: 1,
        userOverride: { baseUrl: 'https://override/v1' },
      });
      mockCloudAuth.fetchMemberAuthorized.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, data: { baseUrl: 'https://new', apiKey: 'new-key' } }),
      });
      const { CloudPlatformProviderService } = await import('./cloudPlatformProviderService');
      const svc = new CloudPlatformProviderService(dbInstance, mockCloudAuth as any, broadcaster);
      const r = await svc.resetDefault();
      expect(r.success).toBe(true);
      const loaded = await svc.get();
      expect(loaded?.userOverride).toBeUndefined();
      expect(loaded?.apiKey).toBe('new-key');
      expect(mockCloudAuth.fetchMemberAuthorized).toHaveBeenCalledTimes(1);
    });
  });
});
