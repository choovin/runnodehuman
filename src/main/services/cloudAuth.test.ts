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

vi.mock('electron', () => ({
  BrowserWindow: { getAllWebContents: () => [{ send: vi.fn() }] },
  app: { getPath: () => '/tmp/test', getName: () => 'Test' },
}));
vi.mock('../utils/sqlcipherKey', () => ({
  deriveSqlcipherKey: () => Buffer.alloc(32, 1),
}));
vi.mock('../utils/cloudApiBaseUrl', () => ({
  getCloudApiBaseUrl: () => 'https://test.example.com',
}));

describe('CloudAuthService', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wesight-test-'));
    const Database = (await import('better-sqlite3-multiple-ciphers')).default;
    dbInstance = new Database(path.join(tmpDir, 'test.db'));
    dbInstance.pragma(`cipher='sqlcipher'`);
    dbInstance.pragma(`key="x'${'00'.repeat(32)}'"`);
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER);
      CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    mockFetch = vi.fn();
    (globalThis as any).fetch = mockFetch;
    broadcaster = new EventEmitter();
    vi.resetModules();
  });

  afterEach(() => {
    dbInstance.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loginWithPassword', () => {
    test('saves tokens on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            userId: 1,
            accessToken: 'at-1',
            refreshToken: 'rt-1',
            expiresTime: Date.now() + 7200 * 1000,
          },
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: { id: 1, nickname: 'u', vip: { vipName: 'Plus' }, coin: 100 },
        }),
      });
      const { CloudAuthService } = await import('./cloudAuth');
      const svc = new CloudAuthService(dbInstance, broadcaster);
      const result = await svc.loginWithPassword('13800138000', 'pwd');
      expect(result.success).toBe(true);
      expect(result.userInfo?.username).toBe('u');
      expect(result.userInfo?.subscriptionPlan).toBe('Plus');
    });

    test('returns error on business failure', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 401, message: 'bad password' }),
      });
      const { CloudAuthService } = await import('./cloudAuth');
      const svc = new CloudAuthService(dbInstance, broadcaster);
      const result = await svc.loginWithPassword('13800138000', 'wrong');
      expect(result.success).toBe(false);
      expect(result.error).toBe('bad password');
    });
  });

  describe('refreshAccessToken', () => {
    test('rotates refresh token when server returns new one', async () => {
      const { CloudAuthTokenStore } = await import('./cloudAuthTokenStore');
      const store = new CloudAuthTokenStore(dbInstance);
      await store.save({ accessToken: 'old-at', refreshToken: 'old-rt', expiresAt: Date.now() + 1000 });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: { accessToken: 'new-at', refreshToken: 'new-rt', expiresTime: Date.now() + 7200 * 1000 },
        }),
      });

      const { CloudAuthService } = await import('./cloudAuth');
      const svc = new CloudAuthService(dbInstance, broadcaster);
      const ok = await svc.refreshAccessToken();
      expect(ok).toBe(true);
      const loaded = await store.load();
      expect(loaded?.accessToken).toBe('new-at');
      expect(loaded?.refreshToken).toBe('new-rt');
    });

    test('keeps old refreshToken when server does not return new', async () => {
      const { CloudAuthTokenStore } = await import('./cloudAuthTokenStore');
      const store = new CloudAuthTokenStore(dbInstance);
      await store.save({ accessToken: 'old-at', refreshToken: 'old-rt', expiresAt: Date.now() + 1000 });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, data: { accessToken: 'new-at', expiresTime: Date.now() + 7200 * 1000 } }),
      });

      const { CloudAuthService } = await import('./cloudAuth');
      const svc = new CloudAuthService(dbInstance, broadcaster);
      const ok = await svc.refreshAccessToken();
      expect(ok).toBe(true);
      const loaded = await store.load();
      expect(loaded?.refreshToken).toBe('old-rt');
    });

    test('clears tokens and broadcasts on failure', async () => {
      const { CloudAuthTokenStore } = await import('./cloudAuthTokenStore');
      const store = new CloudAuthTokenStore(dbInstance);
      await store.save({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000 });

      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({}),
      });

      const { CloudAuthService } = await import('./cloudAuth');
      const svc = new CloudAuthService(dbInstance, broadcaster);
      const broadcastSpy = vi.fn();
      broadcaster.on('cloud:auth:logged-out', broadcastSpy);
      const ok = await svc.refreshAccessToken();
      expect(ok).toBe(false);
      expect(await store.load()).toBeNull();
      expect(broadcastSpy).toHaveBeenCalled();
    });

    test('coalesces concurrent refresh calls into one fetch', async () => {
      const { CloudAuthTokenStore } = await import('./cloudAuthTokenStore');
      const store = new CloudAuthTokenStore(dbInstance);
      await store.save({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000 });

      let resolveFn: (v: any) => void;
      mockFetch.mockReturnValueOnce(new Promise((r) => { resolveFn = r; }));

      const { CloudAuthService } = await import('./cloudAuth');
      const svc = new CloudAuthService(dbInstance, broadcaster);
      const p1 = svc.refreshAccessToken();
      const p2 = svc.refreshAccessToken();
      const p3 = svc.refreshAccessToken();

      resolveFn!({
        ok: true,
        json: async () => ({ code: 0, data: { accessToken: 'new', expiresTime: Date.now() + 7200 * 1000 } }),
      });

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(r3).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('getValidToken', () => {
    test('returns null when no tokens stored', async () => {
      const { CloudAuthService } = await import('./cloudAuth');
      const svc = new CloudAuthService(dbInstance, broadcaster);
      expect(await svc.getValidToken()).toBeNull();
    });

    test('returns tokens when not expiring soon', async () => {
      const { CloudAuthTokenStore } = await import('./cloudAuthTokenStore');
      const store = new CloudAuthTokenStore(dbInstance);
      await store.save({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 60 * 60 * 1000 });

      const { CloudAuthService } = await import('./cloudAuth');
      const svc = new CloudAuthService(dbInstance, broadcaster);
      const t = await svc.getValidToken();
      expect(t?.accessToken).toBe('a');
    });

    test('refreshes proactively when within buffer window', async () => {
      const { CloudAuthTokenStore } = await import('./cloudAuthTokenStore');
      const store = new CloudAuthTokenStore(dbInstance);
      await store.save({ accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 60 * 1000 });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, data: { accessToken: 'new', expiresTime: Date.now() + 7200 * 1000 } }),
      });

      const { CloudAuthService } = await import('./cloudAuth');
      const svc = new CloudAuthService(dbInstance, broadcaster);
      const t = await svc.getValidToken();
      expect(t?.accessToken).toBe('new');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStatus with coin and subscriptionPlan', () => {
    test('returns coin and subscriptionPlan from user', async () => {
      dbInstance.prepare("INSERT INTO kv (key, value) VALUES (?, ?)")
        .run('cloud_user_info', JSON.stringify({
          id: 1, username: 'u', coin: 500, subscriptionPlan: 'Plus',
        }));
      const { CloudAuthService } = await import('./cloudAuth');
      const svc = new CloudAuthService(dbInstance, broadcaster);
      const status = await svc.getStatus();
      expect(status.coin).toBe(500);
      expect(status.subscriptionPlan).toBe('Plus');
    });

    test('returns coin=0 and empty plan when user not set', async () => {
      const { CloudAuthService } = await import('./cloudAuth');
      const svc = new CloudAuthService(dbInstance, broadcaster);
      const status = await svc.getStatus();
      expect(status.coin).toBe(0);
      expect(status.subscriptionPlan).toBe('');
    });

    test('handles partial user info (coin but no plan)', async () => {
      dbInstance.prepare("INSERT INTO kv (key, value) VALUES (?, ?)")
        .run('cloud_user_info', JSON.stringify({ id: 1, username: 'u', coin: 100 }));
      const { CloudAuthService } = await import('./cloudAuth');
      const svc = new CloudAuthService(dbInstance, broadcaster);
      const status = await svc.getStatus();
      expect(status.coin).toBe(100);
      expect(status.subscriptionPlan).toBe('');
    });
  });

  describe('logout', () => {
    test('clears local tokens even if remote logout fails', async () => {
      const { CloudAuthTokenStore } = await import('./cloudAuthTokenStore');
      const store = new CloudAuthTokenStore(dbInstance);
      await store.save({ accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 1000 });

      mockFetch.mockRejectedValueOnce(new Error('network down'));

      const { CloudAuthService } = await import('./cloudAuth');
      const svc = new CloudAuthService(dbInstance, broadcaster);
      const r = await svc.logout();
      expect(r.success).toBe(true);
      expect(await store.load()).toBeNull();
    });
  });
});
