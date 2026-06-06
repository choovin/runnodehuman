import type Database from 'better-sqlite3-multiple-ciphers';
import type { EventEmitter } from 'events';

import { CloudAuthChannel } from '../../shared/cloudAuth/constants';
import {
  CloudPlatformProviderChannel,
  PlatformProviderConfigPath,
  PlatformProviderSyncThresholdMs,
} from '../../shared/cloudPlatformProvider/constants';
import { parseNewApiConfig } from '../../shared/cloudPlatformProvider/parsers';
import type { CloudPlatformProviderRecord } from '../../shared/cloudPlatformProvider/types';
import { getCloudApiBaseUrl } from '../utils/cloudApiBaseUrl';
import { CloudAuthService } from './cloudAuth';
import { CloudPlatformProviderStore } from './cloudPlatformProviderStore';

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
        const baseUrl = getCloudApiBaseUrl();
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
        if (parsed.ok === false) {
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
    await this.sync().catch((e) =>
      console.error('[CloudPlatformProvider] post-reset sync failed:', e)
    );
    return { success: true };
  }
}
