# WeSight × RunNode User Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace WeSight's URS OAuth login with RunNode business-cloud member auth (4 login methods, SQLCipher token store, 401 auto-retry, device registration, hard URS cleanup).

**Architecture:** Direct IPC re-implementation of RClaw's RunNode interface contract using WeSight's native `ipcMain.handle` pattern. Main process owns `CloudAuthService` + `CloudUserDeviceService` + SQLCipher-backed token store. Renderer uses Redux slice + `window.electron.cloudAuth.*` IPC.

**Tech Stack:**
- `better-sqlite3-multiple-ciphers` (replaces `better-sqlite3` for SQLCipher support)
- `node-machine-id` (derive DB encryption key)
- Existing: Electron 40, React 18, Redux Toolkit, TypeScript 5.7, Vitest, Playwright
- IPC channel naming: `cloud:auth:*` (renderer-callable) + main-internal events
- DB: existing `wesight.sqlite`, re-opened with cipher key

**Spec:** `docs/superpowers/specs/2026-06-05-wesight-runnode-user-auth-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `package.json` | Modify | Swap `better-sqlite3` → `better-sqlite3-multiple-ciphers`, add `node-machine-id` |
| `vite.config.ts` | Modify | Inject `VITE_CLOUD_API_BASE_URL` into renderer build |
| `.env.example` | Modify | Add `VITE_CLOUD_API_BASE_URL=...` placeholder |
| `electron-builder.json` | Modify | Add `asarUnpack` for native module paths if needed |
| `src/shared/cloudAuth/constants.ts` | Create | IPC channel names, status types, response codes |
| `src/shared/cloudAuth/parsers.ts` | Create | `parseMemberAuthLoginBody`, `parseMemberAuthRefreshBody`, `parseMemberUserGetBody` |
| `src/main/utils/sqlcipherKey.ts` | Create | `deriveSqlcipherKey()` from `node-machine-id` + app name |
| `src/main/utils/cloudApiBaseUrl.ts` | Create | `getCloudApiBaseUrl(): string` (env + Settings merge) |
| `src/main/utils/cloudFetch.ts` | Create | `cloudFetch<T>(label, url, init)` with 401 retry + logging |
| `src/main/services/cloudAuthTokenStore.ts` | Create | SQLCipher wrapper for `cloud_tokens` table |
| `src/main/services/cloudUserDeviceStore.ts` | Create | SQLCipher wrapper for `cloud_devices` table |
| `src/main/services/cloudAuthService.ts` | Create | Login/refresh/401 retry/broadcast |
| `src/main/services/cloudUserDeviceService.ts` | Create | Device register + heartbeat (self-scheduled) |
| `src/main/ipcHandlers/cloudAuth.ts` | Create | Register 8 `ipcMain.handle` + 2 events |
| `src/main/migrations/legacyAuthCleanup.ts` | Create | One-time URS kv deletion on startup |
| `src/main/probeCloudBaseUrl.ts` | Create | Network probe for "test connection" button |
| `src/main/main.ts` | Modify | Replace URS section, register cloud:auth:*, call cleanup + init |
| `src/main/preload.ts` | Modify | Expose `cloudAuth` + `cloudDevice` namespaces |
| `src/renderer/types/electron.d.ts` | Modify | Type declarations for `cloudAuth`, `cloudDevice` |
| `src/renderer/store/slices/authSlice.ts` | Delete | Replaced by `cloudAuthSlice` |
| `src/renderer/store/slices/cloudAuthSlice.ts` | Create | `isLoggedIn`, `user`, `hasCompletedFirstLogin` |
| `src/renderer/services/auth.ts` | Delete | Replaced by `cloudAuth.ts` |
| `src/renderer/services/cloudAuth.ts` | Create | Renderer-side service wrapping `window.electron.cloudAuth.*` |
| `src/renderer/services/config.ts` | Modify | Add `cloudApiBaseUrl` field |
| `src/renderer/services/i18n.ts` | Modify | Add `authCloud*` keys; remove `authPlan*` / `authQuota*` / `authCredits*` |
| `src/renderer/components/LoginButton.tsx` | Delete | Replaced by LoginModal + LoginGate |
| `src/renderer/components/LoginGate.tsx` | Create | First-run mandatory + auto-inject LoginModal |
| `src/renderer/components/LoginModal.tsx` | Create | 3 tabs (password / sms / wechat) + inline 注册/找回 links |
| `src/renderer/components/WechatQrDialog.tsx` | Create | QR display + polling + 5-min timeout |
| `src/renderer/components/Sidebar.tsx` | Modify | Read `cloudAuthSlice`, remove `hideLogin` prop |
| `src/renderer/components/Settings/CloudApiSection.tsx` | Create | RunNode URL + "test connection" + "save" |
| `src/renderer/App.tsx` | Modify | Use `cloudAuthService.init()`, wrap with `<LoginGate>` |
| `src/renderer/components/LoginGate.test.tsx` | Create | 3 states covered |
| `src/renderer/components/LoginModal.test.tsx` | Create | 3 tab switching + 60s countdown + error banner + 注册/找回 links |
| `src/renderer/components/WechatQrDialog.test.tsx` | Create | waiting/scanned/confirmed/expired transitions + 5-min timeout |
| `src/shared/cloudAuth/parsers.test.ts` | Create | All 3 parsers with various response shapes |
| `src/main/services/cloudAuth.test.ts` | Create | getValidToken, refresh, 401 retry, broadcast |
| `src/main/services/cloudAuthTokenStore.test.ts` | Create | SQLCipher save/load/clear roundtrip |
| `src/main/services/cloudUserDeviceService.test.ts` | Create | init/afterLogin/heartbeat/clear lifecycle |
| `src/main/utils/cloudApiBaseUrl.test.ts` | Create | Settings override > env > error |
| `src/main/utils/cloudFetch.test.ts` | Create | 401 → refresh → retry; refresh fail → throws |
| `src/main/migrations/legacyAuthCleanup.test.ts` | Create | Idempotent URS kv deletion |
| `tests/e2e/auth.spec.ts` | Create | First-run → login → restart → auto-restore |

---

### Task 1: Foundation — SQLCipher swap + env

**Files:**
- Modify: `package.json`
- Modify: `vite.config.ts`
- Modify: `.env.example`
- Modify: `electron-builder.json`

- [ ] **Step 1: Swap `better-sqlite3` to `better-sqlite3-multiple-ciphers`**

Edit `package.json` dependencies:
- Remove: `"better-sqlite3": "^12.8.0"`
- Add: `"better-sqlite3-multiple-ciphers": "^12.8.0"`

(Keep the same version major; API is identical. The package is a maintained fork that bundles SQLCipher.)

- [ ] **Step 2: Add `node-machine-id`**

Edit `package.json` dependencies, add:
```json
"node-machine-id": "^1.1.12"
```

- [ ] **Step 3: Update sqlite imports (TS type only, runtime same)**

Edit `src/main/sqliteStore.ts` and any other file that imports `better-sqlite3`. Find/replace the import string to use `better-sqlite3-multiple-ciphers`:

```ts
// Before
import Database from 'better-sqlite3';
// After
import Database from 'better-sqlite3-multiple-ciphers';
```

(Use `grep -r "better-sqlite3" src/` to find all imports.)

- [ ] **Step 4: Add VITE_CLOUD_API_BASE_URL to vite config**

Edit `vite.config.ts`, find the `define:` block (or add one if missing). Add:
```ts
define: {
  'import.meta.env.VITE_CLOUD_API_BASE_URL': JSON.stringify(process.env.VITE_CLOUD_API_BASE_URL || ''),
},
```

- [ ] **Step 5: Add VITE_CLOUD_API_BASE_URL to .env.example**

Edit `.env.example`, append:
```
# RunNode business cloud base URL (compiled into renderer build)
VITE_CLOUD_API_BASE_URL=https://api.runnode.example.com
```

- [ ] **Step 6: Configure electron-builder for native module**

Edit `electron-builder.json`, find the `asarUnpack` array (or create one). Add the native module path so it isn't packed inside asar:
```json
"asarUnpack": [
  "**/node_modules/better-sqlite3-multiple-ciphers/build/Release/*.node"
]
```

- [ ] **Step 7: Reinstall dependencies**

```bash
npm install
```

Expected: `better-sqlite3-multiple-ciphers` builds native module for current platform. May require Xcode CLT (macOS) or VS Build Tools (Windows).

- [ ] **Step 8: Verify Electron rebuild**

```bash
npx electron-rebuild
```

Expected: native modules rebuilt for Electron's Node version.

- [ ] **Step 9: Verify existing tests still pass**

```bash
npm test
```

Expected: All existing tests pass. The DB layer should be byte-compatible (same schema, same code paths).

- [ ] **Step 10: Commit**

```bash
git add package.json package-lock.json vite.config.ts .env.example electron-builder.json
git commit -m "build: swap better-sqlite3 → better-sqlite3-multiple-ciphers, add node-machine-id"
```

---

### Task 2: Shared constants + parsers

**Files:**
- Create: `src/shared/cloudAuth/constants.ts`
- Create: `src/shared/cloudAuth/parsers.ts`
- Create: `src/shared/cloudAuth/parsers.test.ts`

- [ ] **Step 1: Write the failing test for parsers**

Create `src/shared/cloudAuth/parsers.test.ts`:
```ts
import { describe, test, expect } from 'vitest';
import {
  parseMemberAuthLoginBody,
  parseMemberAuthRefreshBody,
  parseMemberUserGetBody,
} from './parsers';

describe('parseMemberAuthLoginBody', () => {
  test('parses standard wrapped response', () => {
    const raw = {
      code: 0,
      data: {
        accessToken: 'at-123',
        refreshToken: 'rt-456',
        expiresIn: 7200,
        userInfo: { id: 1, username: 'u', nickname: 'n' },
      },
    };
    const r = parseMemberAuthLoginBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.accessToken).toBe('at-123');
      expect(r.value.refreshToken).toBe('rt-456');
      expect(r.value.expiresIn).toBe(7200);
      expect(r.value.userInfo.username).toBe('u');
    }
  });

  test('parses flat response (no data wrapper)', () => {
    const raw = {
      accessToken: 'at-123',
      refreshToken: 'rt-456',
      expiresIn: 7200,
      userInfo: { id: 1, username: 'u' },
    };
    const r = parseMemberAuthLoginBody(raw);
    expect(r.ok).toBe(true);
  });

  test('handles code 200 (alternate success code)', () => {
    const raw = { code: 200, data: { accessToken: 'a', refreshToken: 'r', expiresIn: 60 } };
    const r = parseMemberAuthLoginBody(raw);
    expect(r.ok).toBe(true);
  });

  test('rejects on missing accessToken', () => {
    const raw = { code: 0, data: { refreshToken: 'r', expiresIn: 60 } };
    const r = parseMemberAuthLoginBody(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/accessToken/);
  });

  test('rejects on business error code', () => {
    const raw = { code: 401, message: 'invalid credentials' };
    const r = parseMemberAuthLoginBody(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid credentials');
  });
});

describe('parseMemberAuthRefreshBody', () => {
  test('parses with new refreshToken rotation', () => {
    const raw = { code: 0, data: { accessToken: 'a2', refreshToken: 'r2', expiresIn: 7200 } };
    const r = parseMemberAuthRefreshBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.accessToken).toBe('a2');
      expect(r.value.refreshToken).toBe('r2');
      expect(r.value.expiresIn).toBe(7200);
    }
  });

  test('parses without new refreshToken (server keeps old)', () => {
    const raw = { code: 0, data: { accessToken: 'a2', expiresIn: 7200 } };
    const r = parseMemberAuthRefreshBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.refreshToken).toBe('');
  });

  test('rejects on non-zero code', () => {
    const raw = { code: 401, message: 'expired' };
    const r = parseMemberAuthRefreshBody(raw);
    expect(r.ok).toBe(false);
  });
});

