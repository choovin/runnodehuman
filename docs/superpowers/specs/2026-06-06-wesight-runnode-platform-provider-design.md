# WeSight × RunNode Platform Provider Sync — Design

## Overview

Sync RunNode's `new-api/config` (an OpenAI-compatible gateway with the user's unified platform API key) into WeSight's local SQLite, so engine configurations (Claude Code / Codex / OpenClaw / Hermes) can consume a single platform-key bearer in **C**. Also surface RunNode `coin` (算力币) and `subscriptionPlan` (套餐) in the renderer.

Modeled after RClaw's `cloud-platform-provider.ts` but adapted to WeSight's architecture: direct IPC, independent SQLCipher kv table for the provider record, hybrid override model (cloud wins by default, user override with explicit "reset" button).

> 范围限制：**本 spec 只解决"模型同步 + 套餐/算力币展示"。** Engine 初始化配置（C）和数字员工转换（D）分别在各自 spec。

## Problem

WeSight currently has no way to consume RunNode's unified model gateway. After successful login (A), the user has:
- A valid `accessToken` (good for RunNode member API)
- A `coin` balance and `subscriptionPlan` tier (from `member/user/get`)
- Access to RunNode's OpenAI-compatible gateway via `new-api/config` (returns `baseUrl` + `apiKey`)

We need to:
1. **Persist** the `baseUrl` + `apiKey` locally so engine configs (C) can read it
2. **Refresh** the values periodically (24h idempotent) so a baseUrl change on RunNode's side propagates
3. **Allow user override** for advanced/dev scenarios, with explicit "reset to default" so it's never silent
4. **Display** `coin` + `subscriptionPlan` in the UI (sidebar badge + settings detail)

The `baseUrl` + `apiKey` must NOT be conflated with the auth `baseUrl` (which is for member API endpoints) — they target different services.

## Design

### Approach: Independent SQLCipher kv table + hybrid override

Add a new SQLCipher-backed kv table `cloud_platform_provider` (single row, key='current', value=JSON). Service writes here on sync; renderer reads via IPC. Override is a sub-field of the record, not a separate key.

### State machine

```
        ┌────────────────┐
        │  neverSynced   │  (table row 不存在)
        └────────┬───────┘
                 │  触发：login success / 启动 24h 后 / 手动 sync
                 ▼
        ┌────────────────┐
        │   syncing      │  (请求中)
        └────────┬───────┘
                 │  成功 → 写 store → 广播 updated
                 │  失败 → 保留旧值 → 广播 sync-failed
                 ▼
        ┌────────────────┐
        │   synced       │  (lastSyncedAt < 24h)
        └────┬───────┬───┘
   24h 过去│       │ 用户点 override
   ↓      │       │
   ┌────────────────┐     ┌────────────────┐
   │    stale       │     │   overridden   │  (userOverride != null)
   └───────┬────────┘     └───────┬────────┘
           │                      │ 用户点 reset
           │ 再次触发 sync        │ → 清 override + 立即 sync
           ▼                      ▼
        syncing               syncing
                                 │
                                 ▼
                              synced（无 userOverride）
```

### Data model

```ts
// src/shared/cloudPlatformProvider/types.ts
export interface CloudPlatformProviderRecord {
  /** Synced from RunNode new-api/config */
  baseUrl: string;
  apiKey: string;
  /** Last successful sync timestamp (ms epoch) */
  lastSyncedAt: number;
  /** User override (advanced users); effective values fall back to synced values */
  userOverride?: {
    baseUrl?: string;
    apiKey?: string;
  };
}

/** Computed (not stored) — true iff userOverride is set */
export const isOverridden = (r: CloudPlatformProviderRecord): boolean =>
  r.userOverride != null && (r.userOverride.baseUrl != null || r.userOverride.apiKey != null);

/** Effective values (override applied) */
export const effective = (r: CloudPlatformProviderRecord): { baseUrl: string; apiKey: string } => ({
  baseUrl: r.userOverride?.baseUrl ?? r.baseUrl,
  apiKey: r.userOverride?.apiKey ?? r.apiKey,
});
```

