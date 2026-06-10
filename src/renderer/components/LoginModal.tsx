import { useEffect,useState } from 'react';

import { SmsCountdownSeconds } from '../../shared/cloudAuth/constants';
import { cloudAuthService } from '../services/cloudAuth';
import { i18nService } from '../services/i18n';
import { WechatQrDialog } from './WechatQrDialog';

interface LoginModalProps {
  isFirstRun?: boolean;
  onClose?: () => void;
  onSuccess?: () => void;
}

type Tab = 'password' | 'sms' | 'wechat';

export function LoginModal({ isFirstRun, onClose, onSuccess }: LoginModalProps) {
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
