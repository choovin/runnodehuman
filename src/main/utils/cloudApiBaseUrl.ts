import fs from 'fs';
import path from 'path';

// Default RunNode production base URL. Used as a last-resort fallback when
// neither the runtime override, the build-time environment variable, nor
// a `.env` file under `process.resourcesPath` is available. Matches the
// URL committed in `.env.production` and `.env.development`.
const DEFAULT_CLOUD_API_BASE_URL = 'https://www.runnode.ai';

// Load `.env` / `.env.production` from process.resourcesPath if present.
// electron-builder's `extraResources` copies our `vendor/bundled-runtimes`
// directory but plain `.env` files are NOT shipped by default; users who
// want to override the canonical production URL can place an `.env.production`
// next to the .app bundle (alongside `WeSight.app/`) and the main process
// will pick it up. The packaged `app.asar` already has the baked-in URL
// from the build-time `loadEnv` step in vite.config.ts.
function loadDotEnvIfPresent(): void {
  try {
    // Lazily require dotenv to avoid pulling it into the renderer bundle.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const dotenv = require('dotenv');
    const candidates = [
      // Next to the .app bundle (production override)
      path.join(process.resourcesPath ?? '', '..', '.env.production'),
      path.join(process.resourcesPath ?? '', '..', '.env'),
      // Inside Resources (electron-builder extraResources path)
      path.join(process.resourcesPath ?? '', '.env.production'),
      path.join(process.resourcesPath ?? '', '.env'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        dotenv.config({ path: candidate });
      }
    }
  } catch {
    // dotenv is optional in production; ignore failures.
  }
}

// Eagerly load on first import (idempotent).
const _loaded = (() => {
  loadDotEnvIfPresent();
  return true;
})();

let overrideBaseUrl: string | null = (globalThis as any).__CLOUD_API_BASE_URL_OVERRIDE__ ?? null;

export function setCloudApiBaseUrlOverride(url: string | null): void {
  overrideBaseUrl = url && url.trim() ? url.trim().replace(/\/+$/, '') : null;
}

export function getCloudApiBaseUrl(): string {
  if (overrideBaseUrl) return overrideBaseUrl;

  const env = process.env.VITE_CLOUD_API_BASE_URL?.trim();
  if (env) return env.replace(/\/+$/, '');

  // Fallback to the canonical RunNode production URL. Without this,
  // packaged builds (which have no `.env` file and no environment variable
  // inherited from a shell) would fail to login or sync model providers
  // with "RunNode base URL not configured".
  return DEFAULT_CLOUD_API_BASE_URL;
}
