import { useEffect, useRef,useState } from 'react';

import {
  WechatQrMaxLifetimeMs,
  WechatQrPollingIntervalMs,
} from '../../shared/cloudAuth/constants';
import { cloudAuthService } from '../services/cloudAuth';
import { i18nService } from '../services/i18n';

interface WechatQrDialogProps {
  onSuccess: () => void;
  onCancel: () => void;
}

export function WechatQrDialog({ onSuccess, onCancel }: WechatQrDialogProps) {
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [ticket, setTicket] = useState<string | null>(null);
  const [status, setStatus] = useState<'waiting' | 'scanned' | 'confirmed' | 'expired'>('waiting');
  const [error, setError] = useState<string | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        setStatus(r.status as 'waiting' | 'scanned' | 'confirmed' | 'expired');
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