### Architecture

```
[Renderer]
  cloudAuthSlice ──► Sidebar (coin 徽章 + 套餐徽章 in user menu)
                  └► Settings / CloudPlatformProviderSection
                       (effective 显示 + baseUrl/apiKey 输入 + override
                        + "恢复默认" + "立即同步" + lastSyncedAt + isOverridden 标签)

[Main]
  CloudPlatformProviderService
    ├─ listen 'cloud:auth:login-success' → 触发 sync (fire-and-forget)
    ├─ init() 时调 ensureSynced() → 24h idempotent
    ├─ 读 /app-api/member/new-api/config (走 cloudAuth.fetchMemberAuthorized)
    ├─ 写 SQLite kv 表 cloud_platform_provider (单行 + JSON)
    ├─ 并发合并：inFlightSync: Promise<boolean> | null
    └─ 广播 'cloud:platform-provider:updated' 事件

  CloudAuthService.getStatus() 扩展 ──► 多返 coin / subscriptionPlan
    (从 cloudUserInfo 拿，A 已经把 userInfo 存了)

[IPC] cloud:platform-provider:* (4 个 invoke + 2 个事件)
```

### 4 个数据流

#### A. 登录后自动同步

```
CloudAuthService.loginInternal()
  └─ broadcaster.emit('cloud:auth:login-success')
        └─ CloudPlatformProviderService 注册的监听
              └─ sync() 异步触发（不阻塞登录返回）
                    ├─ GET /app-api/member/new-api/config
                    │   (走 cloudAuth.fetchMemberAuthorized 自动带 Bearer)
                    ├─ 解析 → { baseUrl, apiKey } (parsers.parseNewApiConfig)
                    ├─ normalize baseUrl 末尾补 /v1 (如已存在则不重复加)
                    ├─ store.save({ baseUrl, apiKey, lastSyncedAt, userOverride: undefined })
                    └─ broadcaster.emit('cloud:platform-provider:updated', payload)
                          └─ IPC 广播到 renderer
                                └─ cloudAuthSlice.setPlatformProvider(payload)
```

#### B. 启动 24h idempotent 检查

```
main.ts: app.whenReady() → 初始化 CloudPlatformProviderService
  └─ ensureSynced() 异步触发
        ├─ store.load()
        ├─ record.lastSyncedAt > now - 24h ？
        │   └─ 否 → 调 sync() (流程同 A)
        │   └─ 是 → 跳过
        └─ record.userOverride != null → 跳过 (override 时不主动 resync)
```

#### C. 用户 Override

```
[Settings / CloudPlatformProviderSection]
  └─ 用户填 baseUrl / apiKey → 点 "Save Override"
        └─ window.electron.cloudPlatformProvider.setOverride({baseUrl, apiKey})
              └─ IPC → CloudPlatformProviderService.setOverride()
                    ├─ 校验：baseUrl 必须 http(s) 开头
                    ├─ 读现有 record
                    ├─ 合并：record.userOverride = { baseUrl?, apiKey? }
                    ├─ store.save(record)
                    └─ 广播 'cloud:platform-provider:updated'
                          └─ slice 同步 → UI 显示 "已覆盖" 标签
```

#### D. 恢复默认

```
[Settings] 用户点 "Reset to Default"
  └─ window.electron.cloudPlatformProvider.resetDefault()
        └─ IPC → CloudPlatformProviderService.resetDefault()
              ├─ 读 record
              ├─ delete record.userOverride
              ├─ store.save(record) — 此时 effective = 云端值
              └─ 立即调 sync() 重新从云端拉取
                    └─ 广播 'cloud:platform-provider:updated'
```

#### E. Coin / subscriptionPlan 展示

