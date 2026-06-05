import { getCloudApiBaseUrl } from './utils/cloudApiBaseUrl';

export async function probeCloudBaseUrl(): Promise<{ ok: boolean; error?: string }> {
  const baseUrl = getCloudApiBaseUrl();
  try {
    const resp = await fetch(`${baseUrl}/app-api/member/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'tenant-id': '1' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status >= 400 && resp.status < 500) {
      // 4xx means we reached the server and it understood us (just rejected us for bad input)
      return { ok: true };
    }
    if (resp.status >= 500) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
