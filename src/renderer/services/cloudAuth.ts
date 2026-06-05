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
      // @ts-expect-error TODO(spec-a): window.electron.cloudAuth bindings land in task 12
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

    this.unsubLoggedOut = // @ts-expect-error TODO(spec-a): window.electron.cloudAuth bindings land in task 12
      window.electron.cloudAuth.onLoggedOut(() => {
        store.dispatch(setLoggedOut());
      });
    this.unsubLoginSuccess = // @ts-expect-error TODO(spec-a): window.electron.cloudAuth bindings land in task 12
      window.electron.cloudAuth.onLoginSuccess((payload: { user: CloudUserInfo }) => {
        store.dispatch(setLoggedIn({ user: payload.user }));
      });
  }

  async loginWithPassword(mobile: string, password: string) {
    // @ts-expect-error TODO(spec-a): window.electron.cloudAuth bindings land in task 12
    return window.electron.cloudAuth.loginWithPassword({ mobile, password });
  }

  async sendSmsCode(mobile: string) {
    // @ts-expect-error TODO(spec-a): window.electron.cloudAuth bindings land in task 12
    return window.electron.cloudAuth.sendSmsCode({ mobile });
  }

  async loginWithSms(mobile: string, code: string) {
    // @ts-expect-error TODO(spec-a): window.electron.cloudAuth bindings land in task 12
    return window.electron.cloudAuth.loginWithSms({ mobile, code });
  }

  async wechatGetQr(redirectUri: string) {
    // @ts-expect-error TODO(spec-a): window.electron.cloudAuth bindings land in task 12
    return window.electron.cloudAuth.wechatGetQr({ redirectUri });
  }

  async wechatPoll(ticket: string) {
    // @ts-expect-error TODO(spec-a): window.electron.cloudAuth bindings land in task 12
    return window.electron.cloudAuth.wechatPoll({ ticket });
  }

  async loginWithWechat(code: string, state: string) {
    // @ts-expect-error TODO(spec-a): window.electron.cloudAuth bindings land in task 12
    return window.electron.cloudAuth.loginWithWechat({ code, state });
  }

  async logout() {
    // @ts-expect-error TODO(spec-a): window.electron.cloudAuth bindings land in task 12
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