```
CloudAuthService.getStatus() 扩展字段
  └─ 多返 { coin: number, subscriptionPlan: string }
       (从 cloudUserInfo 拿；用户登出时为 0/'')

Sidebar 用户菜单 mount
  └─ 读 cloudAuthSlice.user.coin / user.subscriptionPlan
       ├─ 套餐徽章：subscriptionPlan → 4 档颜色
       │   FREE → 灰 / Plus → 蓝 / Pro → 金 / Team → 紫
       └─ Coin 余额：用户头像旁边

Settings / Account 区块 mount
  └─ 显示详细 coin 余额 + 套餐名 + 套餐有效期（如果 A 已存的话）
```

### IPC 契约

| Channel | 方向 | Payload | 响应 |
|---|---|---|---|
| `cloud:platform-provider:get` | R→M | — | `CloudPlatformProviderRecord \| null`（原始 record；`isOverridden` 由 slice 算） |
| `cloud:platform-provider:sync` | R→M | — | `{ success, record?: CloudPlatformProviderRecord, error? }` |
| `cloud:platform-provider:set-override` | R→M | `{ baseUrl?: string, apiKey?: string }` | `{ success, record?: CloudPlatformProviderRecord, error? }` |
| `cloud:platform-provider:reset-default` | R→M | — | `{ success, record?: CloudPlatformProviderRecord, error? }` |
| `cloud:platform-provider:updated` | M→R | `PlatformProviderUpdatedPayload = { record: CloudPlatformProviderRecord }` | — |
| `cloud:platform-provider:sync-failed` | M→R | `{ error: string }` | — |

> 关键：`isOverridden` 是计算属性（`userOverride != null`），不存不传输。Service 返原始 record，slice 用 `isOverridden()` 算。

### 启动初始化顺序

```
1. main: app.whenReady()
2. main: legacyAuthCleanup.run()    (A 已有)
3. main: SQLCipher 打开 wesight.sqlite
4. main: cloudAuthTokenStore.init()  (A 已有)
5. main: cloudUserDeviceStore.init()  (A 已有)
6. main: cloudUserDeviceService.init()  (A 已有)
7. main: cloudPlatformProviderStore.init()  (新增 B)
8. main: cloudPlatformProviderService.init()  (新增 B；内部 listen login-success + ensureSynced)
9. main: cloudApiBaseUrl.init()  (A 已有)
10. main: 注册 cloud:auth:* 和 cloud:platform-provider:* IPC handlers
11. main: 创建 BrowserWindow
12. renderer: App.tsx mount
13. renderer: cloudAuthService.init()  (读 cloud_tokens + getStatus 多返 coin)
14. renderer: cloudPlatformProviderService.init()  (读 store + get + 订阅 updated event)
15. renderer: hasCompletedFirstLogin ?
       │  false → 渲染 <LoginGate />  全屏覆盖
       │  true + isLoggedIn → 进主界面
       │  true + !isLoggedIn → 进主界面，Sidebar 灰掉 RunNode 入口
```

## Changes

### 新增

#### `src/shared/cloudPlatformProvider/types.ts`
```ts
// Data model — see "Data model" section above
export interface CloudPlatformProviderRecord {
  baseUrl: string;
  apiKey: string;
  lastSyncedAt: number;
  userOverride?: { baseUrl?: string; apiKey?: string };
}

export const isOverridden = (r: CloudPlatformProviderRecord | null | undefined): boolean =>
  r?.userOverride != null
  && (r.userOverride.baseUrl != null || r.userOverride.apiKey != null);

export const effective = (r: CloudPlatformProviderRecord): { baseUrl: string; apiKey: string } => ({
  baseUrl: r.userOverride?.baseUrl ?? r.baseUrl,
  apiKey: r.userOverride?.apiKey ?? r.apiKey,
});

export type PlatformProviderUpdatedPayload = { record: CloudPlatformProviderRecord };
export type PlatformProviderSyncFailedPayload = { error: string };
```

#### `src/shared/cloudPlatformProvider/constants.ts`
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

