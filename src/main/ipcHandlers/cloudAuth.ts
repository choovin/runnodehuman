import type Database from 'better-sqlite3-multiple-ciphers';
import { ipcMain, webContents } from 'electron';
import type { EventEmitter } from 'events';

import { CloudAuthChannel } from '../../shared/cloudAuth/constants';
import { probeCloudBaseUrl } from '../probeCloudBaseUrl';
import { CloudAuthService } from '../services/cloudAuth';
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

export { setCloudApiBaseUrlOverride };
