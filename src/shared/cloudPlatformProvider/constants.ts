export const CloudPlatformProviderChannel = {
  Get: 'cloud:platform-provider:get',
  Sync: 'cloud:platform-provider:sync',
  SetOverride: 'cloud:platform-provider:set-override',
  ResetDefault: 'cloud:platform-provider:reset-default',
  UpdatedEvent: 'cloud:platform-provider:updated',
  SyncFailedEvent: 'cloud:platform-provider:sync-failed',
} as const;
export type CloudPlatformProviderChannel =
  typeof CloudPlatformProviderChannel[keyof typeof CloudPlatformProviderChannel];

/** 同步间隔阈值：超过此时间后启动 idempotent 检查会重新同步 */
export const PlatformProviderSyncThresholdMs = 24 * 60 * 60 * 1000;

/** new-api/config 端点路径 */
export const PlatformProviderConfigPath = '/app-api/member/new-api/config';