#### `src/shared/cloudPlatformProvider/parsers.ts`
```ts
import { PlatformProviderConfigPath } from './constants';

export interface PlatformProviderConfig {
  baseUrl: string;
  apiKey: string;
}

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

/** 规范化 baseUrl：若末尾不是 /v1 则自动追加；不重复加。 */
export function ensureOpenAiCompatibleBaseUrlV1(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const noTrailingSlash = trimmed.replace(/\/+$/, '');
  if (/\/v1$/i.test(noTrailingSlash)) return noTrailingSlash;
  return `${noTrailingSlash}/v1`;
}

/** 解析 new-api/config 响应，权威字段 apiKey，platformAccessToken 兜底 */
export function parseNewApiConfig(raw: unknown): ParserResult<PlatformProviderConfig> {
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

#### `src/main/services/cloudPlatformProviderStore.ts`
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

#### `src/main/services/cloudPlatformProviderService.ts`
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
    // Listen for successful logins → auto-sync
    const loginHandler = () => {
      void this.sync().catch((e) => console.error('[CloudPlatformProvider] auto-sync failed:', e));
    };
    this.broadcaster.on(CloudAuthChannel.LoginSuccessEvent, loginHandler);
    this.unsubLoginSuccess = () => {
      this.broadcaster.off(CloudAuthChannel.LoginSuccessEvent, loginHandler);
    };

    // 24h idempotent check on startup
    void this.ensureSynced().catch((e) => console.error('[CloudPlatformProvider] ensureSynced failed:', e));
  }

  async ensureSynced(): Promise<void> {
    const existing = await this.store.load();
    if (existing?.userOverride
        && (existing.userOverride.baseUrl != null || existing.userOverride.apiKey != null)) {
      // User has overridden — don't auto-resync
      return;
    }
    if (existing && Date.now() - existing.lastSyncedAt < PlatformProviderSyncThresholdMs) {
      return; // fresh enough
    }
    await this.sync();
  }

  async sync(): Promise<{ success: boolean; error?: string; record?: CloudPlatformProviderRecord }> {
    if (this.inFlightSync) {
      const ok = await this.inFlightSync;
      const record = await this.store.load();
      return { success: ok, record: record ?? undefined };
    }

    this.inFlightSync = (async () => {
      try {
        const baseUrl = await this.cloudAuth.getCloudApiBaseUrl();
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
    if (input.baseUrl != null) {
      if (!/^https?:\/\//i.test(input.baseUrl.trim())) {
        return { success: false, error: 'baseUrl must start with http:// or https://' };
      }
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
    // Immediately re-sync to keep cloud values fresh
    void this.sync().catch((e) => console.error('[CloudPlatformProvider] post-reset sync failed:', e));
    return { success: true };
  }
}
```

#### `src/renderer/components/Settings/CloudPlatformProviderSection.tsx`
```tsx
import React, { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import { cloudPlatformProviderService } from '../../services/cloudPlatformProvider';
import { effective as effectiveOf } from '../../../shared/cloudPlatformProvider/parsers';

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
            <span data-testid="platform-effective-apikey" className="font-mono">{'•'.repeat(Math.min(eff.apiKey.length, 24))}</span>
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
        <p data-testid="platform-error" className="text-sm text-red-500">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
```

#### `src/renderer/services/cloudPlatformProvider.ts`
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

### 修改

#### `src/main/services/cloudAuth.ts` — 扩展 `getStatus()` 多返 coin / subscriptionPlan

`getStatus` 已存 `cloud_user_info` 包含 `coin` / `subscriptionPlan`（A 实现时存的）。B 仅需扩 `getStatus` 的返回类型。

#### `src/main/ipcHandlers/cloudAuth.ts` — 注册 4 个新 IPC handler

```ts
import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { CloudPlatformProviderChannel } from '../../shared/cloudPlatformProvider/constants';

export function registerCloudPlatformProviderHandlers(
  service: CloudPlatformProviderService
): void {
  ipcMain.handle(CloudPlatformProviderChannel.Get, () => service.get());
  ipcMain.handle(CloudPlatformProviderChannel.Sync, () => service.sync());
  ipcMain.handle(CloudPlatformProviderChannel.SetOverride, (_e, payload: { baseUrl?: string; apiKey?: string }) => {
    if (!payload) return { success: false, error: 'payload required' };
    return service.setOverride(payload);
  });
  ipcMain.handle(CloudPlatformProviderChannel.ResetDefault, () => service.resetDefault());
}
```

