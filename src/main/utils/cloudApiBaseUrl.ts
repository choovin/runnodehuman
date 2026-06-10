let overrideBaseUrl: string | null = (globalThis as any).__CLOUD_API_BASE_URL_OVERRIDE__ ?? null;

export function setCloudApiBaseUrlOverride(url: string | null): void {
  overrideBaseUrl = url && url.trim() ? url.trim().replace(/\/+$/, '') : null;
}

export function getCloudApiBaseUrl(): string {
  if (overrideBaseUrl) return overrideBaseUrl;

  const env = process.env.VITE_CLOUD_API_BASE_URL?.trim();
  if (env) return env.replace(/\/+$/, '');

  throw new Error(
    'RunNode base URL not configured. Set VITE_CLOUD_API_BASE_URL at build time ' +
    'or configure it in Settings.'
  );
}
