# WeSight × RunNode Platform Provider Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync RunNode's `new-api/config` (baseUrl + apiKey) into WeSight's local SQLCipher, surface coin/subscriptionPlan in UI, allow user override with explicit reset.

**Architecture:** Direct IPC. Single dedicated SQLCipher-backed kv table `cloud_platform_provider` (single-row + JSON value). Service pulls from RunNode on login + 24h idempotent on startup, broadcasts updates. Renderer Redux slice holds the record; Settings section has override controls.

**Tech Stack:**
- SQLCipher via existing `better-sqlite3-multiple-ciphers` (from A)
- Direct `ipcMain.handle` pattern (matches A)
- Vitest for tests, React Testing Library for components
- New IPC namespace: `cloud:platform-provider:*`

**Spec:** `docs/superpowers/specs/2026-06-06-wesight-runnode-platform-provider-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/shared/cloudPlatformProvider/types.ts` | Create | `CloudPlatformProviderRecord`, `isOverridden`, `effective` helpers, payload types |
| `src/shared/cloudPlatformProvider/constants.ts` | Create | IPC channel names, sync threshold (24h), new-api/config path |
| `src/shared/cloudPlatformProvider/parsers.ts` | Create | `parseNewApiConfig`, `ensureOpenAiCompatibleBaseUrlV1` |
| `src/shared/cloudPlatformProvider/parsers.test.ts` | Create | TDD tests for parsers |
| `src/main/services/cloudPlatformProviderStore.ts` | Create | SQLCipher kv wrapper for `cloud_platform_provider` table |
| `src/main/services/cloudPlatformProviderStore.test.ts` | Create | save/load/clear roundtrip |
| `src/main/services/cloudPlatformProviderService.ts` | Create | sync / ensureSynced / get / setOverride / resetDefault + listener wiring |
| `src/main/services/cloudPlatformProviderService.test.ts` | Create | All sync paths + override + 24h + concurrent |
| `src/main/services/cloudAuth.ts` | Modify | Extend `getStatus()` to return `coin` and `subscriptionPlan` |
| `src/main/services/cloudAuth.test.ts` | Modify | Add test for new getStatus fields |
| `src/main/ipcHandlers/cloudAuth.ts` | Modify | Register 4 new IPC handlers + 2 event broadcasts |
| `src/main/main.ts` | Modify | Init service + register handlers (insert in startup sequence after cloud auth) |
| `src/main/preload.ts` | Modify | Expose `cloudPlatformProvider` namespace |
| `src/renderer/types/electron.d.ts` | Modify | Type declarations for new namespace |
| `src/renderer/store/slices/cloudAuthSlice.ts` | Modify | Add `platformProvider`/`isOverridden`/`lastSyncedAt` fields + reducer |
| `src/renderer/services/cloudAuth.ts` | Modify | Call `cloudPlatformProviderService.init()` |
| `src/renderer/services/cloudPlatformProvider.ts` | Create | Renderer-side service wrapping new IPC |
| `src/renderer/components/Settings/CloudPlatformProviderSection.tsx` | Create | Settings UI: baseUrl/apiKey override + reset + sync + lastSyncedAt |
| `src/renderer/components/Settings/CloudPlatformProviderSection.test.tsx` | Create | Override flow / reset / sync button |
| `src/renderer/components/Sidebar.tsx` | Modify | Add coin 余额 + 套餐徽章 to user menu |
| `src/renderer/components/Sidebar.test.tsx` | Modify | Test new badges render |
| `src/renderer/components/Settings.tsx` | Modify | Mount `<CloudPlatformProviderSection />` |
| `src/renderer/services/i18n.ts` | Modify | Add ~20 new keys in zh + en |
| `docs/superpowers/specs/2026-06-06-wesight-runnode-platform-provider-design.md` | Modify | Mark spec as Implemented |
| `AGENTS.md` | Modify | Add B to Authentication section |

---

### Task 1: Shared types + constants + parsers (TDD)

**Files:**
- Create: `src/shared/cloudPlatformProvider/types.ts`
- Create: `src/shared/cloudPlatformProvider/constants.ts`
- Create: `src/shared/cloudPlatformProvider/parsers.ts`
- Create: `src/shared/cloudPlatformProvider/parsers.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/shared/cloudPlatformProvider/parsers.test.ts`:
```ts
import { describe, test, expect } from 'vitest';
import {
  parseNewApiConfig,
  ensureOpenAiCompatibleBaseUrlV1,
} from './parsers';

describe('ensureOpenAiCompatibleBaseUrlV1', () => {
  test('appends /v1 when missing', () => {
    expect(ensureOpenAiCompatibleBaseUrlV1('https://api.example.com')).toBe('https://api.example.com/v1');
  });
  test('strips trailing slashes before adding /v1', () => {
    expect(ensureOpenAiCompatibleBaseUrlV1('https://api.example.com/')).toBe('https://api.example.com/v1');
    expect(ensureOpenAiCompatibleBaseUrlV1('https://api.example.com///')).toBe('https://api.example.com/v1');
  });
  test('does not double-append when already ends in /v1', () => {
    expect(ensureOpenAiCompatibleBaseUrlV1('https://api.example.com/v1')).toBe('https://api.example.com/v1');
    expect(ensureOpenAiCompatibleBaseUrlV1('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
  });
  test('is case-insensitive on /V1 detection', () => {
    expect(ensureOpenAiCompatibleBaseUrlV1('https://api.example.com/V1')).toBe('https://api.example.com/V1');
  });
  test('returns empty string unchanged', () => {
    expect(ensureOpenAiCompatibleBaseUrlV1('')).toBe('');
  });
});

describe('parseNewApiConfig', () => {
  test('parses standard wrapped response with apiKey', () => {
    const raw = { code: 0, data: { baseUrl: 'https://api.example.com', apiKey: 'sk-abc' } };
    const r = parseNewApiConfig(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.baseUrl).toBe('https://api.example.com/v1');
      expect(r.value.apiKey).toBe('sk-abc');
    }
  });
  test('parses flat response (no data wrapper)', () => {
    const raw = { baseUrl: 'https://api.example.com', apiKey: 'sk-abc' };
    const r = parseNewApiConfig(raw);
    expect(r.ok).toBe(true);
  });
  test('falls back to platformAccessToken when apiKey missing', () => {
    const raw = { code: 0, data: { baseUrl: 'https://api.example.com', platformAccessToken: 'pat-xyz' } };
    const r = parseNewApiConfig(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.apiKey).toBe('pat-xyz');
  });
  test('handles code 200 (alternate success)', () => {
    const raw = { code: 200, data: { baseUrl: 'https://api.example.com', apiKey: 'sk' } };
    const r = parseNewApiConfig(raw);
    expect(r.ok).toBe(true);
  });
  test('rejects on missing baseUrl', () => {
    const raw = { code: 0, data: { apiKey: 'sk' } };
    const r = parseNewApiConfig(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/baseUrl/);
  });
  test('rejects on missing apiKey AND platformAccessToken', () => {
    const raw = { code: 0, data: { baseUrl: 'https://api.example.com' } };
    const r = parseNewApiConfig(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/apiKey|platformAccessToken/);
  });
  test('rejects on business error', () => {
    const raw = { code: 401, message: 'unauthorized' };
    const r = parseNewApiConfig(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unauthorized');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/cloudPlatformProvider/parsers.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create types.ts**

Create `src/shared/cloudPlatformProvider/types.ts`:
```ts
export interface CloudPlatformProviderRecord {
  baseUrl: string;
  apiKey: string;
  lastSyncedAt: number;
  userOverride?: {
    baseUrl?: string;
    apiKey?: string;
  };
}

