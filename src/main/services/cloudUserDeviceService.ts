import type Database from 'better-sqlite3-multiple-ciphers';
import { v4 as uuidv4 } from 'uuid';

import { CloudAuthRequestTimeoutMs,HeartbeatIntervalMs } from '../../shared/cloudAuth/constants';
import { getCloudApiBaseUrl } from '../utils/cloudApiBaseUrl';
import { CloudAuthTokenStore } from './cloudAuthTokenStore';
import { CloudUserDeviceStore } from './cloudUserDeviceStore';

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
