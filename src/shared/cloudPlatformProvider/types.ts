export interface CloudPlatformProviderRecord {
  baseUrl: string;
  apiKey: string;
  lastSyncedAt: number;
  userOverride?: {
    baseUrl?: string;
    apiKey?: string;
  };
}

export const isOverridden = (
  r: CloudPlatformProviderRecord | null | undefined
): boolean =>
  r?.userOverride != null
  && (r.userOverride.baseUrl != null || r.userOverride.apiKey != null);

export const effective = (r: CloudPlatformProviderRecord): { baseUrl: string; apiKey: string } => ({
  baseUrl: r.userOverride?.baseUrl ?? r.baseUrl,
  apiKey: r.userOverride?.apiKey ?? r.apiKey,
});

export type PlatformProviderUpdatedPayload = { record: CloudPlatformProviderRecord };
export type PlatformProviderSyncFailedPayload = { error: string };
