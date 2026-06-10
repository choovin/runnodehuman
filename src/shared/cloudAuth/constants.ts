export const CloudAuthChannel = {
  LoginPassword: 'cloud:auth:login-password',
  SendSmsCode: 'cloud:auth:send-sms-code',
  LoginSms: 'cloud:auth:login-sms',
  WechatQr: 'cloud:auth:wechat-qr',
  WechatPoll: 'cloud:auth:wechat-poll',
  LoginWechat: 'cloud:auth:login-wechat',
  Logout: 'cloud:auth:logout',
  GetStatus: 'cloud:auth:get-status',
  LoggedOutEvent: 'cloud:auth:logged-out',
  LoginSuccessEvent: 'cloud:auth:login-success',
} as const;
export type CloudAuthChannel = typeof CloudAuthChannel[keyof typeof CloudAuthChannel];

export const CloudLoginMethod = {
  Password: 'password',
  Sms: 'sms',
  Wechat: 'wechat',
} as const;
export type CloudLoginMethod = typeof CloudLoginMethod[keyof typeof CloudLoginMethod];

export const CloudWechatPollStatus = {
  Waiting: 'waiting',
  Scanned: 'scanned',
  Confirmed: 'confirmed',
  Expired: 'expired',
} as const;
export type CloudWechatPollStatus = typeof CloudWechatPollStatus[keyof typeof CloudWechatPollStatus];

export const WechatQrPollingIntervalMs = 2000;
export const WechatQrMaxLifetimeMs = 5 * 60 * 1000;
export const SmsCountdownSeconds = 60;
export const TokenExpiringSoonBufferMs = 5 * 60 * 1000;
export const HeartbeatIntervalMs = 5 * 60 * 1000;
export const CloudAuthRequestTimeoutMs = 15 * 1000;