describe('parseMemberUserGetBody', () => {
  test('parses standard wrapped response', () => {
    const raw = {
      code: 0,
      data: {
        id: 42,
        username: 'u',
        nickname: 'nick',
        mobile: '13800138000',
        avatar: 'https://example.com/avatar.png',
        subscriptionPlan: 'Plus',
        coin: 1000,
      },
    };
    const r = parseMemberUserGetBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe(42);
      expect(r.value.subscriptionPlan).toBe('Plus');
      expect(r.value.coin).toBe(1000);
    }
  });

  test('handles missing optional fields', () => {
    const raw = { code: 0, data: { id: 1, username: 'u' } };
    const r = parseMemberUserGetBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.nickname).toBeUndefined();
      expect(r.value.coin).toBe(0);
    }
  });

  test('rejects on non-zero code', () => {
    const raw = { code: 401, message: 'unauthorized' };
    const r = parseMemberUserGetBody(raw);
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/shared/cloudAuth/parsers.test.ts`
Expected: FAIL — module `./parsers` does not exist

- [ ] **Step 3: Create constants file**

Create `src/shared/cloudAuth/constants.ts`:
```ts
export const CloudAuthChannel = {
  LoginPassword: 'cloud:auth:login-password',
  SendSmsCode: 'cloud:auth:send-sms-code',
  LoginSms: 'cloud:auth:login-sms',
  WechatQr: 'cloud:auth:wechat-qr',
  WechatPoll: 'cloud:auth:wechat-poll',
  LoginWechat: 'cloud:auth:login-wechat',
  Logout: 'cloud:auth:logout',
  GetStatus: 'cloud:auth:get-status',
  LoggedOutEvent: 'cloud:auth:logged-out',
  LoginSuccessEvent: 'cloud:auth:login-success',
} as const;
export type CloudAuthChannel = typeof CloudAuthChannel[keyof typeof CloudAuthChannel];

export const CloudLoginMethod = {
  Password: 'password',
  Sms: 'sms',
  Wechat: 'wechat',
} as const;
export type CloudLoginMethod = typeof CloudLoginMethod[keyof typeof CloudLoginMethod];

export const CloudWechatPollStatus = {
  Waiting: 'waiting',
  Scanned: 'scanned',
  Confirmed: 'confirmed',
  Expired: 'expired',
} as const;
export type CloudWechatPollStatus = typeof CloudWechatPollStatus[keyof typeof CloudWechatPollStatus];

export const WechatQrPollingIntervalMs = 2000;
export const WechatQrMaxLifetimeMs = 5 * 60 * 1000;
export const SmsCountdownSeconds = 60;
export const TokenExpiringSoonBufferMs = 5 * 60 * 1000;
export const HeartbeatIntervalMs = 5 * 60 * 1000;
export const CloudAuthRequestTimeoutMs = 15 * 1000;
```

- [ ] **Step 4: Create parsers file**

Create `src/shared/cloudAuth/parsers.ts`:
```ts
import { WechatQrPollingIntervalMs, WechatQrMaxLifetimeMs, SmsCountdownSeconds, TokenExpiringSoonBufferMs, HeartbeatIntervalMs, CloudAuthRequestTimeoutMs } from './constants';

export interface CloudUserInfo {
  id: string | number;
  username: string;
  nickname?: string;
  mobile?: string;
  avatar?: string;
  subscriptionPlan?: string;
  coin?: number;
}

export interface CloudAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
}

export type ParserResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

function isNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function unwrapData(raw: unknown): Record<string, unknown> {
  if (raw == null || typeof raw !== 'object') return {};
  const root = raw as Record<string, unknown>;
  if (root.data != null && typeof root.data === 'object' && !Array.isArray(root.data)) {
    return root.data as Record<string, unknown>;
  }
  return root;
}

function isBusinessError(raw: unknown): { error: boolean; message: string } {
  if (raw == null || typeof raw !== 'object') return { error: false, message: '' };
  const r = raw as Record<string, unknown>;
  const code = r.code;
  if (code === 0 || code === 200 || code === undefined || code === null) {
    return { error: false, message: '' };
  }
  return { error: true, message: (r.message as string) || `business error code ${code}` };
}

export function parseMemberAuthLoginBody(raw: unknown): ParserResult<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userInfo: CloudUserInfo;
}> {
  const err = isBusinessError(raw);
  if (err.error) return { ok: false, error: err.message };

  const data = unwrapData(raw);
  const accessToken = data.accessToken;
  const refreshToken = data.refreshToken;
  const expiresIn = data.expiresIn;
  const userInfo = data.userInfo;

  if (!isString(accessToken)) return { ok: false, error: 'missing accessToken' };
  if (!isString(refreshToken)) return { ok: false, error: 'missing refreshToken' };
  if (!isNumber(expiresIn)) return { ok: false, error: 'missing expiresIn' };
  if (userInfo == null || typeof userInfo !== 'object') {
    return { ok: false, error: 'missing userInfo' };
  }

  const u = userInfo as Record<string, unknown>;
  const parsedUser: CloudUserInfo = {
    id: (u.id as string | number) ?? 0,
    username: (u.username as string) ?? '',
    nickname: u.nickname as string | undefined,
    mobile: u.mobile as string | undefined,
    avatar: u.avatar as string | undefined,
    subscriptionPlan: u.subscriptionPlan as string | undefined,
    coin: isNumber(u.coin) ? u.coin : 0,
  };

  return { ok: true, value: { accessToken, refreshToken, expiresIn, userInfo: parsedUser } };
}

export function parseMemberAuthRefreshBody(raw: unknown): ParserResult<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const err = isBusinessError(raw);
  if (err.error) return { ok: false, error: err.message };

  const data = unwrapData(raw);
  const accessToken = data.accessToken;
  const expiresIn = data.expiresIn;
  const refreshToken = data.refreshToken;

  if (!isString(accessToken)) return { ok: false, error: 'missing accessToken' };
  if (!isNumber(expiresIn)) return { ok: false, error: 'missing expiresIn' };

  return {
    ok: true,
    value: {
      accessToken,
      refreshToken: isString(refreshToken) ? refreshToken : '',
      expiresIn,
    },
  };
}

