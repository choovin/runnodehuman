import type { CloudPlatformProviderRecord } from './types';

export type ParserResult<T> = { ok: true; value: T } | { ok: false; error: string };

function unwrapData(raw: unknown): Record<string, unknown> {
  if (raw == null || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  if (r.data != null && typeof r.data === 'object' && !Array.isArray(r.data)) {
    return r.data as Record<string, unknown>;
  }
  return r;
}

function isBusinessError(raw: unknown): string | null {
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const code = r.code;
  if (code === 0 || code === 200 || code === undefined || code === null) return null;
  return (r.message as string) || `business error code ${code}`;
}

/** 规范化 baseUrl：若末尾不是 /v1 则自动追加；不重复加 */
export function ensureOpenAiCompatibleBaseUrlV1(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const noTrailingSlash = trimmed.replace(/\/+$/, '');
  if (/\/v1$/i.test(noTrailingSlash)) return noTrailingSlash;
  return `${noTrailingSlash}/v1`;
}

/** 解析 new-api/config 响应，权威字段 apiKey，platformAccessToken 兜底 */
export function parseNewApiConfig(
  raw: unknown
): ParserResult<Pick<CloudPlatformProviderRecord, 'baseUrl' | 'apiKey'>> {
  const err = isBusinessError(raw);
  if (err) return { ok: false, error: err };

  const data = unwrapData(raw);
  const baseUrlRaw = (typeof data.baseUrl === 'string' ? data.baseUrl.trim() : '')
    || (typeof data.apiUrl === 'string' ? data.apiUrl.trim() : '');
  if (!baseUrlRaw) return { ok: false, error: 'missing baseUrl/apiUrl' };
  const baseUrl = ensureOpenAiCompatibleBaseUrlV1(baseUrlRaw);

  const apiKey = (typeof data.apiKey === 'string' && data.apiKey.trim())
    || (typeof data.platformAccessToken === 'string' && data.platformAccessToken.trim())
    || '';
  if (!apiKey) return { ok: false, error: 'missing apiKey/platformAccessToken' };

  return { ok: true, value: { baseUrl, apiKey } };
}
