import { useCallback, useEffect, useState } from 'react';

import type { CloudPlatformProviderRecord } from '@shared/cloudPlatformProvider/types';
import { effective, isOverridden } from '@shared/cloudPlatformProvider/types';

import { i18nService } from '../../services/i18n';

interface SyncResult {
  success: boolean;
  error?: string;
  record?: CloudPlatformProviderRecord;
}

function formatTimestamp(ms: number | undefined): string {
  if (!ms || ms <= 0) return i18nService.t('authCloudProviderNotSynced');
  const d = new Date(ms);
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
}

function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

export function CloudPlatformProviderSection() {
  const [record, setRecord] = useState<CloudPlatformProviderRecord | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [overrideBaseUrl, setOverrideBaseUrl] = useState('');
  const [overrideApiKey, setOverrideApiKey] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  // 拉取一次初始数据
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await window.electron.cloudPlatformProvider.get();
        if (cancelled) return;
        setRecord(r);
        setOverrideBaseUrl(r?.userOverride?.baseUrl ?? '');
        setOverrideApiKey(r?.userOverride?.apiKey ?? '');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 订阅广播更新：sync 完成 / 任何 setOverride 后 main 会再 broadcast
  useEffect(() => {
    return window.electron.cloudPlatformProvider.onUpdate((r) => {
      setRecord(r);
      // 同步覆盖输入框（避免广播覆盖到用户正在编辑的内容；这里只在 record 变化时更新 override 字段）
      setOverrideBaseUrl((prev) => r.userOverride?.baseUrl ?? prev);
      setOverrideApiKey((prev) => r.userOverride?.apiKey ?? prev);
    });
  }, []);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    setNotice(null);
    try {
      const r: SyncResult = await window.electron.cloudPlatformProvider.sync();
      if (r.success) {
        setRecord(r.record ?? null);
        setNotice({ kind: 'ok', text: i18nService.t('authCloudProviderSyncOk') });
      } else {
        setNotice({ kind: 'err', text: `${i18nService.t('authCloudProviderSyncFailed')}: ${r.error ?? ''}` });
      }
    } catch (err) {
      setNotice({ kind: 'err', text: `${i18nService.t('authCloudProviderSyncFailed')}: ${String(err)}` });
    } finally {
      setSyncing(false);
    }
  }, []);

  const handleSaveOverride = useCallback(async () => {
    setNotice(null);
    const payload: { baseUrl?: string; apiKey?: string } = {};
    if (overrideBaseUrl.trim()) payload.baseUrl = overrideBaseUrl.trim();
    if (overrideApiKey.trim()) payload.apiKey = overrideApiKey.trim();
    try {
      const r: SyncResult = await window.electron.cloudPlatformProvider.setOverride(payload);
      if (r.success) {
        setRecord(r.record ?? null);
        setNotice({ kind: 'ok', text: i18nService.t('saved') });
      } else {
        setNotice({ kind: 'err', text: r.error ?? 'unknown error' });
      }
    } catch (err) {
      setNotice({ kind: 'err', text: String(err) });
    }
  }, [overrideBaseUrl, overrideApiKey]);

  const handleReset = useCallback(async () => {
    setNotice(null);
    try {
      const r: SyncResult = await window.electron.cloudPlatformProvider.resetDefault();
      if (r.success) {
        setRecord(r.record ?? null);
        setOverrideBaseUrl('');
        setOverrideApiKey('');
        setNotice({ kind: 'ok', text: i18nService.t('saved') });
      } else {
        setNotice({ kind: 'err', text: r.error ?? 'unknown error' });
      }
    } catch (err) {
      setNotice({ kind: 'err', text: String(err) });
    }
  }, []);

  const eff = record ? effective(record) : null;
  const overridden = isOverridden(record);

  return (
    <div className="space-y-3" data-testid="cloud-platform-provider-section">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h4 className="text-sm font-medium text-foreground">
            {i18nService.t('authCloudProviderSectionTitle')}
          </h4>
          <p className="mt-0.5 text-xs text-secondary">
            {i18nService.t('authCloudProviderSectionDesc')}
          </p>
        </div>
        {record && overridden && (
          <span
            data-testid="override-tag"
            className="inline-flex items-center rounded-md bg-amber-500/10 text-amber-600 dark:text-amber-400 px-2 py-0.5 text-[11px] font-medium"
          >
            {i18nService.t('authCloudProviderOverrideTag')}
          </span>
        )}
      </div>

      {loading && !record && (
        <p className="text-sm text-secondary">…</p>
      )}

      {record && eff && (
        <div className="space-y-2">
          <div>
            <label className="text-xs text-secondary">
              {i18nService.t('authCloudProviderEffectiveBaseUrl')}
            </label>
            <input
              data-testid="effective-base-url"
              type="text"
              readOnly
              value={eff.baseUrl}
              className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm font-mono"
            />
          </div>
          <div>
            <label className="text-xs text-secondary">
              {i18nService.t('authCloudProviderEffectiveApiKey')}
            </label>
            <input
              data-testid="effective-api-key"
              type="text"
              readOnly
              value={maskApiKey(eff.apiKey)}
              className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm font-mono"
            />
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-secondary">
            {i18nService.t('authCloudProviderOverrideBaseUrl')}
          </label>
          <input
            data-testid="override-base-url"
            type="url"
            value={overrideBaseUrl}
            onChange={(e) => setOverrideBaseUrl(e.target.value)}
            placeholder={record?.baseUrl ?? ''}
            className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm font-mono"
          />
        </div>
        <div>
          <label className="text-xs text-secondary">
            {i18nService.t('authCloudProviderOverrideApiKey')}
          </label>
          <input
            data-testid="override-api-key"
            type="password"
            value={overrideApiKey}
            onChange={(e) => setOverrideApiKey(e.target.value)}
            placeholder="••••"
            className="mt-1 w-full rounded border border-border bg-background px-3 py-2 text-sm font-mono"
          />
        </div>
      </div>
      <p className="text-[11px] text-secondary">{i18nService.t('authCloudProviderOverrideHint')}</p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleSaveOverride}
          data-testid="save-override"
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary-hover transition-colors"
        >
          {i18nService.t('authCloudBaseUrlSave')}
        </button>
        <button
          type="button"
          onClick={handleReset}
          data-testid="reset-default"
          disabled={!overridden}
          className="rounded border border-border px-3 py-1 text-sm hover:bg-surface-raised disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {i18nService.t('authCloudProviderResetDefault')}
        </button>
        <button
          type="button"
          onClick={handleSync}
          disabled={syncing}
          data-testid="sync-now"
          className="rounded border border-border px-3 py-1 text-sm hover:bg-surface-raised disabled:opacity-50"
        >
          {syncing ? i18nService.t('authCloudProviderSyncing') : i18nService.t('authCloudProviderSyncNow')}
        </button>
        <span className="text-xs text-secondary" data-testid="last-synced">
          {i18nService.t('authCloudProviderLastSynced')}: {formatTimestamp(record?.lastSyncedAt)}
        </span>
      </div>

      {notice && (
        <p
          data-testid="notice"
          className={notice.kind === 'ok' ? 'text-sm text-green-500' : 'text-sm text-red-500'}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
