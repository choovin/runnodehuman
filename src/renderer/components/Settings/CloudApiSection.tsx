import { useEffect, useState } from 'react';

import { configService } from '../../services/config';
import { i18nService } from '../../services/i18n';

export function CloudApiSection() {
  const [url, setUrl] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const cfg = configService.getConfig();
    setUrl(cfg.cloudApiBaseUrl ?? import.meta.env.VITE_CLOUD_API_BASE_URL ?? '');
  }, []);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      await window.electron.setCloudApiBaseUrl(url || null);
      const r = await window.electron.probeCloudBaseUrl();
      setTestResult(r);
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    await configService.updateConfig({ cloudApiBaseUrl: url });
    await window.electron.setCloudApiBaseUrl(url || null);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div className="space-y-3">
      <label className="text-sm font-medium">{i18nService.t('authCloudBaseUrlLabel')}</label>
      <input
        type="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={import.meta.env.VITE_CLOUD_API_BASE_URL}
        className="w-full rounded border border-border px-3 py-2"
      />
      <div className="flex gap-2">
        <button
          onClick={handleTest}
          disabled={testing}
          className="rounded border border-border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50"
        >
          {i18nService.t('authCloudBaseUrlTest')}
        </button>
        <button
          onClick={handleSave}
          className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground"
        >
          {i18nService.t('authCloudBaseUrlSave')}
        </button>
        {saved && <span className="text-sm text-green-500">{i18nService.t('saved')}</span>}
      </div>
      {testResult && (
        <p
          data-testid="test-result"
          className={testResult.ok ? 'text-sm text-green-500' : 'text-sm text-red-500'}
        >
          {testResult.ok
            ? i18nService.t('authCloudBaseUrlTestOk')
            : `${i18nService.t('authCloudBaseUrlTestFailed')}${testResult.error}`}
        </p>
      )}
    </div>
  );
}