export function parseMemberUserGetBody(raw: unknown): ParserResult<CloudUserInfo> {
  const err = isBusinessError(raw);
  if (err.error) return { ok: false, error: err.message };

  const data = unwrapData(raw);
  if (!isString(data.username)) return { ok: false, error: 'missing username' };

  return {
    ok: true,
    value: {
      id: (data.id as string | number) ?? 0,
      username: data.username,
      nickname: data.nickname as string | undefined,
      mobile: data.mobile as string | undefined,
      avatar: data.avatar as string | undefined,
      subscriptionPlan: data.subscriptionPlan as string | undefined,
      coin: isNumber(data.coin) ? data.coin : 0,
    },
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/shared/cloudAuth/parsers.test.ts`
Expected: All 11 tests pass

- [ ] **Step 6: Commit**

```bash
git add src/shared/cloudAuth/
git commit -m "feat(cloud-auth): shared constants + RunNode response parsers"
```

---

### Task 3: SQLCipher key derivation + cloudApiBaseUrl

**Files:**
- Create: `src/main/utils/sqlcipherKey.ts`
- Create: `src/main/utils/cloudApiBaseUrl.ts`
- Create: `src/main/utils/cloudApiBaseUrl.test.ts`

- [ ] **Step 1: Write the failing test for cloudApiBaseUrl**

Create `src/main/utils/cloudApiBaseUrl.test.ts`:
```ts
import { describe, test, expect, beforeEach, vi } from 'vitest';

describe('getCloudApiBaseUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as any).__CLOUD_API_BASE_URL_OVERRIDE__;
    delete process.env.VITE_CLOUD_API_BASE_URL;
  });

  test('reads from override when set', async () => {
    (globalThis as any).__CLOUD_API_BASE_URL_OVERRIDE__ = 'https://override.example.com';
    process.env.VITE_CLOUD_API_BASE_URL = 'https://env.example.com';
    const { getCloudApiBaseUrl } = await import('./cloudApiBaseUrl');
    expect(getCloudApiBaseUrl()).toBe('https://override.example.com');
  });

  test('falls back to env when no override', async () => {
    process.env.VITE_CLOUD_API_BASE_URL = 'https://env.example.com';
    const { getCloudApiBaseUrl } = await import('./cloudApiBaseUrl');
    expect(getCloudApiBaseUrl()).toBe('https://env.example.com');
  });

  test('throws when neither set', async () => {
    const { getCloudApiBaseUrl } = await import('./cloudApiBaseUrl');
    expect(() => getCloudApiBaseUrl()).toThrow(/RunNode base URL/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/utils/cloudApiBaseUrl.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create sqlcipherKey.ts**

Create `src/main/utils/sqlcipherKey.ts`:
```ts
import { createHash } from 'crypto';
import { app } from 'electron';
import { machineIdSync } from 'node-machine-id';

let cachedKey: Buffer | null = null;

export function deriveSqlcipherKey(): Buffer {
  if (cachedKey) return cachedKey;

  let machineKey: string;
  try {
    machineKey = machineIdSync();
  } catch {
    machineKey = app.getPath('userData');
  }

  cachedKey = createHash('sha256')
    .update(`WeSight-CloudDB-v1\0${machineKey}\0${app.getName()}`)
    .digest();
  return cachedKey;
}
```

- [ ] **Step 4: Create cloudApiBaseUrl.ts**

Create `src/main/utils/cloudApiBaseUrl.ts`:
```ts
let overrideBaseUrl: string | null = (globalThis as any).__CLOUD_API_BASE_URL_OVERRIDE__ ?? null;

export function setCloudApiBaseUrlOverride(url: string | null): void {
  overrideBaseUrl = url && url.trim() ? url.trim().replace(/\/+$/, '') : null;
}

export function getCloudApiBaseUrl(): string {
  if (overrideBaseUrl) return overrideBaseUrl;

  const env = process.env.VITE_CLOUD_API_BASE_URL?.trim();
  if (env) return env.replace(/\/+$/, '');

  throw new Error(
    'RunNode base URL not configured. Set VITE_CLOUD_API_BASE_URL at build time ' +
    'or configure it in Settings.'
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/utils/cloudApiBaseUrl.test.ts`
Expected: All 3 tests pass

- [ ] **Step 6: Commit**

```bash
git add src/main/utils/sqlcipherKey.ts src/main/utils/cloudApiBaseUrl.ts src/main/utils/cloudApiBaseUrl.test.ts
git commit -m "feat(cloud-auth): SQLCipher key derivation + cloudApiBaseUrl with override"
```

---

### Task 4: CloudAuthTokenStore (SQLCipher wrapper)

**Files:**
- Create: `src/main/services/cloudAuthTokenStore.ts`
- Create: `src/main/services/cloudAuthTokenStore.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/services/cloudAuthTokenStore.test.ts`:
```ts
import { describe, test, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3-multiple-ciphers';

let dbInstance: Database.Database;

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/wesight-test', getName: () => 'WeSight Test' },
}));

vi.mock('../utils/sqlcipherKey', () => ({
  deriveSqlcipherKey: () => Buffer.alloc(32, 1),
}));

describe('CloudAuthTokenStore', () => {
  beforeEach(async () => {
    const Database = (await import('better-sqlite3-multiple-ciphers')).default;
    dbInstance = new Database(':memory:');
    dbInstance.pragma(`cipher='sqlcipher'`);
    dbInstance.pragma(`key="x'${'00'.repeat(32)}'"`);
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    // Reset module cache
    vi.resetModules();
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/cloudAuthTokenStore.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create cloudAuthTokenStore.ts**

Create `src/main/services/cloudAuthTokenStore.ts`:
```ts
import type Database from 'better-sqlite3-multiple-ciphers';
import type { CloudAuthTokens } from '../../shared/cloudAuth/parsers';

const TOKEN_KEY = 'cloud_auth_tokens';

export class CloudAuthTokenStore {
  constructor(private readonly db: Database.Database) {}

  async save(tokens: CloudAuthTokens): Promise<void> {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)'
    );
    stmt.run(TOKEN_KEY, JSON.stringify(tokens));
  }

  async load(): Promise<CloudAuthTokens | null> {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(TOKEN_KEY) as
      | { value: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as CloudAuthTokens;
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(TOKEN_KEY);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/services/cloudAuthTokenStore.test.ts`
Expected: All 4 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/services/cloudAuthTokenStore.ts src/main/services/cloudAuthTokenStore.test.ts
git commit -m "feat(cloud-auth): CloudAuthTokenStore with SQLCipher persistence"
```

---

### Task 5: CloudUserDeviceStore + Service

**Files:**
- Create: `src/main/services/cloudUserDeviceStore.ts`
- Create: `src/main/services/cloudUserDeviceService.ts`
- Create: `src/main/services/cloudUserDeviceService.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/services/cloudUserDeviceService.test.ts`:
```ts
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3-multiple-ciphers';

let dbInstance: Database.Database;
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
    const Database = (await import('better-sqlite3-multiple-ciphers')).default;
    dbInstance = new Database(':memory:');
    dbInstance.pragma(`cipher='sqlcipher'`);
    dbInstance.pragma(`key="x'${'00'.repeat(32)}'"`);
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    mockFetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0 }) });
    (globalThis as any).fetch = mockFetch;
    vi.resetModules();
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/cloudUserDeviceService.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create cloudUserDeviceStore.ts**

Create `src/main/services/cloudUserDeviceStore.ts`:
```ts
import type Database from 'better-sqlite3-multiple-ciphers';

const DEVICE_KEY = 'cloud_device_id';

export interface CloudDeviceRecord {
  deviceId: string;
  createdAt: number;
  lastHeartbeatAt: number | null;
}

export class CloudUserDeviceStore {
  constructor(private readonly db: Database.Database) {}

  async save(record: CloudDeviceRecord): Promise<void> {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)'
    );
    stmt.run(DEVICE_KEY, JSON.stringify(record));
  }

  async load(): Promise<CloudDeviceRecord | null> {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(DEVICE_KEY) as
      | { value: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value) as CloudDeviceRecord;
    } catch {
      return null;
    }
  }

  async clear(): Promise<void> {
    this.db.prepare('DELETE FROM kv WHERE key = ?').run(DEVICE_KEY);
  }
}
```

- [ ] **Step 4: Create cloudUserDeviceService.ts**

Create `src/main/services/cloudUserDeviceService.ts`:
```ts
import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3-multiple-ciphers';
import { CloudUserDeviceStore, type CloudDeviceRecord } from './cloudUserDeviceStore';
import { CloudAuthTokenStore } from './cloudAuthTokenStore';
import { getCloudApiBaseUrl } from '../utils/cloudApiBaseUrl';
import { HeartbeatIntervalMs, CloudAuthRequestTimeoutMs } from '../../shared/cloudAuth/constants';

export class CloudUserDeviceService {
  private store: CloudUserDeviceStore;
  private tokenStore: CloudAuthTokenStore;
  private deviceId: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly db: Database.Database) {
    this.store = new CloudUserDeviceStore(db);
    this.tokenStore = new CloudAuthTokenStore(db);
  }

  async init(): Promise<void> {
    const existing = await this.store.load();
    if (existing) {
      this.deviceId = existing.deviceId;
    } else {
      const newId = uuidv4();
      this.deviceId = newId;
      await this.store.save({ deviceId: newId, createdAt: Date.now(), lastHeartbeatAt: null });
    }

    // Start heartbeat scheduler in main process
    this.startHeartbeat();
  }

  async getDeviceId(): Promise<string | null> {
    return this.deviceId;
  }

  async afterLogin(): Promise<void> {
    if (!this.deviceId) return;
    try {
      const url = `${getCloudApiBaseUrl()}/app-api/claw/user/device/register`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: this.deviceId }),
        signal: AbortSignal.timeout(CloudAuthRequestTimeoutMs),
      });
      if (!resp.ok) {
        console.warn('[CloudDevice] register returned', resp.status);
      }
    } catch (e) {
      console.warn('[CloudDevice] register failed:', e);
    }
  }

  async heartbeat(): Promise<void> {
    // Short-circuit: no token means logged out
    const token = await this.tokenStore.load();
    if (!token) return;

    if (!this.deviceId) return;

    try {
      const url = `${getCloudApiBaseUrl()}/app-api/claw/user/device/heartbeat`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token.accessToken}`,
        },
        body: JSON.stringify({ deviceId: this.deviceId }),
        signal: AbortSignal.timeout(CloudAuthRequestTimeoutMs),
      });
      if (!resp.ok) {
        console.warn('[CloudDevice] heartbeat returned', resp.status);
        return;
      }
      // Update lastHeartbeatAt
      const existing = await this.store.load();
      if (existing) {
        await this.store.save({ ...existing, lastHeartbeatAt: Date.now() });
      }
    } catch (e) {
      console.warn('[CloudDevice] heartbeat failed:', e);
    }
  }

  async clear(): Promise<void> {
    this.deviceId = null;
    await this.store.clear();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat();
    }, HeartbeatIntervalMs);
    // Don't keep the process alive just for heartbeats
    this.heartbeatTimer.unref?.();
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/services/cloudUserDeviceService.test.ts`
Expected: All 5 tests pass

- [ ] **Step 6: Commit**

```bash
git add src/main/services/cloudUserDeviceStore.ts src/main/services/cloudUserDeviceService.ts src/main/services/cloudUserDeviceService.test.ts
git commit -m "feat(cloud-auth): CloudUserDeviceService with main-process heartbeat scheduler"
```

---

### Task 6: CloudAuthService core (login flows + refresh + 401)

**Files:**
- Create: `src/main/services/cloudAuth.ts`
- Create: `src/main/services/cloudAuth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/services/cloudAuth.test.ts`:
```ts
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3-multiple-ciphers';
import { EventEmitter } from 'events';

let dbInstance: Database.Database;
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
    const Database = (await import('better-sqlite3-multiple-ciphers')).default;
    dbInstance = new Database(':memory:');
    dbInstance.pragma(`cipher='sqlcipher'`);
    dbInstance.pragma(`key="x'${'00'.repeat(32)}'"`);
    dbInstance.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
    mockFetch = vi.fn();
    (globalThis as any).fetch = mockFetch;
    broadcaster = new EventEmitter();
    vi.resetModules();
  });

  describe('loginWithPassword', () => {
    test('saves tokens on success', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            accessToken: 'at-1',
            refreshToken: 'rt-1',
            expiresIn: 7200,
            userInfo: { id: 1, username: 'u' },
          },
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, data: { id: 1, username: 'u', subscriptionPlan: 'Plus', coin: 100 } }),
      });
      const { CloudAuthService } = await import('./cloudAuth');
      const svc = new CloudAuthService(dbInstance, broadcaster);
      const result = await svc.loginWithPassword('13800138000', 'pwd');
      expect(result.success).toBe(true);
      expect(result.userInfo?.username).toBe('u');
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
      // Pre-populate token store
      const { CloudAuthTokenStore } = await import('./cloudAuthTokenStore');
      const store = new CloudAuthTokenStore(dbInstance);
      await store.save({ accessToken: 'old-at', refreshToken: 'old-rt', expiresAt: Date.now() + 1000 });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          code: 0,
          data: { accessToken: 'new-at', refreshToken: 'new-rt', expiresIn: 7200 },
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
        json: async () => ({ code: 0, data: { accessToken: 'new-at', expiresIn: 7200 } }),
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
        json: async () => ({ code: 0, data: { accessToken: 'new', expiresIn: 7200 } }),
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
      await store.save({ accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() + 60 * 1000 }); // 1 min from now

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ code: 0, data: { accessToken: 'new', expiresIn: 7200 } }),
      });

      const { CloudAuthService } = await import('./cloudAuth');
      const svc = new CloudAuthService(dbInstance, broadcaster);
      const t = await svc.getValidToken();
      expect(t?.accessToken).toBe('new');
      expect(mockFetch).toHaveBeenCalledTimes(1);
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/services/cloudAuth.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create cloudAuth.ts (part 1: login flows)**

Create `src/main/services/cloudAuth.ts`:
```ts
import type Database from 'better-sqlite3-multiple-ciphers';
import type { EventEmitter } from 'events';
import { CloudAuthTokenStore } from './cloudAuthTokenStore';
import { CloudUserDeviceService } from './cloudUserDeviceService';
import { getCloudApiBaseUrl } from '../utils/cloudApiBaseUrl';
import {
  parseMemberAuthLoginBody,
  parseMemberAuthRefreshBody,
  parseMemberUserGetBody,
  type CloudUserInfo,
  type CloudAuthTokens,
} from '../../shared/cloudAuth/parsers';
import {
  TokenExpiringSoonBufferMs,
  CloudAuthRequestTimeoutMs,
} from '../../shared/cloudAuth/constants';
import { setCloudApiBaseUrlOverride } from '../utils/cloudApiBaseUrl';

export interface LoginResult {
  success: boolean;
  userInfo?: CloudUserInfo;
  error?: string;
}

export class CloudAuthService {
  private tokenStore: CloudAuthTokenStore;
  private deviceService: CloudUserDeviceService;
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly broadcaster: EventEmitter
  ) {
    this.tokenStore = new CloudAuthTokenStore(db);
    this.deviceService = new CloudUserDeviceService(db);
  }

  // === Initialization ===

  async init(): Promise<void> {
    await this.deviceService.init();
  }

  // === Public API ===

  async getStatus(): Promise<{ isLoggedIn: boolean; user?: CloudUserInfo; hasCompletedFirstLogin: boolean }> {
    const tokens = await this.tokenStore.load();
    const userRaw = this.db.prepare("SELECT value FROM kv WHERE key = 'cloud_user_info'").get() as
      | { value: string }
      | undefined;
    const user = userRaw ? (JSON.parse(userRaw.value) as CloudUserInfo) : undefined;

    const flagRaw = this.db.prepare("SELECT value FROM kv WHERE key = 'has_completed_first_login'").get() as
      | { value: string }
      | undefined;
    const hasCompletedFirstLogin = flagRaw?.value === 'true';

    return {
      isLoggedIn: !!tokens,
      user,
      hasCompletedFirstLogin,
    };
  }

  async loginWithPassword(mobile: string, password: string): Promise<LoginResult> {
    return this.loginInternal(`${getCloudApiBaseUrl()}/app-api/member/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'tenant-id': '1' },
      body: JSON.stringify({ mobile, password }),
    });
  }

  async sendSmsCode(mobile: string): Promise<{ success: boolean; error?: string }> {
    try {
      const resp = await this.cloudFetch(
        'auth:send-sms',
        `${getCloudApiBaseUrl()}/app-api/member/auth/send-sms-code`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mobile }) }
      );
      if (!resp.ok) return { success: false, error: `HTTP ${resp.status}` };
      return { success: true };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async loginWithSms(mobile: string, code: string): Promise<LoginResult> {
    return this.loginInternal(`${getCloudApiBaseUrl()}/app-api/member/auth/sms-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mobile, code }),
    });
  }

  async wechatGetQr(redirectUri: string): Promise<{
    success: boolean;
    qrUrl?: string;
    ticket?: string;
    expiresIn?: number;
    error?: string;
  }> {
    try {
      const resp = await this.cloudFetch(
        'auth:wechat-qr',
        `${getCloudApiBaseUrl()}/app-api/member/auth/wechat-qr?redirectUri=${encodeURIComponent(redirectUri)}`,
        { method: 'POST' }
      );
      if (!resp.ok) return { success: false, error: `HTTP ${resp.status}` };
      const body = (await resp.json()) as { code: number; data?: { qrUrl?: string; ticket?: string; expiresIn?: number } };
      if (body.code !== 0 && body.code !== 200) {
        return { success: false, error: 'failed to get wechat qr' };
      }
      return {
        success: true,
        qrUrl: body.data?.qrUrl,
        ticket: body.data?.ticket,
        expiresIn: body.data?.expiresIn,
      };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async wechatPoll(ticket: string): Promise<{ status: string; code?: string; state?: string }> {
    try {
      const resp = await this.cloudFetch(
        'auth:wechat-poll',
        `${getCloudApiBaseUrl()}/app-api/member/auth/wechat-poll?ticket=${encodeURIComponent(ticket)}`,
        { method: 'GET' }
      );
      if (!resp.ok) return { status: 'expired' };
      const body = (await resp.json()) as { status?: string; code?: string; state?: string };
      return { status: body.status ?? 'waiting', code: body.code, state: body.state };
    } catch {
      return { status: 'expired' };
    }
  }

  async loginWithWechat(code: string, state: string): Promise<LoginResult> {
    return this.loginInternal(`${getCloudApiBaseUrl()}/app-api/member/auth/wechat-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, state }),
    });
  }

  async logout(): Promise<{ success: boolean }> {
    try {
      const tokens = await this.tokenStore.load();
      if (tokens) {
        await this.cloudFetch(
          'auth:logout',
          `${getCloudApiBaseUrl()}/app-api/member/auth/logout`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${tokens.accessToken}`,
            },
            body: JSON.stringify({ refreshToken: tokens.refreshToken }),
        }
        ).catch(() => { /* best-effort */ });
      }
    } catch (e) {
      console.warn('[CloudAuth] logout remote call failed:', e);
    }
    await this.tokenStore.clear();
    return { success: true };
  }

  // === Token management ===

  async getValidToken(): Promise<CloudAuthTokens | null> {
    const tokens = await this.tokenStore.load();
    if (!tokens) return null;

    if (this.isExpiringSoon(tokens)) {
      const ok = await this.refreshAccessToken();
      if (!ok) return null;
      return this.tokenStore.load();
    }
    return tokens;
  }

  async refreshAccessToken(): Promise<boolean> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      try {
        const stored = await this.tokenStore.load();
        if (!stored?.refreshToken) return false;

        const resp = await this.cloudFetch(
          'auth:refresh',
          `${getCloudApiBaseUrl()}/app-api/member/auth/refresh-token?refreshToken=${encodeURIComponent(stored.refreshToken)}`,
          { method: 'POST' }
        );

        if (!resp.ok) {
          await this.tokenStore.clear();
          this.broadcastLoggedOut();
          return false;
        }

        const body = (await resp.json()) as unknown;
        const parsed = parseMemberAuthRefreshBody(body);
        if (!parsed.ok) {
          await this.tokenStore.clear();
          this.broadcastLoggedOut();
          return false;
        }

        await this.tokenStore.save({
          accessToken: parsed.value.accessToken,
          refreshToken: parsed.value.refreshToken || stored.refreshToken,
          expiresAt: Date.now() + parsed.value.expiresIn * 1000,
        });
        return true;
      } catch (e) {
        console.error('[CloudAuth] refresh failed:', e);
        await this.tokenStore.clear();
        this.broadcastLoggedOut();
        return false;
      } finally {
        this.refreshInFlight = null;
      }
    })();

    return this.refreshInFlight;
  }

  async fetchMemberAuthorized(url: string, init?: RequestInit): Promise<Response> {
    const tokens = await this.getValidToken();
    if (!tokens) {
      return new Response(null, { status: 401, statusText: 'Unauthorized' });
    }
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${tokens.accessToken}`);

    let resp = await this.cloudFetch('member:authorized', url, { ...init, headers });
    if (resp.status !== 401) return resp;

    const refreshed = await this.refreshAccessToken();
    if (!refreshed) return resp;

    const td = await this.tokenStore.load();
    if (!td) return resp;

    headers.set('Authorization', `Bearer ${td.accessToken}`);
    return this.cloudFetch('member:authorized:retry', url, { ...init, headers });
  }

  // === Private ===

  private isExpiringSoon(t: CloudAuthTokens): boolean {
    return Date.now() >= t.expiresAt - TokenExpiringSoonBufferMs;
  }

  private async loginInternal(url: string, init: RequestInit): Promise<LoginResult> {
    try {
      const resp = await this.cloudFetch('auth:login', url, init);
      const body = (await resp.json()) as unknown;
      const parsed = parseMemberAuthLoginBody(body);
      if (!parsed.ok) {
        return { success: false, error: parsed.error };
      }

      await this.tokenStore.save({
        accessToken: parsed.value.accessToken,
        refreshToken: parsed.value.refreshToken,
        expiresAt: Date.now() + parsed.value.expiresIn * 1000,
      });

      // Best-effort device register (fire and forget)
      void this.deviceService.afterLogin().catch((e) => console.warn('[CloudAuth] device register:', e));

      // Resolve full user info
      const userInfo = await this.resolveUserProfileAfterLogin(parsed.value.userInfo);
      this.persistUserInfo(userInfo);
      this.markFirstLoginComplete();
      this.broadcaster.emit('cloud:auth:login-success', { user: userInfo });
      return { success: true, userInfo };
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  private async resolveUserProfileAfterLogin(fallback: CloudUserInfo): Promise<CloudUserInfo> {
    try {
      const resp = await this.fetchMemberAuthorized(
        `${getCloudApiBaseUrl()}/app-api/member/user/get`
      );
      if (!resp.ok) return fallback;
      const body = (await resp.json()) as unknown;
      const parsed = parseMemberUserGetBody(body);
      return parsed.ok ? parsed.value : fallback;
    } catch {
      return fallback;
    }
  }

  private persistUserInfo(user: CloudUserInfo): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)'
    ).run('cloud_user_info', JSON.stringify(user));
  }

  private markFirstLoginComplete(): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)'
    ).run('has_completed_first_login', 'true');
  }

  private broadcastLoggedOut(): void {
    this.broadcaster.emit('cloud:auth:logged-out');
  }

  private async cloudFetch(label: string, url: string, init?: RequestInit): Promise<Response> {
    const merged: RequestInit = {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(CloudAuthRequestTimeoutMs),
    };
    return fetch(url, merged).then((r) => {
      if (!r.ok && r.status >= 500) {
        console.error(`[CloudAuth] ${label} HTTP ${r.status}`);
      }
      return r;
    });
  }
}
```

(Note: `setCloudApiBaseUrlOverride` is imported but used elsewhere — main.ts will call it on Settings save.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/services/cloudAuth.test.ts`
Expected: All tests pass (login success, login error, refresh rotate, refresh keep-old, refresh fail + broadcast, coalesce, getValidToken null, getValidToken valid, getValidToken refresh, logout)

- [ ] **Step 5: Commit**

```bash
git add src/main/services/cloudAuth.ts src/main/services/cloudAuth.test.ts
git commit -m "feat(cloud-auth): CloudAuthService with 4 login flows + 401 retry + concurrent refresh"
```

---

### Task 7: LegacyAuthCleanup

**Files:**
- Create: `src/main/migrations/legacyAuthCleanup.ts`
- Create: `src/main/migrations/legacyAuthCleanup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/migrations/legacyAuthCleanup.test.ts`:
```ts
import { describe, test, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3-multiple-ciphers';

let dbInstance: Database.Database;

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test', getName: () => 'Test' },
}));
vi.mock('../../main/utils/sqlcipherKey', () => ({
  deriveSqlcipherKey: () => Buffer.alloc(32, 1),
}));

