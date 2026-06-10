import { CloudAuthRequestTimeoutMs } from '../../shared/cloudAuth/constants';

export class CloudFetchError extends Error {
  constructor(
    public readonly label: string,
    public readonly status: number,
    public readonly body: unknown
  ) {
    super(`[${label}] HTTP ${status}`);
    this.name = 'CloudFetchError';
  }
}

export async function cloudFetch(
  label: string,
  url: string,
  init?: RequestInit
): Promise<Response> {
  const merged: RequestInit = {
    ...init,
    signal: init?.signal ?? AbortSignal.timeout(CloudAuthRequestTimeoutMs),
  };

  let resp: Response;
  try {
    resp = await fetch(url, merged);
  } catch (e) {
    console.error(`[CloudFetch] ${label} network error:`, e);
    throw e;
  }

  if (!resp.ok) {
    let body: unknown = null;
    try {
      body = await resp.json();
    } catch {
      // ignore body parse errors
    }
    if (resp.status >= 500) {
      console.error(`[CloudFetch] ${label} HTTP ${resp.status}`);
    }
    throw new CloudFetchError(label, resp.status, body);
  }

  return resp;
}