export const isOverridden = (
  r: CloudPlatformProviderRecord | null | undefined
): boolean =>
  r?.userOverride != null
  && (r.userOverride.baseUrl != null || r.userOverride.apiKey != null);

export const effective = (r: CloudPlatformProviderRecord): { baseUrl: string; apiKey: string } => ({
  baseUrl: r.userOverride?.baseUrl ?? r.baseUrl,
  apiKey: r.userOverride?.apiKey ?? r.apiKey,
});

export type PlatformProviderUpdatedPayload = { record: CloudPlatformProviderRecord };
export type PlatformProviderSyncFailedPayload = { error: string };
```

- [ ] **Step 4: Create constants.ts**

Create `src/shared/cloudPlatformProvider/constants.ts`:
```ts
export const CloudPlatformProviderChannel = {
  Get: 'cloud:platform-provider:get',
  Sync: 'cloud:platform-provider:sync',
  SetOverride: 'cloud:platform-provider:set-override',
  ResetDefault: 'cloud:platform-provider:reset-default',
  UpdatedEvent: 'cloud:platform-provider:updated',
  SyncFailedEvent: 'cloud:platform-provider:sync-failed',
} as const;
export type CloudPlatformProviderChannel =
  typeof CloudPlatformProviderChannel[keyof typeof CloudPlatformProviderChannel];

/** 同步间隔阈值：超过此时间后启动 idempotent 检查会重新同步 */
export const PlatformProviderSyncThresholdMs = 24 * 60 * 60 * 1000;

/** new-api/config 端点路径 */
export const PlatformProviderConfigPath = '/app-api/member/new-api/config';
```

- [ ] **Step 5: Create parsers.ts**

Create `src/shared/cloudPlatformProvider/parsers.ts`:
```ts
import type { CloudPlatformProviderRecord } from './types';

export type ParserResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

function unwrapData(raw: unknown): Record<string, unknown> {
  if (raw == null || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  if (r.data != null && typeof r.data === 'object' && !Array.isArray(r.data)) {
    return r.data as Record<string, unknown>;
  }
  return r;
}

function isBusinessError(raw: unknown): string | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const code = r.code;
  if (code === 0 || code === 200 || code === undefined || code === null) return null;
  return (r.message as string) || `business error code ${code}`;
}

/** 规范化 baseUrl：若末尾不是 /v1 则自动追加；不重复加 */
export function ensureOpenAiCompatibleBaseUrlV1(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const noTrailingSlash = trimmed.replace(/\/+$/, '');
  if (/\/v1$/i.test(noTrailingSlash)) return noTrailingSlash;
  return `${noTrailingSlash}/v1`;
}