#### `src/main/main.ts` — 启动时初始化 B

加 3 个 import + 2 行 init（在 `cloudAuthService` 初始化后）：

```ts
import { CloudPlatformProviderStore } from './services/cloudPlatformProviderStore';
import { CloudPlatformProviderService } from './services/cloudPlatformProviderService';
import { registerCloudPlatformProviderHandlers } from './ipcHandlers/cloudAuth';

// 紧接 cloudAuth 注册之后：
const platformProviderService = new CloudPlatformProviderService(
  getStore().getDatabase(),
  cloudAuthService,  // 注入 CloudAuthService 引用，用于 fetchMemberAuthorized
  broadcaster,
);
void platformProviderService.init();
registerCloudPlatformProviderHandlers(platformProviderService);
```

#### `src/renderer/store/slices/cloudAuthSlice.ts` — 扩字段

加字段：
```ts
interface CloudAuthState {
  // ... existing
  platformProvider: CloudPlatformProviderRecord | null;
  platformProviderIsOverridden: boolean;
  platformProviderLastSyncedAt: number | null;
}

> `coin` 和 `subscriptionPlan` **不放在 cloudAuthSlice 顶层**，只在 `user` 对象里。A 已经把 user 存了，B 沿用。Sidebar 直接读 `state.cloudAuth.user.coin` / `user.subscriptionPlan`。这样避免双份同步。

加 reducer：
```ts
setPlatformProvider(state, action: PayloadAction<CloudPlatformProviderRecord | null>) {
  state.platformProvider = action.payload;
  state.platformProviderIsOverridden = isOverridden(action.payload);
  state.platformProviderLastSyncedAt = action.payload?.lastSyncedAt ?? null;
}
```

#### `src/renderer/services/cloudAuth.ts` — `init()` 调 B service

```ts
import { cloudPlatformProviderService } from './cloudPlatformProvider';

async init(): Promise<void> {
  // existing code
  await cloudPlatformProviderService.init();
}
```

#### `src/renderer/components/Sidebar.tsx` — 用户菜单加 coin 徽章 + 套餐徽章

读 `state.cloudAuth.user.coin` / `state.cloudAuth.user.subscriptionPlan`，加 4 档颜色徽章（FREE/Plus/Pro/Team）。

#### `src/renderer/components/Settings.tsx` — 挂载新 section

加 `<CloudPlatformProviderSection />` 到 "Advanced" 或新 "Account" tab。

#### `src/renderer/services/i18n.ts` — 加新 key（zh + en）

新增 20+ 个 key，参考 A 的 i18n 模式。

#### `src/main/preload.ts` — 暴露新 IPC

```ts
import { CloudPlatformProviderChannel } from '../shared/cloudPlatformProvider/constants';
import type { CloudPlatformProviderRecord } from '../shared/cloudPlatformProvider/types';

// in contextBridge.exposeInMainWorld:
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

#### `src/renderer/types/electron.d.ts` — 类型声明

加 `CloudPlatformProviderRecord` 接口 + 4 个新 IPC method 签名 + 2 个 event subscription。

## Testing

### 单元测试

| 文件 | 覆盖 |
|---|---|
| `parsers.test.ts` | `parseNewApiConfig`：标准响应 / 扁平响应 / 缺 baseUrl / 缺 apiKey / platformAccessToken 兜底 / `ensureOpenAiCompatibleBaseUrlV1`：已 `/v1` 不重复加 / 缺 `/v1` 补加 / 末尾 `/` 处理 |
| `cloudPlatformProviderStore.test.ts` | save/load/clear roundtrip；override 三态（无 / 有 / 删后）；损坏 JSON 容错返 null |
| `cloudPlatformProviderService.test.ts` | sync 成功 / 24h 跳过 / override 跳过 sync / reset 后立即 sync / 5xx 不覆盖 / 401 兜底 / 并发合并 / baseUrl 校验 / 无 synced record 时 setOverride 失败 |
| `cloudAuth.test.ts` 扩展 | `getStatus` 多返 coin / subscriptionPlan |

