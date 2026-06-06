import type Database from 'better-sqlite3-multiple-ciphers';
import { ipcMain, webContents } from 'electron';
import type { EventEmitter } from 'events';

import { CloudAuthChannel } from '../../shared/cloudAuth/constants';
import { CloudPlatformProviderChannel } from '../../shared/cloudPlatformProvider/constants';
import { probeCloudBaseUrl } from '../probeCloudBaseUrl';
import { CloudAuthService } from '../services/cloudAuth';
import { CloudPlatformProviderService } from '../services/cloudPlatformProviderService';
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
    for (const wc of webContents.getAllWebContents()) {
      wc.send(CloudAuthChannel.LoggedOutEvent);
    }
  });
  broadcaster.on(CloudAuthChannel.LoginSuccessEvent, (payload) => {
    for (const wc of webContents.getAllWebContents()) {
      wc.send(CloudAuthChannel.LoginSuccessEvent, payload);
    }
  });

  return service;
}

export async function probeAndReport(): Promise<{ ok: boolean; error?: string }> {
  return probeCloudBaseUrl();
}

export function registerCloudPlatformProviderHandlers(
  service: CloudPlatformProviderService,
  broadcaster: EventEmitter
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

  // Re-broadcast events to all BrowserWindows
  broadcaster.on(CloudPlatformProviderChannel.UpdatedEvent, (record) => {
    for (const wc of webContents.getAllWebContents()) {
      wc.send(CloudPlatformProviderChannel.UpdatedEvent, record);
    }
  });
  broadcaster.on(CloudPlatformProviderChannel.SyncStartedEvent, () => {
    for (const wc of webContents.getAllWebContents()) {
      wc.send(CloudPlatformProviderChannel.SyncStartedEvent, undefined);
    }
  });
  broadcaster.on(CloudPlatformProviderChannel.SyncFailedEvent, (payload) => {
    for (const wc of webContents.getAllWebContents()) {
      wc.send(CloudPlatformProviderChannel.SyncFailedEvent, payload);
    }
  });
}

export { setCloudApiBaseUrlOverride };