/** 解析 new-api/config 响应，权威字段 apiKey，platformAccessToken 兜底 */
export function parseNewApiConfig(
  raw: unknown
): ParserResult<Pick<CloudPlatformProviderRecord, 'baseUrl' | 'apiKey'>> {
  const err = isBusinessError(raw);
  if (err) return { ok: false, error: err };

  const data = unwrapData(raw);
  const baseUrlRaw = (typeof data.baseUrl === 'string' ? data.baseUrl.trim() : '')
    || (typeof data.apiUrl === 'string' ? data.apiUrl.trim() : '');
  if (!baseUrlRaw) return { ok: false, error: 'missing baseUrl/apiUrl' };
  const baseUrl = ensureOpenAiCompatibleBaseUrlV1(baseUrlRaw);

  const apiKey = (typeof data.apiKey === 'string' && data.apiKey.trim())
    || (typeof data.platformAccessToken === 'string' && data.platformAccessToken.trim())
    || '';
  if (!apiKey) return { ok: false, error: 'missing apiKey/platformAccessToken' };

  return { ok: true, value: { baseUrl, apiKey } };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run src/shared/cloudPlatformProvider/parsers.test.ts`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/shared/cloudPlatformProvider/
git commit -m "feat(cloud-platform): shared types, constants and parsers"
```

---

### Task 2: CloudPlatformProviderStore (SQLCipher kv wrapper)

**Files:**
- Create: `src/main/services/cloudPlatformProviderStore.ts`
- Create: `src/main/services/cloudPlatformProviderStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/services/cloudPlatformProviderStore.test.ts`:
```ts
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3-multiple-ciphers';
import fs from 'fs';
import os from 'os';
import path from 'path';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/cloudPlatformProviderStore.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create cloudPlatformProviderStore.ts**

Create `src/main/services/cloudPlatformProviderStore.ts`:
```ts
import type Database from 'better-sqlite3-multiple-ciphers';
import type { CloudPlatformProviderRecord } from '../../shared/cloudPlatformProvider/types';

const KEY = 'current';

export class CloudPlatformProviderStore {
  constructor(private readonly db: Database.Database) {
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_platform_provider (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  async save(record: CloudPlatformProviderRecord): Promise<void> {
    this.db.prepare(
      'INSERT OR REPLACE INTO cloud_platform_provider (key, value) VALUES (?, ?)'
    ).run(KEY, JSON.stringify(record));
  }

  async load(): Promise<CloudPlatformProviderRecord | null> {
    const row = this.db.prepare(
      'SELECT value FROM cloud_platform_provider WHERE key = ?'
    ).get(KEY) as { value: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as CloudPlatformProviderRecord;
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    this.db.prepare('DELETE FROM cloud_platform_provider WHERE key = ?').run(KEY);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/services/cloudPlatformProviderStore.test.ts`
Expected: All 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/services/cloudPlatformProviderStore.ts src/main/services/cloudPlatformProviderStore.test.ts
git commit -m "feat(cloud-platform): sqlcipher-backed provider store"
```

---

### Task 3: CloudPlatformProviderService (sync logic + override)

**Files:**
- Create: `src/main/services/cloudPlatformProviderService.ts`
- Create: `src/main/services/cloudPlatformProviderService.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/services/cloudPlatformProviderService.test.ts`:
```ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3-multiple-ciphers';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

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
      // Pre-populate
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
        lastSyncedAt: Date.now() - 60 * 60 * 1000, // 1h ago
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
        lastSyncedAt: Date.now() - 25 * 60 * 60 * 1000, // 25h ago
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/cloudPlatformProviderService.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create cloudPlatformProviderService.ts**

Create `src/main/services/cloudPlatformProviderService.ts`:
```ts
import type { EventEmitter } from 'events';
import type Database from 'better-sqlite3-multiple-ciphers';
import { CloudAuthService } from './cloudAuth';
import { CloudPlatformProviderStore } from './cloudPlatformProviderStore';
import { parseNewApiConfig } from '../../shared/cloudPlatformProvider/parsers';
import type { CloudPlatformProviderRecord } from '../../shared/cloudPlatformProvider/types';
import {
  PlatformProviderSyncThresholdMs,
  PlatformProviderConfigPath,
  CloudPlatformProviderChannel,
} from '../../shared/cloudPlatformProvider/constants';
import { CloudAuthChannel } from '../../shared/cloudAuth/constants';

export class CloudPlatformProviderService {
  private store: CloudPlatformProviderStore;
  private inFlightSync: Promise<boolean> | null = null;
  private unsubLoginSuccess: (() => void) | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly cloudAuth: CloudAuthService,
    private readonly broadcaster: EventEmitter
  ) {
    this.store = new CloudPlatformProviderStore(db);
  }

  async init(): Promise<void> {
    const loginHandler = () => {
      void this.sync().catch((e) =>
        console.error('[CloudPlatformProvider] auto-sync failed:', e)
      );
    };
    this.broadcaster.on(CloudAuthChannel.LoginSuccessEvent, loginHandler);
    this.unsubLoginSuccess = () => {
      this.broadcaster.off(CloudAuthChannel.LoginSuccessEvent, loginHandler);
    };
    void this.ensureSynced().catch((e) =>
      console.error('[CloudPlatformProvider] ensureSynced failed:', e)
    );
  }

  async ensureSynced(): Promise<void> {
    const existing = await this.store.load();
    if (
      existing?.userOverride
      && (existing.userOverride.baseUrl != null || existing.userOverride.apiKey != null)
    ) {
      return;
    }
    if (existing && Date.now() - existing.lastSyncedAt < PlatformProviderSyncThresholdMs) {
      return;
    }
    await this.sync();
  }

  async sync(): Promise<{ success: boolean; record?: CloudPlatformProviderRecord; error?: string }> {
    if (this.inFlightSync) {
      const ok = await this.inFlightSync;
      const record = await this.store.load();
      return { success: ok, record: record ?? undefined, error: ok ? undefined : 'sync failed' };
    }

    this.inFlightSync = (async () => {
      try {
        const baseUrl = this.cloudAuth.getCloudApiBaseUrl();
        const resp = await this.cloudAuth.fetchMemberAuthorized(
          `${baseUrl}${PlatformProviderConfigPath}`,
          { method: 'GET' }
        );

        if (!resp.ok) {
          const err = `HTTP ${resp.status}`;
          this.broadcaster.emit(CloudPlatformProviderChannel.SyncFailedEvent, { error: err });
          return false;
        }

        const body = await resp.json();
        const parsed = parseNewApiConfig(body);
        if (!parsed.ok) {
          this.broadcaster.emit(CloudPlatformProviderChannel.SyncFailedEvent, { error: parsed.error });
          return false;
        }

        const existing = await this.store.load();
        const record: CloudPlatformProviderRecord = {
          baseUrl: parsed.value.baseUrl,
          apiKey: parsed.value.apiKey,
          lastSyncedAt: Date.now(),
          userOverride: existing?.userOverride,
        };
        await this.store.save(record);
        this.broadcaster.emit(CloudPlatformProviderChannel.UpdatedEvent, { record });
        return true;
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        this.broadcaster.emit(CloudPlatformProviderChannel.SyncFailedEvent, { error: err });
        return false;
      } finally {
        this.inFlightSync = null;
      }
    })();

    return this.inFlightSync.then(async (ok) => {
      const record = await this.store.load();
      return { success: ok, record: record ?? undefined, error: ok ? undefined : 'sync failed' };
    });
  }

  async get(): Promise<CloudPlatformProviderRecord | null> {
    return this.store.load();
  }

  async setOverride(input: { baseUrl?: string; apiKey?: string }): Promise<{ success: boolean; error?: string }> {
    if (input.baseUrl != null && !/^https?:\/\//i.test(input.baseUrl.trim())) {
      return { success: false, error: 'baseUrl must start with http:// or https://' };
    }
    const existing = await this.store.load();
    if (!existing) {
      return { success: false, error: 'no synced record to override' };
    }
    const record: CloudPlatformProviderRecord = {
      ...existing,
      userOverride: {
        baseUrl: input.baseUrl?.trim() || undefined,
        apiKey: input.apiKey?.trim() || undefined,
      },
    };
    await this.store.save(record);
    this.broadcaster.emit(CloudPlatformProviderChannel.UpdatedEvent, { record });
    return { success: true };
  }

  async resetDefault(): Promise<{ success: boolean; error?: string }> {
    const existing = await this.store.load();
    if (!existing) {
      return { success: false, error: 'no record to reset' };
    }
    const record: CloudPlatformProviderRecord = {
      baseUrl: existing.baseUrl,
      apiKey: existing.apiKey,
      lastSyncedAt: existing.lastSyncedAt,
    };
    await this.store.save(record);
    this.broadcaster.emit(CloudPlatformProviderChannel.UpdatedEvent, { record });
    void this.sync().catch((e) =>
      console.error('[CloudPlatformProvider] post-reset sync failed:', e)
    );
    return { success: true };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/services/cloudPlatformProviderService.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/services/cloudPlatformProviderService.ts src/main/services/cloudPlatformProviderService.test.ts
git commit -m "feat(cloud-platform): sync service with 24h idempotent + override"
```

---

### Task 4: Extend CloudAuthService.getStatus() to return coin + subscriptionPlan

**Files:**
- Modify: `src/main/services/cloudAuth.ts`
- Modify: `src/main/services/cloudAuth.test.ts`

- [ ] **Step 1: Read existing getStatus in cloudAuth.ts**

Open `src/main/services/cloudAuth.ts`. Find the `getStatus()` method. Currently it returns:
```ts
async getStatus(): Promise<{ isLoggedIn: boolean; user?: CloudUserInfo; hasCompletedFirstLogin: boolean }>
```

The `user` field is read from the `cloud_user_info` kv (A implementation). Add `coin: number` and `subscriptionPlan: string` to the return type, sourced from the same user object.

- [ ] **Step 2: Update getStatus signature and return**

Change to:
```ts
async getStatus(): Promise<{
  isLoggedIn: boolean;
  user?: CloudUserInfo;
  hasCompletedFirstLogin: boolean;
  coin: number;
  subscriptionPlan: string;
}>
```

And in the return value, after `user`, add:
```ts
coin: user?.coin ?? 0,
subscriptionPlan: user?.subscriptionPlan ?? '',
```

- [ ] **Step 3: Add a test for the new fields**

Open `src/main/services/cloudAuth.test.ts`. Find the test that calls `getStatus()`. If there's no existing test for it, add one. Verify the new fields are present.

```ts
describe('getStatus', () => {
  test('returns coin and subscriptionPlan from user', async () => {
    // Pre-populate cloud_user_info kv
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
});
```

- [ ] **Step 4: Run all existing tests + new tests**

Run: `npx vitest run src/main/services/cloudAuth.test.ts`
Expected: All tests pass (no regressions, new tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/main/services/cloudAuth.ts src/main/services/cloudAuth.test.ts
git commit -m "feat(cloud-auth): extend getStatus to return coin and subscriptionPlan"
```

---

### Task 5: IPC handlers + main.ts wiring

**Files:**
- Modify: `src/main/ipcHandlers/cloudAuth.ts`
- Modify: `src/main/main.ts`

- [ ] **Step 1: Add IPC handler registration to ipcHandlers/cloudAuth.ts**

Open `src/main/ipcHandlers/cloudAuth.ts`. Add a new exported function:

```ts
import { CloudPlatformProviderChannel } from '../../shared/cloudPlatformProvider/constants';
import { CloudPlatformProviderService } from '../services/cloudPlatformProviderService';

export function registerCloudPlatformProviderHandlers(
  service: CloudPlatformProviderService
): void {
  ipcMain.handle(CloudPlatformProviderChannel.Get, () => service.get());
  ipcMain.handle(CloudPlatformProviderChannel.Sync, () => service.sync());
  ipcMain.handle(
    CloudPlatformProviderChannel.SetOverride,
    (_e, payload: { baseUrl?: string; apiKey?: string }) => {
      if (!payload) return { success: false, error: 'payload required' };
      return service.setOverride(payload);
    }
  );
  ipcMain.handle(CloudPlatformProviderChannel.ResetDefault, () => service.resetDefault());
}
```

- [ ] **Step 2: Modify main.ts to wire the service**

Open `src/main/main.ts`. Find where `registerCloudAuthHandlers` is called (A implementation). After it, add:

```ts
import { CloudPlatformProviderService } from './services/cloudPlatformProviderService';
import { registerCloudPlatformProviderHandlers } from './ipcHandlers/cloudAuth';

// after cloudBroadcaster and registerCloudAuthHandlers:
const platformProviderService = new CloudPlatformProviderService(
  getStore().getDatabase(),
  cloudAuthService,
  cloudBroadcaster,
);
void platformProviderService.init();
registerCloudPlatformProviderHandlers(platformProviderService);
```

- [ ] **Step 3: Compile and verify**

Run: `npm run compile:electron`
Expected: No errors

- [ ] **Step 4: Run all existing tests**

Run: `npm test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/main/ipcHandlers/cloudAuth.ts src/main/main.ts
git commit -m "feat(cloud-platform): wire IPC handlers and main process init"
```

---

### Task 6: Preload + types

**Files:**
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/types/electron.d.ts`

- [ ] **Step 1: Add cloudPlatformProvider namespace to preload.ts**

Open `src/main/preload.ts`. Add at the top of the file:
```ts
import { CloudPlatformProviderChannel } from '../shared/cloudPlatformProvider/constants';
import type { CloudPlatformProviderRecord } from '../shared/cloudPlatformProvider/types';
```

Find where `contextBridge.exposeInMainWorld('electron', {...})` is. Add a new namespace:
```ts
cloudPlatformProvider: {
  get: () => ipcRenderer.invoke(CloudPlatformProviderChannel.Get),
  sync: () => ipcRenderer.invoke(CloudPlatformProviderChannel.Sync),
  setOverride: (payload: { baseUrl?: string; apiKey?: string }) =>
    ipcRenderer.invoke(CloudPlatformProviderChannel.SetOverride, payload),
  resetDefault: () => ipcRenderer.invoke(CloudPlatformProviderChannel.ResetDefault),
  onUpdated: (handler: (payload: { record: CloudPlatformProviderRecord }) => void) => {
    const wrapped = (_e: unknown, payload: { record: CloudPlatformProviderRecord }) => handler(payload);
    ipcRenderer.on(CloudPlatformProviderChannel.UpdatedEvent, wrapped);
    return () => ipcRenderer.off(CloudPlatformProviderChannel.UpdatedEvent, wrapped);
  },
  onSyncFailed: (handler: (payload: { error: string }) => void) => {
    const wrapped = (_e: unknown, payload: { error: string }) => handler(payload);
    ipcRenderer.on(CloudPlatformProviderChannel.SyncFailedEvent, wrapped);
    return () => ipcRenderer.off(CloudPlatformProviderChannel.SyncFailedEvent, wrapped);
  },
},
```

- [ ] **Step 2: Add type declarations to electron.d.ts**

Open `src/renderer/types/electron.d.ts`. Find the existing `IElectronAPI` declaration. Add types:

```ts
export type CloudPlatformProviderRecord = {
  baseUrl: string;
  apiKey: string;
  lastSyncedAt: number;
  userOverride?: { baseUrl?: string; apiKey?: string };
};

// inside IElectronAPI:
cloudPlatformProvider: {
  get: () => Promise<CloudPlatformProviderRecord | null>;
  sync: () => Promise<{ success: boolean; record?: CloudPlatformProviderRecord; error?: string }>;
  setOverride: (payload: { baseUrl?: string; apiKey?: string }) =>
    Promise<{ success: boolean; error?: string }>;
  resetDefault: () => Promise<{ success: boolean; error?: string }>;
  onUpdated: (handler: (payload: { record: CloudPlatformProviderRecord }) => void) => () => void;
  onSyncFailed: (handler: (payload: { error: string }) => void) => () => void;
};
```

- [ ] **Step 3: Run TypeScript check**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/preload.ts src/renderer/types/electron.d.ts
git commit -m "feat(cloud-platform): preload bridge and renderer type declarations"
```

---

### Task 7: Extend cloudAuthSlice with platformProvider fields

**Files:**
- Modify: `src/renderer/store/slices/cloudAuthSlice.ts`

- [ ] **Step 1: Read existing cloudAuthSlice.ts**

Open `src/renderer/store/slices/cloudAuthSlice.ts`. Locate the state interface and reducer functions.

- [ ] **Step 2: Add platformProvider fields and reducer**

Add fields to the state interface (alongside the existing `isLoggedIn`, `user`, `hasCompletedFirstLogin`):
```ts
import type { CloudPlatformProviderRecord } from '../../../shared/cloudPlatformProvider/types';
import { isOverridden } from '../../../shared/cloudPlatformProvider/types';

interface CloudAuthState {
  // ... existing fields
  platformProvider: CloudPlatformProviderRecord | null;
  platformProviderIsOverridden: boolean;
  platformProviderLastSyncedAt: number | null;
}
```

Initial state:
```ts
const initialState: CloudAuthState = {
  // ... existing
  platformProvider: null,
  platformProviderIsOverridden: false,
  platformProviderLastSyncedAt: null,
};
```

New reducer:
```ts
setPlatformProvider(state, action: PayloadAction<CloudPlatformProviderRecord | null>) {
  state.platformProvider = action.payload;
  state.platformProviderIsOverridden = isOverridden(action.payload);
  state.platformProviderLastSyncedAt = action.payload?.lastSyncedAt ?? null;
}
```

Export the new action.

- [ ] **Step 3: Run TypeScript check**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/store/slices/cloudAuthSlice.ts
git commit -m "feat(cloud-auth-slice): add platformProvider fields and reducer"
```

---

### Task 8: Renderer service for cloudPlatformProvider

**Files:**
- Create: `src/renderer/services/cloudPlatformProvider.ts`
- Modify: `src/renderer/services/cloudAuth.ts` (call new service's init)

- [ ] **Step 1: Create cloudPlatformProvider.ts**

Create `src/renderer/services/cloudPlatformProvider.ts`:
```ts
import { store } from '../store';
import { setPlatformProvider } from '../store/slices/cloudAuthSlice';
import type { CloudPlatformProviderRecord } from '../../shared/cloudPlatformProvider/types';

class CloudPlatformProviderService {
  private unsubUpdated: (() => void) | null = null;
  private unsubFailed: (() => void) | null = null;

  async init(): Promise<void> {
    this.destroy();
    await this.refresh();
    this.unsubUpdated = window.electron.cloudPlatformProvider.onUpdated((payload: { record: CloudPlatformProviderRecord }) => {
      store.dispatch(setPlatformProvider(payload.record));
    });
    this.unsubFailed = window.electron.cloudPlatformProvider.onSyncFailed((payload: { error: string }) => {
      console.error('[CloudPlatformProvider] sync failed:', payload.error);
    });
  }

  async refresh(): Promise<void> {
    const r = await window.electron.cloudPlatformProvider.get();
    if (r) store.dispatch(setPlatformProvider(r));
  }

  async sync() {
    return window.electron.cloudPlatformProvider.sync();
  }

  async setOverride(input: { baseUrl?: string; apiKey?: string }) {
    return window.electron.cloudPlatformProvider.setOverride(input);
  }

  async resetDefault() {
    return window.electron.cloudPlatformProvider.resetDefault();
  }

  destroy() {
    this.unsubUpdated?.();
    this.unsubUpdated = null;
    this.unsubFailed?.();
    this.unsubFailed = null;
  }
}

export const cloudPlatformProviderService = new CloudPlatformProviderService();
```

- [ ] **Step 2: Update services/cloudAuth.ts to call the new service**

Open `src/renderer/services/cloudAuth.ts`. In the `init()` method, after the existing logic, add:
```ts
import { cloudPlatformProviderService } from './cloudPlatformProvider';

// inside init():
await cloudPlatformProviderService.init();
```

- [ ] **Step 3: Run TypeScript check**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/services/cloudPlatformProvider.ts src/renderer/services/cloudAuth.ts
git commit -m "feat(cloud-platform): renderer service + init wiring"
```

---

### Task 9: CloudPlatformProviderSection Settings UI

**Files:**
- Create: `src/renderer/components/Settings/CloudPlatformProviderSection.tsx`
- Create: `src/renderer/components/Settings/CloudPlatformProviderSection.test.tsx`

- [ ] **Step 1: Write failing test**

Create `src/renderer/components/Settings/CloudPlatformProviderSection.test.tsx`:
```tsx
import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import cloudAuthReducer from '../../store/slices/cloudAuthSlice';
import { CloudPlatformProviderSection } from './CloudPlatformProviderSection';

vi.mock('../../services/cloudPlatformProvider', () => ({
  cloudPlatformProviderService: {
    refresh: vi.fn().mockResolvedValue(undefined),
    sync: vi.fn().mockResolvedValue({ success: true }),
    setOverride: vi.fn().mockResolvedValue({ success: true }),
    resetDefault: vi.fn().mockResolvedValue({ success: true }),
  },
}));

function renderWithState(state: Partial<ReturnType<typeof cloudAuthReducer>>) {
  const store = configureStore({
    reducer: { cloudAuth: cloudAuthReducer },
    preloadedState: { cloudAuth: {
      isLoggedIn: true, user: null, hasCompletedFirstLogin: true, isLoading: false,
      platformProvider: null, platformProviderIsOverridden: false, platformProviderLastSyncedAt: null,
      ...state,
    } },
  });
  return render(<Provider store={store}><CloudPlatformProviderSection /></Provider>);
}

describe('CloudPlatformProviderSection', () => {
  test('shows override inputs always', () => {
    renderWithState({});
    expect(screen.getByTestId('platform-override-baseurl')).toBeTruthy();
    expect(screen.getByTestId('platform-override-apikey')).toBeTruthy();
  });

  test('displays effective baseUrl/apiKey when record exists', () => {
    renderWithState({
      platformProvider: { baseUrl: 'https://cloud/v1', apiKey: 'sk-abc', lastSyncedAt: 1000 },
      platformProviderIsOverridden: false,
    });
    const baseUrlEl = screen.getByTestId('platform-effective-baseurl');
    expect(baseUrlEl.textContent).toBe('https://cloud/v1');
  });

  test('shows overridden badge when override is set', () => {
    renderWithState({
      platformProvider: {
        baseUrl: 'https://cloud/v1', apiKey: 'cloud', lastSyncedAt: 1,
        userOverride: { baseUrl: 'https://override/v1' },
      },
      platformProviderIsOverridden: true,
    });
    expect(screen.getByTestId('platform-overridden-badge')).toBeTruthy();
  });

  test('disables reset button when not overridden', () => {
    renderWithState({
      platformProvider: { baseUrl: 'a', apiKey: 'b', lastSyncedAt: 1 },
      platformProviderIsOverridden: false,
    });
    expect(screen.getByTestId('platform-reset-default')).toBeDisabled();
  });

  test('enables reset button when overridden', () => {
    renderWithState({
      platformProvider: { baseUrl: 'a', apiKey: 'b', lastSyncedAt: 1, userOverride: { baseUrl: 'x' } },
      platformProviderIsOverridden: true,
    });
    expect(screen.getByTestId('platform-reset-default')).not.toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/components/Settings/CloudPlatformProviderSection.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Create CloudPlatformProviderSection.tsx**

Create `src/renderer/components/Settings/CloudPlatformProviderSection.tsx`:
```tsx
import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import { cloudPlatformProviderService } from '../../services/cloudPlatformProvider';
import { effective as effectiveOf } from '../../../shared/cloudPlatformProvider/types';

export function CloudPlatformProviderSection() {
  const record = useSelector((s: RootState) => s.cloudAuth.platformProvider);
  const isOverridden = useSelector((s: RootState) => s.cloudAuth.platformProviderIsOverridden);
  const lastSyncedAt = useSelector((s: RootState) => s.cloudAuth.platformProviderLastSyncedAt);

  const [overrideBaseUrl, setOverrideBaseUrl] = useState('');
  const [overrideApiKey, setOverrideApiKey] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    void cloudPlatformProviderService.refresh();
  }, []);

  const eff = record ? effectiveOf(record) : null;

  const handleSaveOverride = async () => {
    setErrorMessage(null);
    const r = await cloudPlatformProviderService.setOverride({
      baseUrl: overrideBaseUrl || undefined,
      apiKey: overrideApiKey || undefined,
    });
    if (!r.success) {
      setErrorMessage(r.error ?? 'save failed');
      return;
    }
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 2000);
    setOverrideBaseUrl('');
    setOverrideApiKey('');
  };

  const handleReset = async () => {
    setErrorMessage(null);
    await cloudPlatformProviderService.resetDefault();
  };

  const handleSync = async () => {
    setSyncing(true);
    setErrorMessage(null);
    try {
      const r = await cloudPlatformProviderService.sync();
      if (!r.success) setErrorMessage(r.error ?? 'sync failed');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">{i18nService.t('authCloudPlatformTitle')}</h3>

      {eff && (
        <div className="rounded border border-border bg-muted/30 p-3 text-sm space-y-1">
          <div>
            <span className="text-muted-foreground">{i18nService.t('authCloudPlatformBaseUrl')}: </span>
            <span data-testid="platform-effective-baseurl" className="font-mono">{eff.baseUrl}</span>
          </div>
          <div>
            <span className="text-muted-foreground">{i18nService.t('authCloudPlatformApiKey')}: </span>
            <span data-testid="platform-effective-apikey" className="font-mono">
              {'•'.repeat(Math.min(eff.apiKey.length, 24))}
            </span>
          </div>
          {isOverridden && (
            <div data-testid="platform-overridden-badge" className="text-xs text-amber-500">
              {i18nService.t('authCloudPlatformOverridden')}
            </div>
          )}
          {lastSyncedAt && (
            <div data-testid="platform-last-synced" className="text-xs text-muted-foreground">
              {i18nService.t('authCloudPlatformLastSyncedAt', {
                at: new Date(lastSyncedAt).toLocaleString(),
              })}
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        <label className="text-xs text-muted-foreground">
          {i18nService.t('authCloudPlatformOverrideBaseUrl')}
        </label>
        <input
          data-testid="platform-override-baseurl"
          value={overrideBaseUrl}
          onChange={(e) => setOverrideBaseUrl(e.target.value)}
          placeholder="https://api.runnode.example.com/v1"
          className="w-full rounded border border-border px-3 py-2 text-sm font-mono"
        />
        <label className="text-xs text-muted-foreground">
          {i18nService.t('authCloudPlatformOverrideApiKey')}
        </label>
        <input
          data-testid="platform-override-apikey"
          value={overrideApiKey}
          onChange={(e) => setOverrideApiKey(e.target.value)}
          placeholder="sk-..."
          className="w-full rounded border border-border px-3 py-2 text-sm font-mono"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          data-testid="platform-save-override"
          onClick={handleSaveOverride}
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground"
        >
          {i18nService.t('authCloudPlatformSaveOverride')}
        </button>
        <button
          data-testid="platform-reset-default"
          onClick={handleReset}
          disabled={!isOverridden}
          className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50"
        >
          {i18nService.t('authCloudPlatformResetDefault')}
        </button>
        <button
          data-testid="platform-sync"
          onClick={handleSync}
          disabled={syncing}
          className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50"
        >
          {syncing ? i18nService.t('loading') : i18nService.t('authCloudPlatformSyncNow')}
        </button>
        {savedFlash && (
          <span className="text-sm text-green-500">{i18nService.t('saved')}</span>
        )}
      </div>

      {errorMessage && (
        <p data-testid="platform-error" className="text-sm text-red-500">{errorMessage}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/components/Settings/CloudPlatformProviderSection.test.tsx`
Expected: All 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Settings/CloudPlatformProviderSection.tsx src/renderer/components/Settings/CloudPlatformProviderSection.test.tsx
git commit -m "feat(cloud-platform): settings section with override, reset, sync"
```

---

### Task 10: Mount CloudPlatformProviderSection in Settings

**Files:**
- Modify: `src/renderer/components/Settings.tsx` (or wherever Settings UI lives)

- [ ] **Step 1: Find existing Settings sections**

Open `src/renderer/components/Settings.tsx`. Find where existing sections are mounted (e.g., `<CloudApiSection />` from A).

- [ ] **Step 2: Add import and mount**

Add:
```ts
import { CloudPlatformProviderSection } from './Settings/CloudPlatformProviderSection';
```

In a sensible tab (e.g., Advanced, or new Account tab), add:
```tsx
<CloudPlatformProviderSection />
```

- [ ] **Step 3: Run TypeScript check**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/Settings.tsx
git commit -m "feat(cloud-platform): mount CloudPlatformProviderSection in Settings"
```

---

### Task 11: Add coin 余额 + 套餐徽章 to Sidebar

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`
- Modify: `src/renderer/components/Sidebar.test.tsx` (if it exists)

- [ ] **Step 1: Read Sidebar.tsx**

Open `src/renderer/components/Sidebar.tsx`. Find the user menu section (A implementation added login entry + user dropdown).

- [ ] **Step 2: Add coin + subscriptionPlan display**

In the user menu, add (above the existing logout button):
```tsx
{user && (
  <div className="px-2 py-1 space-y-1 text-xs">
    {user.subscriptionPlan && (
      <span
        data-testid="sidebar-plan-badge"
        className={cn(
          'inline-block px-1.5 py-0.5 rounded font-medium',
          user.subscriptionPlan === 'Pro' && 'bg-gradient-to-r from-amber-500 to-yellow-400 text-white',
          user.subscriptionPlan === 'Plus' && 'bg-gradient-to-r from-blue-500 to-cyan-400 text-white',
          user.subscriptionPlan === 'Team' && 'bg-gradient-to-r from-purple-500 to-violet-400 text-white',
          user.subscriptionPlan === 'FREE' && 'bg-muted text-foreground'
        )}
      >
        {user.subscriptionPlan}
      </span>
    )}
    {typeof user.coin === 'number' && user.coin > 0 && (
      <span data-testid="sidebar-coin-balance" className="text-muted-foreground">
        {i18nService.t('authCoinBalance', { count: user.coin })}
      </span>
    )}
  </div>
)}
```

- [ ] **Step 3: Run TypeScript check + existing tests**

```bash
npm run typecheck
npm test
```

Expected: No new errors, all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/Sidebar.tsx
git commit -m "feat(cloud-auth): add coin and plan badges to sidebar user menu"
```

---

### Task 12: Add i18n keys for new components

**Files:**
- Modify: `src/renderer/services/i18n.ts`

- [ ] **Step 1: Add keys to both zh and en sections**

Open `src/renderer/services/i18n.ts`. Add the following keys:

```ts
// zh
authCloudPlatformTitle: 'RunNode Platform Provider',
authCloudPlatformBaseUrl: 'Base URL',
authCloudPlatformApiKey: 'API Key',
authCloudPlatformOverridden: '已使用本地覆盖，云端同步暂停',
authCloudPlatformLastSyncedAt: '上次同步：{at}',
authCloudPlatformOverrideBaseUrl: '覆盖 Base URL（留空 = 保持云端）',
authCloudPlatformOverrideApiKey: '覆盖 API Key（留空 = 保持云端）',
authCloudPlatformSaveOverride: '保存覆盖',
authCloudPlatformResetDefault: '恢复默认',
authCloudPlatformSyncNow: '立即同步',
authCoinBalance: '算力币余额：{count}',

// en
authCloudPlatformTitle: 'RunNode Platform Provider',
authCloudPlatformBaseUrl: 'Base URL',
authCloudPlatformApiKey: 'API Key',
authCloudPlatformOverridden: 'Using local override; cloud sync paused',
authCloudPlatformLastSyncedAt: 'Last synced: {at}',
authCloudPlatformOverrideBaseUrl: 'Override Base URL (blank = keep cloud)',
authCloudPlatformOverrideApiKey: 'Override API Key (blank = keep cloud)',
authCloudPlatformSaveOverride: 'Save override',
authCloudPlatformResetDefault: 'Reset to default',
authCloudPlatformSyncNow: 'Sync now',
authCoinBalance: 'Coin balance: {count}',
```

- [ ] **Step 2: Run TypeScript check**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/renderer/services/i18n.ts
git commit -m "feat(cloud-platform): i18n keys for platform provider section"
```

---

### Task 13: Final cleanup + mark spec implemented + update AGENTS.md

**Files:**
- Modify: `docs/superpowers/specs/2026-06-06-wesight-runnode-platform-provider-design.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Run full test suite**

```bash
npm run typecheck
npm run lint
npm test
```

Expected: All green

- [ ] **Step 2: Mark spec as Implemented**

Open `docs/superpowers/specs/2026-06-06-wesight-runnode-platform-provider-design.md`. At the very top, after the title, add:
```markdown
> **Status:** Implemented (2026-06-06)
```

- [ ] **Step 3: Update AGENTS.md**

Open `AGENTS.md`. Add B to the Authentication section:
```markdown
## Authentication

WeSight uses RunNode member auth (not URS OAuth) with a dedicated platform provider sync.

- **A — User system**: 4 login methods (password/SMS/WeChat), SQLCipher token store, 401 auto-retry, device registration. See `docs/superpowers/specs/2026-06-05-wesight-runnode-user-auth-design.md`. Code: `src/main/services/cloudAuth.ts`, `cloudAuthTokenStore.ts`, `cloudUserDeviceService.ts`, `src/renderer/services/cloudAuth.ts`, `src/renderer/store/slices/cloudAuthSlice.ts`, `src/renderer/components/{LoginGate,LoginModal}.tsx`.

- **B — Platform provider sync**: syncs RunNode's `new-api/config` (baseUrl + apiKey) into a dedicated SQLCipher table. Hybrid override model: cloud wins by default, user can override with explicit reset. 24h idempotent refresh. Code: `src/shared/cloudPlatformProvider/`, `src/main/services/cloudPlatformProvider{Store,Service}.ts`, `src/renderer/services/cloudPlatformProvider.ts`, `src/renderer/components/Settings/CloudPlatformProviderSection.tsx`.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-06-06-wesight-runnode-platform-provider-design.md AGENTS.md
git commit -m "docs: mark platform provider spec implemented + update AGENTS.md"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Implemented in |
|---|---|
| State machine | Task 3 (sync + ensureSynced + override) |
| Data model (single row + JSON) | Task 1 (types), Task 2 (store) |
| 4 data flows (login sync / 24h / override / reset) | Task 3 (service) |
| Coin / subscriptionPlan display | Task 4 (getStatus), Task 11 (sidebar), Task 8 (slice) |
| IPC contract (4 invoke + 2 event) | Task 5 (handlers), Task 6 (preload + types) |
| Schema migration | Task 2 (ensureTable on first save) |
| Out of scope | C and D explicitly excluded; A unchanged |

**2. Placeholder scan:** No "TBD" / "TODO" / "fill in details" / "similar to Task N".

**3. Type consistency:**
- `CloudPlatformProviderRecord` defined in `src/shared/cloudPlatformProvider/types.ts`, imported by store, service, parsers, and renderer service
- `isOverridden` and `effective` helpers in `types.ts`, used by both service and React component
- `CloudPlatformProviderChannel.*` constants used everywhere (service, IPC handlers, preload, event emit/listen)
- `CloudPlatformProviderRecord` IPC payload type matches across all boundaries

No inconsistencies found. Ready to execute.