### 组件测试

| 文件 | 覆盖 |
|---|---|
| `CloudPlatformProviderSection.test.tsx` | effective 显示、override 输入、Save 流程、Reset 按钮（disabled when not overridden）、Sync 按钮、isOverridden 徽章、lastSyncedAt 时间 |
| `Sidebar.test.tsx` 扩展 | 用户菜单渲染 coin 余额 + 套餐徽章（4 档颜色） |

### 集成测试（手动 smoke）

- macOS arm64 / x64 各跑一次完整 flow
- 真实 RunNode 测试账号 + baseUrl 配 `.env` 里的 `VITE_CLOUD_API_BASE_URL`
- 验证：登录 → 自动同步 → Sidebar 显示 coin → Settings 显示 baseUrl/apiKey/时间 → override 流程 → reset 流程 → 重启 idempotent

## Error Handling

| 错误 | 处理 |
|---|---|
| `new-api/config` 5xx | toast 错误，**不覆盖**现有 record |
| `new-api/config` 401 | 走 `cloudAuth.fetchMemberAuthorized` 自动 refresh + retry；refresh 失败 → `cloud:auth:logged-out` |
| 网络层 reject | toast 错误，保留旧 record |
| Override baseUrl 格式不合法 | 拒收，返 `error: 'baseUrl must start with http:// or https://'` |
| Override 写入时 SQLCipher 失败 | 抛错到 renderer，toast "保存失败" |
| sync 期间 24h 检查 race | `inFlightSync` 合并并发 |
| ensureSynced 在 main 启动太早 | 在 `app.whenReady()` 之后、createWindow 之前调 |
| `coin` 字段缺失 | 默认 `coin: 0`，套餐徽章 fallback "Free" |

## Out of Scope

明确**不在 B 解决**：

- ❌ 把 baseUrl/apiKey 灌到 Claude Code / Codex / OpenClaw / Hermes engine 配置 → **C**
- ❌ 把数字员工 catalog 转成各 CLI 格式 → **D**
- ❌ 套餐续费 / 升级 → 走 RunNode Portal
- ❌ 积分消耗明细 / 流水 → 走 RunNode Portal
- ❌ 多账号切换（同一时间只能一个 RunNode 账号登录，参考 A 现状）
- ❌ 把 baseUrl/apiKey 写到 `~/.openclaw/openclaw.json` 让 Gateway 直读 → **C 的事**

## Known Risks

- ⚠️ **new-api/config 字段名**：`apiKey` vs `platformAccessToken` 哪个权威——spec 写"优先 apiKey，platformAccessToken 兜底"（与 RClaw 一致）；实施时需跟业务方确认
- ⚠️ **baseUrl 末尾 `/v1` 规范化**：RunNode 后端若已返回 `/v1` 结尾的，spec 用 `\/v1$/i` 检测避免重复加
- ⚠️ **24h 阈值判定来源**：用持久化 `lastSyncedAt`（重启后仍能判断），不用 in-memory
- ⚠️ **override + sync 期间网络失败的语义**：sync 失败**保留旧 override**，用户不会被云端覆盖
- ⚠️ **override 长期不下云端的云值**：`ensureSynced` 在有 userOverride 时直接跳过，所以一旦用户设了 override，**云端 baseUrl/apiKey 可能 30+ 天不更新**（直到用户主动 reset 或点手动 sync）。这与"云端胜"的预期不完全一致。可接受的折中：override 本来就是"我比云端清楚"，让 user 主动选择何时恢复。如果用户预期是"override 也要每日检查云端变化"，需要不同的语义（spec 当前不覆盖这种需求）

## Migration

- A 已把 `cloud_user_info` 存 SQLite kv；A 的 `getStatus` 返回已包含 user 对象
- B 仅**读** user 对象里的 `coin` / `subscriptionPlan` 字段，不需要 migration
- 全新表 `cloud_platform_provider` 在第一次 sync 之前是空的；UI 在空状态下显示 "未同步" 提示
