import type Database from 'better-sqlite3-multiple-ciphers';
import type { EventEmitter } from 'events';

import {
  CloudAuthRequestTimeoutMs,
  TokenExpiringSoonBufferMs,
} from '../../shared/cloudAuth/constants';
import {
  type CloudAuthTokens,
  type CloudUserInfo,
  parseMemberAuthLoginBody,
  parseMemberAuthRefreshBody,
  parseMemberUserGetBody,
} from '../../shared/cloudAuth/parsers';
import { getCloudApiBaseUrl } from '../utils/cloudApiBaseUrl';
import { CloudAuthTokenStore } from './cloudAuthTokenStore';
import { CloudUserDeviceService } from './cloudUserDeviceService';

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

  async init(): Promise<void> {
    await this.deviceService.init();
  }

  async getStatus(): Promise<{
    isLoggedIn: boolean;
    user?: CloudUserInfo;
    hasCompletedFirstLogin: boolean;
    coin: number;
    subscriptionPlan: string;
  }> {
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
      coin: user?.coin ?? 0,
      subscriptionPlan: user?.subscriptionPlan ?? '',
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
          // parsed.value.expiresIn is the absolute access-token expiry in ms epoch
          // (RunNode: data.expiresTime). Store it directly as CloudAuthTokens.expiresAt.
          expiresAt: parsed.value.expiresIn,
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

  private isExpiringSoon(t: CloudAuthTokens): boolean {
    return Date.now() >= t.expiresAt - TokenExpiringSoonBufferMs;
  }

  private async loginInternal(url: string, init: RequestInit): Promise<LoginResult> {
    try {
      const resp = await this.cloudFetch('auth:login', url, init);
      const body = (await resp.json()) as unknown;
      const parsed = parseMemberAuthLoginBody(body);
      if (parsed.ok === false) {
        return { success: false, error: parsed.error };
      }

      await this.tokenStore.save({
        accessToken: parsed.value.accessToken,
        refreshToken: parsed.value.refreshToken,
        // parsed.value.expiresIn is the absolute access-token expiry in ms epoch
        // (RunNode: data.expiresTime). Store it directly as CloudAuthTokens.expiresAt.
        expiresAt: parsed.value.expiresIn,
      });

      void this.deviceService.afterLogin().catch((e) => console.warn('[CloudAuth] device register:', e));

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
      'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)'
    ).run('cloud_user_info', JSON.stringify(user), Date.now());
  }

  private markFirstLoginComplete(): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)'
    ).run('has_completed_first_login', 'true', Date.now());
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
