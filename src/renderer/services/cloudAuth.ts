import { store } from '../store';
import type { CloudUserInfo } from '../store/slices/cloudAuthSlice';
import { setAuthLoading, setAuthStatus, setLoggedIn, setLoggedOut } from '../store/slices/cloudAuthSlice';

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