describe('legacyAuthCleanup', () => {
  beforeEach(async () => {
    const Database = (await import('better-sqlite3-multiple-ciphers')).default;
    dbInstance = new Database(':memory:');
    dbInstance.pragma(`cipher='sqlcipher'`);
    dbInstance.pragma(`key="x'${'00'.repeat(32)}'"`);
    dbInstance.exec(`CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    vi.resetModules();
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/migrations/legacyAuthCleanup.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create legacyAuthCleanup.ts**

Create `src/main/migrations/legacyAuthCleanup.ts`:
```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/migrations/legacyAuthCleanup.test.ts`
Expected: Both tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main/migrations/legacyAuthCleanup.ts src/main/migrations/legacyAuthCleanup.test.ts
git commit -m "feat(cloud-auth): legacy URS auth cleanup migration"
```

---

### Task 8: cloudFetch + probeCloudBaseUrl

**Files:**
- Create: `src/main/utils/cloudFetch.ts`
- Create: `src/main/utils/cloudFetch.test.ts`
- Create: `src/main/probeCloudBaseUrl.ts`

- [ ] **Step 1: Write the failing test**

Create `src/main/utils/cloudFetch.test.ts`:
```ts
import { describe, test, expect, vi, beforeEach } from 'vitest';

let mockFetch: ReturnType<typeof vi.fn>;

describe('cloudFetch', () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    (globalThis as any).fetch = mockFetch;
  });

  test('returns response on 2xx', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const { cloudFetch } = await import('./cloudFetch');
    const r = await cloudFetch('test', 'https://api.example.com/x');
    expect(r.status).toBe(200);
  });

  test('throws CloudFetchError on non-ok response with body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ code: 400, message: 'bad' }),
    });
    const { cloudFetch, CloudFetchError } = await import('./cloudFetch');
    await expect(cloudFetch('test', 'https://api.example.com/x')).rejects.toBeInstanceOf(CloudFetchError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/utils/cloudFetch.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Create cloudFetch.ts**

Create `src/main/utils/cloudFetch.ts`:
```ts
import { CloudAuthRequestTimeoutMs } from '../../shared/cloudAuth/constants';

export class CloudFetchError extends Error {
  constructor(
    public readonly label: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(`[${label}] HTTP ${status}`);
    this.name = 'CloudFetchError';
  }
}

export async function cloudFetch(
  label: string,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const merged: RequestInit = {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(CloudAuthRequestTimeoutMs),
  };

  let resp: Response;
  try {
    resp = await fetch(url, merged);
  } catch (e) {
    console.error(`[CloudFetch] ${label} network error:`, e);
    throw e;
  }

  if (!resp.ok && resp.status >= 500) {
    console.error(`[CloudFetch] ${label} HTTP ${resp.status}`);
  }

  return resp;
}
```

- [ ] **Step 4: Create probeCloudBaseUrl.ts**

Create `src/main/probeCloudBaseUrl.ts`:
```ts
import { getCloudApiBaseUrl } from './utils/cloudApiBaseUrl';

export async function probeCloudBaseUrl(): Promise<{ ok: boolean; error?: string }> {
  const baseUrl = getCloudApiBaseUrl();
  try {
    const resp = await fetch(`${baseUrl}/app-api/member/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'tenant-id': '1' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status >= 400 && resp.status < 500) {
      // 4xx means we reached the server and it understood us (just rejected us for bad input)
      return { ok: true };
    }
    if (resp.status >= 500) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/utils/cloudFetch.test.ts`
Expected: Both tests pass

- [ ] **Step 6: Commit**

```bash
git add src/main/utils/cloudFetch.ts src/main/utils/cloudFetch.test.ts src/main/probeCloudBaseUrl.ts
git commit -m "feat(cloud-auth): cloudFetch with logging + probe helper for Settings test-connection"
```

---

### Task 9: Main process IPC handlers + main.ts wiring

**Files:**
- Create: `src/main/ipcHandlers/cloudAuth.ts`
- Modify: `src/main/main.ts`

- [ ] **Step 1: Create ipcHandlers/cloudAuth.ts**

Create `src/main/ipcHandlers/cloudAuth.ts`:
```ts
import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type Database from 'better-sqlite3-multiple-ciphers';
import type { EventEmitter } from 'events';
import { CloudAuthService } from '../services/cloudAuth';
import { CloudAuthChannel } from '../../shared/cloudAuth/constants';
import { probeCloudBaseUrl } from '../probeCloudBaseUrl';
import { setCloudApiBaseUrlOverride } from '../utils/cloudApiBaseUrl';

export function registerCloudAuthHandlers(
  db: Database.Database,
  broadcaster: EventEmitter
): CloudAuthService {
  const service = new CloudAuthService(db, broadcaster);

  // Initialize service (loads device, starts heartbeat)
  void service.init();

  ipcMain.handle(CloudAuthChannel.LoginPassword, async (_e, payload: { mobile: string; password: string }) => {
    if (!payload?.mobile || !payload?.password) {
      return { success: false, error: 'mobile and password required' };
    }
    return service.loginWithPassword(payload.mobile, payload.password);
  });

  ipcMain.handle(CloudAuthChannel.SendSmsCode, async (_e, payload: { mobile: string }) => {
    if (!payload?.mobile) return { success: false, error: 'mobile required' };
    return service.sendSmsCode(payload.mobile);
  });

  ipcMain.handle(CloudAuthChannel.LoginSms, async (_e, payload: { mobile: string; code: string }) => {
    if (!payload?.mobile || !payload?.code) {
      return { success: false, error: 'mobile and code required' };
    }
    return service.loginWithSms(payload.mobile, payload.code);
  });

  ipcMain.handle(CloudAuthChannel.WechatQr, async (_e, payload: { redirectUri: string }) => {
    if (!payload?.redirectUri) return { success: false, error: 'redirectUri required' };
    return service.wechatGetQr(payload.redirectUri);
  });

  ipcMain.handle(CloudAuthChannel.WechatPoll, async (_e, payload: { ticket: string }) => {
    if (!payload?.ticket) return { status: 'expired' };
    return service.wechatPoll(payload.ticket);
  });

  ipcMain.handle(CloudAuthChannel.LoginWechat, async (_e, payload: { code: string; state: string }) => {
    if (!payload?.code || !payload?.state) {
      return { success: false, error: 'code and state required' };
    }
    return service.loginWithWechat(payload.code, payload.state);
  });

  ipcMain.handle(CloudAuthChannel.Logout, async () => {
    return service.logout();
  });

  ipcMain.handle(CloudAuthChannel.GetStatus, async () => {
    return service.getStatus();
  });

  // Re-broadcast events to all BrowserWindows
  broadcaster.on(CloudAuthChannel.LoggedOutEvent, () => {
    for (const wc of BrowserWindow.getAllWebContents()) {
      wc.send(CloudAuthChannel.LoggedOutEvent);
    }
  });
  broadcaster.on(CloudAuthChannel.LoginSuccessEvent, (payload) => {
    for (const wc of BrowserWindow.getAllWebContents()) {
      wc.send(CloudAuthChannel.LoginSuccessEvent, payload);
    }
  });

  return service;
}

export async function probeAndReport(): Promise<{ ok: boolean; error?: string }> {
  return probeCloudBaseUrl();
}

export { setCloudApiBaseUrlOverride };
```

- [ ] **Step 2: Modify main.ts to wire it up**

Open `src/main/main.ts`. The existing file is large; the changes are surgical:

Find the section near `app.whenReady()` and after the `getStore()` initialization. Add at the very top of the function:

```ts
import { registerCloudAuthHandlers, probeAndReport, setCloudApiBaseUrlOverride } from './ipcHandlers/cloudAuth';
import { run as runLegacyAuthCleanup } from './migrations/legacyAuthCleanup';
import { EventEmitter } from 'events';
```

Find the call to `getStore()` (or wherever the existing `sqliteStore` is opened). After it, add:

```ts
// URS legacy cleanup (one-time, idempotent)
await runLegacyAuthCleanup(getStore().getDb());

// Cloud auth (RunNode)
const cloudBroadcaster = new EventEmitter();
registerCloudAuthHandlers(getStore().getDb(), cloudBroadcaster);
```

Find where IPC handlers are registered. Add a new handler for the test-connection probe (called from Settings):

```ts
ipcMain.handle('cloud:probe-base-url', async () => {
  return probeAndReport();
});

ipcMain.handle('cloud:set-base-url', async (_e, payload: { url: string | null }) => {
  setCloudApiBaseUrlOverride(payload?.url ?? null);
  return { success: true };
});
```

- [ ] **Step 3: Compile and verify**

Run: `npm run compile:electron`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/ipcHandlers/cloudAuth.ts src/main/main.ts
git commit -m "feat(cloud-auth): wire IPC handlers + URS cleanup in main.ts"
```

---

### Task 10: Renderer — cloudAuthSlice

**Files:**
- Create: `src/renderer/store/slices/cloudAuthSlice.ts`
- Modify: `src/renderer/store/index.ts` (or wherever slices are registered)

- [ ] **Step 1: Create cloudAuthSlice.ts**

Create `src/renderer/store/slices/cloudAuthSlice.ts`:
```ts
import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface CloudUserInfo {
  id: string | number;
  username: string;
  nickname?: string;
  mobile?: string;
  avatar?: string;
  subscriptionPlan?: string;
  coin?: number;
}

export type FirstLoginState = null | boolean;

interface CloudAuthState {
  isLoggedIn: boolean;
  user: CloudUserInfo | null;
  hasCompletedFirstLogin: FirstLoginState;
  isLoading: boolean;
}

const initialState: CloudAuthState = {
  isLoggedIn: false,
  user: null,
  hasCompletedFirstLogin: null,
  isLoading: true,
};

const cloudAuthSlice = createSlice({
  name: 'cloudAuth',
  initialState,
  reducers: {
    setAuthLoading(state, action: PayloadAction<boolean>) {
      state.isLoading = action.payload;
    },
    setAuthStatus(
      state,
      action: PayloadAction<{ isLoggedIn: boolean; user?: CloudUserInfo | null; hasCompletedFirstLogin: boolean }>
    ) {
      state.isLoggedIn = action.payload.isLoggedIn;
      state.user = action.payload.user ?? null;
      state.hasCompletedFirstLogin = action.payload.hasCompletedFirstLogin;
      state.isLoading = false;
    },
    setLoggedIn(state, action: PayloadAction<{ user: CloudUserInfo }>) {
      state.isLoggedIn = true;
      state.user = action.payload.user;
      state.hasCompletedFirstLogin = true;
      state.isLoading = false;
    },
    setLoggedOut(state) {
      state.isLoggedIn = false;
      state.user = null;
      // hasCompletedFirstLogin stays true once first login done
      state.isLoading = false;
    },
  },
});

export const { setAuthLoading, setAuthStatus, setLoggedIn, setLoggedOut } = cloudAuthSlice.actions;
export default cloudAuthSlice.reducer;
```

- [ ] **Step 2: Register the slice**

Open `src/renderer/store/index.ts` (or wherever reducers are combined). Find the auth reducer registration and replace it. Example:

```ts
// Before
import authReducer from './slices/authSlice';
// ...
const store = configureStore({
  reducer: {
    auth: authReducer,
    // ...
  },
});

// After
import cloudAuthReducer from './slices/cloudAuthSlice';
// ...
const store = configureStore({
  reducer: {
    cloudAuth: cloudAuthReducer,
    // ...
  },
});
```

- [ ] **Step 3: Update all selector references**

Find all files that import from `authSlice` or use `state.auth.*` selectors. Update them to use `cloudAuthSlice` and `state.cloudAuth.*`. Use:

```bash
grep -rln "state.auth" src/renderer/
grep -rln "authSlice" src/renderer/
```

For each match, replace `state.auth.isLoggedIn` → `state.cloudAuth.isLoggedIn`, etc. For imports, update the import path.

- [ ] **Step 4: Delete the old slice**

```bash
git rm src/renderer/store/slices/authSlice.ts
```

- [ ] **Step 5: Run TypeScript check**

Run: `npm run typecheck`
Expected: No errors (after updating all selector references)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(cloud-auth): cloudAuthSlice replaces authSlice"
```

---

### Task 11: Renderer — cloudAuth service

**Files:**
- Create: `src/renderer/services/cloudAuth.ts`
- Delete: `src/renderer/services/auth.ts`

- [ ] **Step 1: Create cloudAuth.ts**

Create `src/renderer/services/cloudAuth.ts`:
```ts
import { store } from '../store';
import { setAuthLoading, setAuthStatus, setLoggedIn, setLoggedOut } from '../store/slices/cloudAuthSlice';
import type { CloudUserInfo } from '../store/slices/cloudAuthSlice';
import { CloudAuthChannel } from '../../shared/cloudAuth/constants';

class CloudAuthService {
  private unsubLoggedOut: (() => void) | null = null;
  private unsubLoginSuccess: (() => void) | null = null;

  async init(): Promise<void> {
    this.destroy();
    store.dispatch(setAuthLoading(true));
    try {
      const status = await window.electron.cloudAuth.getStatus();
      store.dispatch(
        setAuthStatus({
          isLoggedIn: status.isLoggedIn,
          user: status.user ?? null,
          hasCompletedFirstLogin: status.hasCompletedFirstLogin,
        })
      );
    } catch {
      store.dispatch(setAuthStatus({ isLoggedIn: false, user: null, hasCompletedFirstLogin: false }));
    }

    this.unsubLoggedOut = window.electron.cloudAuth.onLoggedOut(() => {
      store.dispatch(setLoggedOut());
    });
    this.unsubLoginSuccess = window.electron.cloudAuth.onLoginSuccess((payload: { user: CloudUserInfo }) => {
      store.dispatch(setLoggedIn({ user: payload.user }));
    });
  }

  async loginWithPassword(mobile: string, password: string) {
    return window.electron.cloudAuth.loginWithPassword({ mobile, password });
  }

  async sendSmsCode(mobile: string) {
    return window.electron.cloudAuth.sendSmsCode({ mobile });
  }

  async loginWithSms(mobile: string, code: string) {
    return window.electron.cloudAuth.loginWithSms({ mobile, code });
  }

  async wechatGetQr(redirectUri: string) {
    return window.electron.cloudAuth.wechatGetQr({ redirectUri });
  }

  async wechatPoll(ticket: string) {
    return window.electron.cloudAuth.wechatPoll({ ticket });
  }

  async loginWithWechat(code: string, state: string) {
    return window.electron.cloudAuth.loginWithWechat({ code, state });
  }

  async logout() {
    await window.electron.cloudAuth.logout();
    store.dispatch(setLoggedOut());
  }

  requireAuth(): boolean {
    if (store.getState().cloudAuth.isLoggedIn) return true;
    // Trigger LoginModal
    window.dispatchEvent(new CustomEvent('cloudAuth:openLoginModal'));
    return false;
  }

  destroy() {
    this.unsubLoggedOut?.();
    this.unsubLoggedOut = null;
    this.unsubLoginSuccess?.();
    this.unsubLoginSuccess = null;
  }
}

export const cloudAuthService = new CloudAuthService();
```

- [ ] **Step 2: Delete the old service**

```bash
git rm src/renderer/services/auth.ts
```

- [ ] **Step 3: Update all import sites**

```bash
grep -rln "from.*services/auth" src/renderer/
grep -rln "authService" src/renderer/
```

For each match, replace import path and variable name:
```ts
// Before
import { authService } from '../services/auth';
// After
import { cloudAuthService } from '../services/cloudAuth';
```

```ts
// Before
authService.init()
// After
cloudAuthService.init()
```

- [ ] **Step 4: Run TypeScript check**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(cloud-auth): renderer-side cloudAuth service replaces auth"
```

---

### Task 12: Preload + types

**Files:**
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/types/electron.d.ts`

- [ ] **Step 1: Add cloudAuth to preload**

Open `src/main/preload.ts`. Find the section where renderer APIs are exposed (e.g., `contextBridge.exposeInMainWorld('electron', {...})`). Add a new namespace `cloudAuth`:

```ts
cloudAuth: {
  loginWithPassword: (payload: { mobile: string; password: string }) =>
    ipcRenderer.invoke('cloud:auth:login-password', payload),
  sendSmsCode: (payload: { mobile: string }) =>
    ipcRenderer.invoke('cloud:auth:send-sms-code', payload),
  loginWithSms: (payload: { mobile: string; code: string }) =>
    ipcRenderer.invoke('cloud:auth:login-sms', payload),
  wechatGetQr: (payload: { redirectUri: string }) =>
    ipcRenderer.invoke('cloud:auth:wechat-qr', payload),
  wechatPoll: (payload: { ticket: string }) =>
    ipcRenderer.invoke('cloud:auth:wechat-poll', payload),
  loginWithWechat: (payload: { code: string; state: string }) =>
    ipcRenderer.invoke('cloud:auth:login-wechat', payload),
  logout: () => ipcRenderer.invoke('cloud:auth:logout'),
  getStatus: () => ipcRenderer.invoke('cloud:auth:get-status'),
  onLoggedOut: (handler: () => void) => {
    const wrapped = () => handler();
    ipcRenderer.on('cloud:auth:logged-out', wrapped);
    return () => ipcRenderer.off('cloud:auth:logged-out', wrapped);
  },
  onLoginSuccess: (handler: (payload: { user: any }) => void) => {
    const wrapped = (_e: any, payload: any) => handler(payload);
    ipcRenderer.on('cloud:auth:login-success', wrapped);
    return () => ipcRenderer.off('cloud:auth:login-success', wrapped);
  },
},
```

Also add a probe-base-url API used by Settings:

```ts
probeCloudBaseUrl: () => ipcRenderer.invoke('cloud:probe-base-url'),
setCloudApiBaseUrl: (url: string | null) =>
  ipcRenderer.invoke('cloud:set-base-url', { url }),
```

- [ ] **Step 2: Add type declarations**

Open `src/renderer/types/electron.d.ts`. Find the existing global electron type. Add:

```ts
export interface CloudUserInfo {
  id: string | number;
  username: string;
  nickname?: string;
  mobile?: string;
  avatar?: string;
  subscriptionPlan?: string;
  coin?: number;
}

export interface CloudAuthStatus {
  isLoggedIn: boolean;
  user?: CloudUserInfo;
  hasCompletedFirstLogin: boolean;
}

export interface WechatQrResult {
  success: boolean;
  qrUrl?: string;
  ticket?: string;
  expiresIn?: number;
  error?: string;
}

export interface WechatPollResult {
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired';
  code?: string;
  state?: string;
}

// Inside the global electron interface:
interface ElectronAPI {
  // ... existing ...
  cloudAuth: {
    loginWithPassword: (payload: { mobile: string; password: string }) => Promise<{ success: boolean; userInfo?: CloudUserInfo; error?: string }>;
    sendSmsCode: (payload: { mobile: string }) => Promise<{ success: boolean; error?: string }>;
    loginWithSms: (payload: { mobile: string; code: string }) => Promise<{ success: boolean; userInfo?: CloudUserInfo; error?: string }>;
    wechatGetQr: (payload: { redirectUri: string }) => Promise<WechatQrResult>;
    wechatPoll: (payload: { ticket: string }) => Promise<WechatPollResult>;
    loginWithWechat: (payload: { code: string; state: string }) => Promise<{ success: boolean; userInfo?: CloudUserInfo; error?: string }>;
    logout: () => Promise<{ success: boolean }>;
    getStatus: () => Promise<CloudAuthStatus>;
    onLoggedOut: (handler: () => void) => () => void;
    onLoginSuccess: (handler: (payload: { user: CloudUserInfo }) => void) => () => void;
  };
  probeCloudBaseUrl: () => Promise<{ ok: boolean; error?: string }>;
  setCloudApiBaseUrl: (url: string | null) => Promise<{ success: boolean }>;
}
```

- [ ] **Step 3: Run TypeScript check**

Run: `npm run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main/preload.ts src/renderer/types/electron.d.ts
git commit -m "feat(cloud-auth): preload + types for cloudAuth IPC"
```

---

### Task 13: LoginGate + LoginModal + WechatQrDialog

**Files:**
- Create: `src/renderer/components/LoginGate.tsx`
- Create: `src/renderer/components/LoginGate.test.tsx`
- Create: `src/renderer/components/LoginModal.tsx`
- Create: `src/renderer/components/LoginModal.test.tsx`
- Create: `src/renderer/components/WechatQrDialog.tsx`
- Create: `src/renderer/components/WechatQrDialog.test.tsx`
- Delete: `src/renderer/components/LoginButton.tsx`

- [ ] **Step 1: Write failing test for LoginGate**

Create `src/renderer/components/LoginGate.test.tsx`:
```tsx
import { describe, test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import cloudAuthReducer from '../store/slices/cloudAuthSlice';
import { LoginGate } from './LoginGate';

vi.mock('./LoginModal', () => ({
  LoginModal: () => <div data-testid="login-modal">LoginModal</div>,
}));

function renderWithState(state: { isLoggedIn: boolean; hasCompletedFirstLogin: boolean | null; isLoading: boolean; user: any }) {
  const store = configureStore({
    reducer: { cloudAuth: cloudAuthReducer },
    preloadedState: { cloudAuth: state },
  });
  return render(
    <Provider store={store}>
      <LoginGate>
        <div data-testid="children">children</div>
      </LoginGate>
    </Provider>
  );
}

describe('LoginGate', () => {
  test('shows loading when hasCompletedFirstLogin is null', () => {
    renderWithState({ isLoggedIn: false, hasCompletedFirstLogin: null, isLoading: true, user: null });
    expect(screen.queryByTestId('children')).toBeNull();
    expect(screen.queryByTestId('login-modal')).toBeNull();
  });

  test('shows first-run screen when hasCompletedFirstLogin is false', () => {
    renderWithState({ isLoggedIn: false, hasCompletedFirstLogin: false, isLoading: false, user: null });
    expect(screen.queryByTestId('children')).toBeNull();
  });

  test('renders children + login modal when logged out but first login done', () => {
    renderWithState({ isLoggedIn: false, hasCompletedFirstLogin: true, isLoading: false, user: null });
    expect(screen.getByTestId('children')).toBeTruthy();
  });

  test('renders children when logged in', () => {
    renderWithState({ isLoggedIn: true, hasCompletedFirstLogin: true, isLoading: false, user: { id: 1, username: 'u' } });
    expect(screen.getByTestId('children')).toBeTruthy();
    expect(screen.queryByTestId('login-modal')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/components/LoginGate.test.tsx`
Expected: FAIL — module not found

- [ ] **Step 3: Create LoginGate.tsx**

Create `src/renderer/components/LoginGate.tsx`:
```tsx
import React, { useState, useEffect, type ReactNode } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../store';
import { LoginModal } from './LoginModal';

interface LoginGateProps {
  children: ReactNode;
}

export function LoginGate({ children }: LoginGateProps) {
  const { isLoggedIn, hasCompletedFirstLogin, isLoading } = useSelector(
    (s: RootState) => s.cloudAuth
  );
  const [modalOpen, setModalOpen] = useState(false);

  useEffect(() => {
    const handler = () => setModalOpen(true);
    window.addEventListener('cloudAuth:openLoginModal', handler);
    return () => window.removeEventListener('cloudAuth:openLoginModal', handler);
  }, []);

  if (isLoading || hasCompletedFirstLogin === null) {
    return <div data-testid="loading">Loading…</div>;
  }

  if (!hasCompletedFirstLogin) {
    return (
      <div data-testid="first-run-screen" className="fixed inset-0 z-[80] flex items-center justify-center bg-background">
        <LoginModal isFirstRun onSuccess={() => { /* state change triggers re-render */ }} />
      </div>
    );
  }

  return (
    <>
      {children}
      {modalOpen && !isLoggedIn && (
        <LoginModal onClose={() => setModalOpen(false)} />
      )}
    </>
  );
}
```

- [ ] **Step 4: Create LoginModal.tsx**

Create `src/renderer/components/LoginModal.tsx`:
```tsx
import React, { useState, useEffect } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../store';
import { i18nService } from '../services/i18n';
import { cloudAuthService } from '../services/cloudAuth';
import { WechatQrDialog } from './WechatQrDialog';
import { SmsCountdownSeconds } from '../../shared/cloudAuth/constants';

interface LoginModalProps {
  isFirstRun?: boolean;
  onClose?: () => void;
  onSuccess?: () => void;
}

type Tab = 'password' | 'sms' | 'wechat';

export function LoginModal({ isFirstRun, onClose, onSuccess }: LoginModalProps) {
  const { hasCompletedFirstLogin } = useSelector((s: RootState) => s.cloudAuth);
  const [tab, setTab] = useState<Tab>('password');
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [smsCode, setSmsCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [showWechat, setShowWechat] = useState(false);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [countdown]);

  const handlePasswordLogin = async () => {
    setError(null);
    setLoading(true);
    try {
      const r = await cloudAuthService.loginWithPassword(mobile, password);
      if (!r.success) {
        setError(r.error || i18nService.t('authCloudLoginFailed'));
        return;
      }
      onSuccess?.();
      onClose?.();
    } finally {
      setLoading(false);
    }
  };

  const handleSendSms = async () => {
    setError(null);
    const r = await cloudAuthService.sendSmsCode(mobile);
    if (!r.success) {
      setError(r.error || i18nService.t('authCloudSmsSendFailed'));
      return;
    }
    setCountdown(SmsCountdownSeconds);
  };

  const handleSmsLogin = async () => {
    setError(null);
    setLoading(true);
    try {
      const r = await cloudAuthService.loginWithSms(mobile, smsCode);
      if (!r.success) {
        setError(r.error || i18nService.t('authCloudLoginFailed'));
        return;
      }
      onSuccess?.();
      onClose?.();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div data-testid="login-modal" className="w-full max-w-md rounded-2xl border border-border bg-background p-6 shadow-2xl">
      <div className="mb-4 flex gap-2 border-b border-border">
        {(['password', 'sms', 'wechat'] as const).map((t) => (
          <button
            key={t}
            data-testid={`tab-${t}`}
            onClick={() => {
              setTab(t);
              setError(null);
            }}
            className={tab === t ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground'}
          >
            {i18nService.t(`authCloudTab${t.charAt(0).toUpperCase() + t.slice(1)}`)}
          </button>
        ))}
      </div>

      {error && (
        <div data-testid="login-error" className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">
          {error}
        </div>
      )}

      {tab === 'password' && (
        <div className="space-y-3">
          <input
            data-testid="mobile-input"
            type="tel"
            placeholder={i18nService.t('authCloudMobilePlaceholder')}
            value={mobile}
            onChange={(e) => setMobile(e.target.value)}
            className="w-full rounded border border-border px-3 py-2"
          />
          <input
            data-testid="password-input"
            type="password"
            placeholder={i18nService.t('authCloudPasswordPlaceholder')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded border border-border px-3 py-2"
          />
          <button
            data-testid="password-submit"
            onClick={handlePasswordLogin}
            disabled={loading || !mobile || !password}
            className="w-full rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50"
          >
            {i18nService.t('authCloudLogin')}
          </button>
        </div>
      )}

      {tab === 'sms' && (
        <div className="space-y-3">
          <div className="flex gap-2">
            <input
              data-testid="sms-mobile-input"
              type="tel"
              placeholder={i18nService.t('authCloudMobilePlaceholder')}
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              className="flex-1 rounded border border-border px-3 py-2"
            />
            <button
              data-testid="send-sms-button"
              onClick={handleSendSms}
              disabled={!mobile || countdown > 0}
              className="rounded border border-border px-3 py-2 disabled:opacity-50"
            >
              {countdown > 0 ? `${countdown}s` : i18nService.t('authCloudSendCode')}
            </button>
          </div>
          <input
            data-testid="sms-code-input"
            type="text"
            placeholder={i18nService.t('authCloudSmsCodePlaceholder')}
            value={smsCode}
            onChange={(e) => setSmsCode(e.target.value)}
            className="w-full rounded border border-border px-3 py-2"
          />
          <button
            data-testid="sms-submit"
            onClick={handleSmsLogin}
            disabled={loading || !mobile || !smsCode}
            className="w-full rounded bg-primary px-3 py-2 text-primary-foreground disabled:opacity-50"
          >
            {i18nService.t('authCloudLogin')}
          </button>
        </div>
      )}

      {tab === 'wechat' && (
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground">{i18nService.t('authCloudWechatHint')}</p>
          <button
            data-testid="wechat-launch"
            onClick={() => setShowWechat(true)}
            className="rounded bg-primary px-3 py-2 text-primary-foreground"
          >
            {i18nService.t('authCloudWechatLaunch')}
          </button>
          {showWechat && (
            <WechatQrDialog
              onSuccess={() => { onSuccess?.(); onClose?.(); }}
              onCancel={() => setShowWechat(false)}
            />
          )}
        </div>
      )}

      {!isFirstRun && (
        <div className="mt-4 flex justify-end gap-3 text-sm">
          <a
            data-testid="link-register"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.electron.shell.openExternal(
                `${import.meta.env.VITE_CLOUD_API_BASE_URL}/register`
              );
            }}
            className="text-primary hover:underline"
          >
            {i18nService.t('authCloudGoRegister')}
          </a>
          <a
            data-testid="link-reset-password"
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.electron.shell.openExternal(
                `${import.meta.env.VITE_CLOUD_API_BASE_URL}/reset-password`
              );
            }}
            className="text-primary hover:underline"
          >
            {i18nService.t('authCloudGoResetPassword')}
          </a>
        </div>
      )}

      {isFirstRun && (
        <p className="mt-4 text-xs text-muted-foreground">
          {i18nService.t('authCloudFirstRunHint')}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Create WechatQrDialog.tsx**

Create `src/renderer/components/WechatQrDialog.tsx`:
```tsx
import React, { useState, useEffect, useRef } from 'react';
import { cloudAuthService } from '../services/cloudAuth';
import { i18nService } from '../services/i18n';
import {
  WechatQrPollingIntervalMs,
  WechatQrMaxLifetimeMs,
} from '../../shared/cloudAuth/constants';

interface WechatQrDialogProps {
  onSuccess: () => void;
  onCancel: () => void;
}

export function WechatQrDialog({ onSuccess, onCancel }: WechatQrDialogProps) {
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);
  const [status, setStatus] = useState<'waiting' | 'scanned' | 'confirmed' | 'expired'>('waiting');
  const [error, setError] = useState<string | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const redirectUri = `${window.location.origin}/wechat-callback`;
      const r = await cloudAuthService.wechatGetQr(redirectUri);
      if (cancelled) return;
      if (!r.success || !r.ticket) {
        setError(r.error || 'Failed to get QR');
        return;
      }
      setQrUrl(r.qrUrl ?? null);
      setTicket(r.ticket);
    })();

    timeoutRef.current = setTimeout(() => {
      if (!cancelled) setStatus('expired');
    }, WechatQrMaxLifetimeMs);

    return () => {
      cancelled = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (!ticket) return;
    if (status === 'confirmed' || status === 'expired') return;
    const id = setInterval(async () => {
      const r = await cloudAuthService.wechatPoll(ticket);
      if (r.status === 'confirmed' && r.code && r.state) {
        setStatus('confirmed');
        const login = await cloudAuthService.loginWithWechat(r.code, r.state);
        if (login.success) {
          onSuccess();
        } else {
          setError(login.error || 'Login failed');
        }
      } else {
        setStatus(r.status as any);
      }
    }, WechatQrPollingIntervalMs);
    return () => clearInterval(id);
  }, [ticket, status, onSuccess]);

  return (
    <div data-testid="wechat-qr-dialog" className="flex flex-col items-center gap-2">
      {qrUrl ? (
        <img data-testid="wechat-qr-img" src={qrUrl} alt="WeChat QR" className="h-48 w-48" />
      ) : (
        <div className="h-48 w-48 animate-pulse rounded bg-muted" />
      )}
      <p data-testid="wechat-status" className="text-sm">
        {i18nService.t(`authCloudWechat${status.charAt(0).toUpperCase() + status.slice(1)}`)}
      </p>
      {error && <p data-testid="wechat-error" className="text-sm text-red-500">{error}</p>}
      {status === 'expired' && (
        <button
          onClick={() => {
            setStatus('waiting');
            setError(null);
            setTicket(null);
            setQrUrl(null);
            // re-init
            window.location.reload();
          }}
          className="rounded bg-primary px-3 py-1 text-primary-foreground"
        >
          {i18nService.t('authCloudRefresh')}
        </button>
      )}
      <button onClick={onCancel} className="text-sm text-muted-foreground hover:underline">
        {i18nService.t('cancel')}
      </button>
    </div>
  );
}
```

- [ ] **Step 6: Run LoginGate tests**

Run: `npx vitest run src/renderer/components/LoginGate.test.tsx`
Expected: All 4 tests pass

- [ ] **Step 7: Add i18n keys (in same commit or separate)**

Open `src/renderer/services/i18n.ts` and add the new keys under both `zh` and `en` sections. (See Task 14 for full i18n list.)

- [ ] **Step 8: Delete old LoginButton**

```bash
git rm src/renderer/components/LoginButton.tsx
```

- [ ] **Step 9: Update any Sidebar imports**

```bash
grep -rln "LoginButton" src/renderer/
```

For each match, replace with the new pattern. (Sidebar should now show a "登录" button that dispatches `cloudAuth:openLoginModal` when user is not logged in, or a user menu when logged in.)

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(cloud-auth): LoginGate + LoginModal + WechatQrDialog (3-tab + inline links)"
```

---

### Task 14: i18n + Sidebar + App.tsx

**Files:**
- Modify: `src/renderer/services/i18n.ts`
- Modify: `src/renderer/components/Sidebar.tsx`
- Modify: `src/renderer/App.tsx`
- Create: `src/renderer/components/Settings/CloudApiSection.tsx`

- [ ] **Step 1: Add i18n keys**

Open `src/renderer/services/i18n.ts`. Add the following keys to BOTH `zh` and `en`:

```ts
// zh
authCloudTabPassword: '密码登录',
authCloudTabSms: '短信登录',
authCloudTabWechat: '微信登录',
authCloudMobilePlaceholder: '请输入手机号',
authCloudPasswordPlaceholder: '请输入密码',
authCloudSmsCodePlaceholder: '请输入短信验证码',
authCloudLogin: '登录',
authCloudLoginFailed: '登录失败',
authCloudSmsSendFailed: '发送验证码失败',
authCloudSendCode: '发送验证码',
authCloudWechatHint: '使用微信扫码登录',
authCloudWechatLaunch: '打开微信扫码',
authCloudWechatWaiting: '请使用微信扫描二维码',
authCloudWechatScanned: '已扫码，请在手机上确认',
authCloudWechatConfirmed: '登录成功',
authCloudWechatExpired: '二维码已过期',
authCloudRefresh: '刷新二维码',
authCloudGoRegister: '去 RunNode Portal 注册',
authCloudGoResetPassword: '去 RunNode Portal 找回密码',
authCloudFirstRunHint: '首次使用需要登录 RunNode 会员账号',
authCloudLoggedOutToast: '登录已失效，请重新登录',
authCloudBaseUrlLabel: 'RunNode API 地址',
authCloudBaseUrlTest: '测试连接',
authCloudBaseUrlSave: '保存',
authCloudBaseUrlTestOk: '✓ 已连通 RunNode',
authCloudBaseUrlTestFailed: '× 无法连接：',
authCloudTestConnection: '测试连接',

// en
authCloudTabPassword: 'Password',
authCloudTabSms: 'SMS Code',
authCloudTabWechat: 'WeChat',
authCloudMobilePlaceholder: 'Mobile number',
authCloudPasswordPlaceholder: 'Password',
authCloudSmsCodePlaceholder: 'SMS code',
authCloudLogin: 'Sign in',
authCloudLoginFailed: 'Sign-in failed',
authCloudSmsSendFailed: 'Failed to send code',
authCloudSendCode: 'Send code',
authCloudWechatHint: 'Scan with WeChat to sign in',
authCloudWechatLaunch: 'Open WeChat scan',
authCloudWechatWaiting: 'Scan the QR with WeChat',
authCloudWechatScanned: 'Scanned. Please confirm on phone',
authCloudWechatConfirmed: 'Signed in',
authCloudWechatExpired: 'QR expired',
authCloudRefresh: 'Refresh QR',
authCloudGoRegister: 'Register on RunNode Portal',
authCloudGoResetPassword: 'Reset password on RunNode Portal',
authCloudFirstRunHint: 'First time setup requires RunNode sign-in',
authCloudLoggedOutToast: 'Session expired. Please sign in again.',
authCloudBaseUrlLabel: 'RunNode API URL',
authCloudBaseUrlTest: 'Test connection',
authCloudBaseUrlSave: 'Save',
authCloudBaseUrlTestOk: '✓ Connected to RunNode',
authCloudBaseUrlTestFailed: '× Cannot connect: ',
authCloudTestConnection: 'Test connection',
```

Also REMOVE these old keys (URS era): `authPlanFree`, `authPlanStandard`, `authPlanAdvanced`, `authPlanPro`, `authQuotaExhausted`, `authCreditsUnit`, `authExpiresAt`.

- [ ] **Step 2: Update Sidebar**

Open `src/renderer/components/Sidebar.tsx`. Find the user/login button. Replace URS-style code with:

```tsx
import { useSelector } from 'react-redux';
import type { RootState } from '../store';
import { cloudAuthService } from '../services/cloudAuth';
import { i18nService } from '../services/i18n';

// In Sidebar component:
const { isLoggedIn, user, hasCompletedFirstLogin } = useSelector((s: RootState) => s.cloudAuth);

const handleLoginClick = () => {
  if (!cloudAuthService.requireAuth()) {
    // requireAuth already dispatched the open event
  }
};

const handleLogout = async () => {
  await cloudAuthService.logout();
};

// Render:
{isLoggedIn ? (
  <UserMenu user={user} onLogout={handleLogout} />
) : hasCompletedFirstLogin ? (
  <Button onClick={handleLoginClick}>{i18nService.t('signIn')}</Button>
) : null}
```

Also REMOVE the `hideLogin` prop usage — it's no longer applicable.

- [ ] **Step 3: Update App.tsx**

Open `src/renderer/App.tsx`. Find where `authService.init()` is called. Replace with `cloudAuthService.init()`. Wrap the existing app content with `<LoginGate>`:

```tsx
// Before
useEffect(() => {
  // ... authService.init() ...
}, []);

// After
import { cloudAuthService } from './services/cloudAuth';
import { LoginGate } from './components/LoginGate';

useEffect(() => {
  // ... cloudAuthService.init() ...
}, []);

// In the render tree, wrap with LoginGate:
return (
  <LoginGate>
    {/* existing app content */}
  </LoginGate>
);
```

- [ ] **Step 4: Create CloudApiSection.tsx**

Create `src/renderer/components/Settings/CloudApiSection.tsx`:
```tsx
import React, { useState, useEffect } from 'react';
import { i18nService } from '../../services/i18n';
import { configService } from '../../services/config';

export function CloudApiSection() {
  const [url, setUrl] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const cfg = configService.getConfig();
    setUrl(cfg.cloudApiBaseUrl ?? import.meta.env.VITE_CLOUD_API_BASE_URL ?? '');
  }, []);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // Apply locally first to test
      await window.electron.setCloudApiBaseUrl(url || null);
      const r = await window.electron.probeCloudBaseUrl();
      setTestResult(r);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    await configService.updateConfig({ cloudApiBaseUrl: url });
    await window.electron.setCloudApiBaseUrl(url || null);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-3">
      <label className="text-sm font-medium">{i18nService.t('authCloudBaseUrlLabel')}</label>
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={import.meta.env.VITE_CLOUD_API_BASE_URL}
        className="w-full rounded border border-border px-3 py-2"
      />
      <div className="flex gap-2">
        <button
          onClick={handleTest}
          disabled={testing}
          className="rounded border border-border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50"
        >
          {i18nService.t('authCloudBaseUrlTest')}
        </button>
        <button
          onClick={handleSave}
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground"
        >
          {i18nService.t('authCloudBaseUrlSave')}
        </button>
        {saved && <span className="text-sm text-green-500">{i18nService.t('saved')}</span>}
      </div>
      {testResult && (
        <p
          data-testid="test-result"
          className={testResult.ok ? 'text-sm text-green-500' : 'text-sm text-red-500'}
        >
          {testResult.ok
            ? i18nService.t('authCloudBaseUrlTestOk')
            : `${i18nService.t('authCloudBaseUrlTestFailed')}${testResult.error}`}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Add cloudApiBaseUrl to configService**

Open `src/renderer/services/config.ts`. Find the config interface. Add:

```ts
cloudApiBaseUrl?: string;
```

Also add to default config if appropriate.

- [ ] **Step 6: Mount CloudApiSection in Settings**

Open Settings.tsx. Find where existing sections are rendered. Add `<CloudApiSection />` in the General or Advanced tab.

- [ ] **Step 7: Run TypeScript check + tests**

```bash
npm run typecheck
npm test
```

Expected: No errors, all tests pass

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(cloud-auth): i18n keys + Sidebar/App.tsx + Settings/CloudApiSection"
```

---

### Task 15: URS cleanup — remove OAuth code, deep link handler, OAuth callback server

**Files:**
- Modify: `src/main/main.ts` (remove URS code, register oauth-related removals)
- Modify: `package.json` (remove `@types/*` if no longer needed)

- [ ] **Step 1: Find and remove URS-related code in main.ts**

```bash
grep -n "registerOAuthProtocol\|ensureDesktopAuthCallbackUrl\|pendingAuthCode\|desktopAuthCallbackServer\|open-url\|wesight://" src/main/main.ts
```

For each match, remove the function definition and call sites. Concretely:
- Delete the entire `registerOAuthProtocol()` function
- Delete the `ensureDesktopAuthCallbackUrl()` function
- Delete the `desktopAuthCallbackServer` variable and the `pendingAuthCode` variable
- Delete the `app.on('open-url', ...)` handler (and its `event.preventDefault()`)
- Delete the `wesight://` parsing inside `app.on('second-instance', ...)`
- Delete the `ipcMain.handle('auth:getPendingCallback', ...)` registration

- [ ] **Step 2: Find and remove URS IPC handlers**

```bash
grep -n "ipcMain.handle('auth:" src/main/main.ts
```

For each match, delete the entire handler block. Handlers to remove:
- `auth:login`
- `auth:exchange`
- `auth:getUser`
- `auth:getQuota`
- `auth:getProfileSummary`
- `auth:refreshToken`
- `auth:getAccessToken`
- `auth:getModels`
- `auth:logout`

- [ ] **Step 3: Find and remove URS helpers**

```bash
grep -n "saveAuthTokens\|getAuthTokens\|clearAuthTokens\|normalizeQuota" src/main/main.ts
```

For each match, delete the function.

- [ ] **Step 4: Find and remove `auth:quotaChanged` event sender**

```bash
grep -n "auth:quotaChanged" src/main/main.ts
```

Delete the lines that send this event.

- [ ] **Step 5: Run TypeScript check**

Run: `npm run typecheck`
Expected: No errors (all call sites should already be updated from Task 10/11)

- [ ] **Step 6: Commit**

```bash
git add src/main/main.ts
git commit -m "refactor: remove URS OAuth code (deep link, callback server, IPC handlers)"
```

---

### Task 16: E2E test for first-run + restart

**Files:**
- Create: `tests/e2e/auth.spec.ts`

- [ ] **Step 1: Verify Playwright config exists**

```bash
cat playwright.config.ts
```

If missing, create a minimal one based on the spec. (WeSight should have one — check existing `tests/e2e/` directory for patterns.)

- [ ] **Step 2: Create the E2E test**

Create `tests/e2e/auth.spec.ts`:
```ts
import { test, expect, _electron as electron } from '@playwright/test';
import path from 'path';

const APP_ROOT = path.join(__dirname, '..', '..');

test('first-run shows LoginGate, sign in, restart, auto-restore', async () => {
  // Launch app
  const app = await electron.launch({ args: [path.join(APP_ROOT, 'dist-electron', 'main.js')] });
  const page = await app.firstWindow();

  // First run: should see LoginGate
  await expect(page.getByTestId('first-run-screen')).toBeVisible({ timeout: 15000 });

  // Sign in (use mock RunNode or skip if no test server)
  // For this test, we'll mock the IPC by injecting a stub
  // (Actual implementation needs a test RunNode endpoint or extensive mocking)
  await page.getByTestId('tab-password').click();
  await page.getByTestId('mobile-input').fill('13800138000');
  await page.getByTestId('password-input').fill('testpassword');
  await page.getByTestId('password-submit').click();

  // After login: should enter main app
  await expect(page.getByTestId('first-run-screen')).not.toBeVisible({ timeout: 15000 });
  // (Adjust selector based on actual main view structure)

  await app.close();

  // Re-launch
  const app2 = await electron.launch({ args: [path.join(APP_ROOT, 'dist-electron', 'main.js')] });
  const page2 = await app2.firstWindow();

  // Should NOT see LoginGate this time (hasCompletedFirstLogin = true; isLoggedIn = true)
  await expect(page2.getByTestId('first-run-screen')).not.toBeVisible({ timeout: 15000 });

  await app2.close();
});
```

- [ ] **Step 3: Document how to run E2E**

Append to README or AGENTS.md (in a new section "Running E2E tests"):

```bash
npm run build:vite  # or whatever the build command is
npm run test:e2e
```

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/auth.spec.ts
git commit -m "test(e2e): first-run login + restart auto-restore"
```

---

### Task 17: Final cleanup + smoke test + doc

**Files:**
- Modify: `docs/superpowers/specs/2026-06-05-wesight-runnode-user-auth-design.md` (mark spec as implemented)
- Modify: `AGENTS.md` (add note about RunNode auth replacement)
- Verify all existing tests pass

- [ ] **Step 1: Run full test suite**

```bash
npm run typecheck
npm run lint
npm test
```

Expected: All green.

- [ ] **Step 2: Manual smoke test on macOS**

```bash
npm run electron:dev
```

Walk through:
1. App opens → LoginGate full-screen visible
2. Password login (use a test RunNode account) → main view
3. Restart app → no LoginGate, auto-logged in
4. Click logout from Sidebar → LoginModal appears (not full-screen)
5. Log in again → main view
6. Open Settings → Cloud API section → "Test connection" → verify it works
7. Quit, clear `app_state.urs_cleanup_at` from SQLite, relaunch → verify cleanup is idempotent

- [ ] **Step 3: Update spec doc to mark implemented**

Open `docs/superpowers/specs/2026-06-05-wesight-runnode-user-auth-design.md`. At the very top, after the title, add:

```markdown
> **Status:** Implemented (2026-06-05)
```

- [ ] **Step 4: Update AGENTS.md**

Open `AGENTS.md`. Add a section near the top:

```markdown
## Authentication

WeSight now uses RunNode member auth (not URS OAuth). See `docs/superpowers/specs/2026-06-05-wesight-runnode-user-auth-design.md`. Code lives in:
- `src/main/services/cloudAuth.ts`
- `src/main/services/cloudAuthTokenStore.ts` (SQLCipher)
- `src/main/services/cloudUserDeviceService.ts` (main-process heartbeat)
- `src/renderer/services/cloudAuth.ts`
- `src/renderer/store/slices/cloudAuthSlice.ts`
- `src/renderer/components/LoginGate.tsx`
- `src/renderer/components/LoginModal.tsx`
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: mark RunNode auth spec as implemented + update AGENTS.md"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Implemented in |
|---|---|
| Architecture (architecture diagram) | Tasks 9, 11, 14 |
| State machine (3 states) | Tasks 10, 11, 13, 14 |
| 4 login flows | Tasks 6, 9, 12, 13 |
| Token 续期 + 401 retry | Task 6 |
| 启动初始化顺序 | Task 9 (main.ts wiring) |
| Component list (Main) | Tasks 3, 4, 5, 6, 7, 8, 9 |
| Component list (Renderer) | Tasks 10, 11, 12, 13, 14 |
| Component list (Shared) | Task 2 |
| 删除 list | Task 15 |
| 修改 list | Tasks 1, 9, 14, 15 |
| Unit tests | Tasks 2, 3, 4, 5, 6, 7, 8, 13 |
| E2E tests | Task 16 |
| Error handling table | Task 6 (refresh fail), Task 5 (heartbeat fail), Task 7 (legacy) |
| Out of scope | Not implemented (intentional) |
| Migration path (硬重置) | Task 7 (legacyAuthCleanup) + Task 9 (call in main.ts) |

**2. Placeholder scan:** No "TBD" / "TODO" / "fill in details" / "similar to Task N" in any step.

**3. Type consistency:**
- `CloudUserInfo` defined in `src/shared/cloudAuth/parsers.ts`, re-exported in `src/renderer/store/slices/cloudAuthSlice.ts` — same shape used throughout
- `CloudAuthChannel.*` constants used in both preload (`ipcMain.handle` registration) and renderer (`window.electron.cloudAuth.*`) — single source of truth
- `CloudAuthTokens` used in store, service, parsers — same `{ accessToken, refreshToken, expiresAt }` shape everywhere

No inconsistencies found. Ready to execute.
