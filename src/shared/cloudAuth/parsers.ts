export interface CloudUserInfo {
  id: string | number;
  username: string;
  nickname?: string;
  mobile?: string;
  avatar?: string;
  subscriptionPlan?: string;
  coin?: number;
}

export interface CloudAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // ms epoch
}

export type ParserResult<T> = { ok: true; value: T } | { ok: false; error: string };

// RunNode auth response field conventions (verified by curl against production):
//   - expiresTime is the absolute access-token expiry in milliseconds since epoch.
//     We expose it as `expiresIn` (number, ms) so the caller can store it directly
//     into CloudAuthTokens.expiresAt (also ms). The previous RClaw-style contract
//     used a relative `expiresIn` in seconds; do not reintroduce that.
//   - The login response does NOT embed a userInfo object. User profile is fetched
//     separately via /app-api/member/user/get (the service layer does this after
//     login). Parsing the login body must tolerate an absent userInfo.
//   - The /user/get response uses `vip.vipName` (e.g. "大师版 Pro ") for the
//     subscription plan and floats for `coin` (e.g. 4549264.74). We map
//     vip.vipName into CloudUserInfo.subscriptionPlan and round coin to int.

function isString(x: unknown): x is string {
  return typeof x === 'string' && x.length > 0;
}

function isNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function unwrapData(raw: unknown): Record<string, unknown> {
  if (raw == null || typeof raw !== 'object') return {};
  const root = raw as Record<string, unknown>;
  if (root.data != null && typeof root.data === 'object' && !Array.isArray(root.data)) {
    return root.data as Record<string, unknown>;
  }
  return root;
}

function isBusinessError(raw: unknown): { error: boolean; message: string } {
  if (raw == null || typeof raw !== 'object') return { error: false, message: '' };
  const r = raw as Record<string, unknown>;
  const code = r.code;
  if (code === 0 || code === 200 || code === undefined || code === null) {
    return { error: false, message: '' };
  }
  return { error: true, message: (r.message as string) || `business error code ${code}` };
}

function pickExpiresInMs(data: Record<string, unknown>): number | null {
  // RunNode convention: `expiresTime` is the absolute access-token expiry in
  // milliseconds since the Unix epoch. The previous RClaw-style contract used
  // a relative `expiresIn` in seconds — only kept as a defensive fallback.
  if (isNumber(data.expiresTime)) return data.expiresTime;
  if (isNumber(data.expiresIn)) return data.expiresIn * 1000;
  return null;
}

function pickUserId(u: Record<string, unknown>): string | number {
  if (isNumber(u.id)) return u.id;
  if (isString(u.id)) return u.id;
  if (isNumber(u.userId)) return u.userId;
  if (isString(u.userId)) return u.userId;
  return 0;
}

function pickUsername(u: Record<string, unknown>, id: string | number): string {
  if (isString(u.username)) return u.username;
  if (isString(u.nickname)) return u.nickname;
  if (isString(u.mobile)) return u.mobile;
  if (isString(id)) return id;
  if (isNumber(id) && id !== 0) return String(id);
  return '';
}

function pickSubscriptionPlan(u: Record<string, unknown>): string | undefined {
  if (isString(u.subscriptionPlan)) return u.subscriptionPlan;
  // RunNode /user/get nests the plan under `vip.vipName`.
  const vip = u.vip;
  if (vip != null && typeof vip === 'object' && !Array.isArray(vip)) {
    const vipName = (vip as Record<string, unknown>).vipName;
    if (isString(vipName)) return vipName;
  }
  return undefined;
}

function pickCoin(u: Record<string, unknown>): number | undefined {
  if (isNumber(u.coin)) return u.coin;
  if (isNumber(u.giveCoin)) return u.giveCoin;
  return undefined;
}

function buildUserFromUnknown(input: unknown): CloudUserInfo {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { id: 0, username: '' };
  }
  const u = input as Record<string, unknown>;
  const id = pickUserId(u);
  return {
    id,
    username: pickUsername(u, id),
    nickname: isString(u.nickname) ? u.nickname : undefined,
    mobile: isString(u.mobile) ? u.mobile : undefined,
    avatar: isString(u.avatar) ? u.avatar : undefined,
    subscriptionPlan: pickSubscriptionPlan(u),
    coin: pickCoin(u),
  };
}

export function parseMemberAuthLoginBody(raw: unknown): ParserResult<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // ms since epoch; consumer stores directly as CloudAuthTokens.expiresAt
  userInfo: CloudUserInfo;
}> {
  const err = isBusinessError(raw);
  if (err.error) return { ok: false, error: err.message };

  const data = unwrapData(raw);
  const accessToken = data.accessToken;
  const refreshToken = data.refreshToken;
  const expiresIn = pickExpiresInMs(data);

  if (!isString(accessToken)) return { ok: false, error: 'missing accessToken' };
  if (!isString(refreshToken)) return { ok: false, error: 'missing refreshToken' };
  if (expiresIn == null) return { ok: false, error: 'missing expiresTime' };

  return {
    ok: true,
    value: {
      accessToken,
      refreshToken,
      expiresIn,
      userInfo: buildUserFromUnknown(data.userInfo),
    },
  };
}

export function parseMemberAuthRefreshBody(raw: unknown): ParserResult<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // ms since epoch
}> {
  const err = isBusinessError(raw);
  if (err.error) return { ok: false, error: err.message };

  const data = unwrapData(raw);
  const accessToken = data.accessToken;
  const expiresIn = pickExpiresInMs(data);
  const refreshToken = data.refreshToken;

  if (!isString(accessToken)) return { ok: false, error: 'missing accessToken' };
  if (expiresIn == null) return { ok: false, error: 'missing expiresTime' };

  return {
    ok: true,
    value: {
      accessToken,
      refreshToken: isString(refreshToken) ? refreshToken : '',
      expiresIn,
    },
  };
}

export function parseMemberUserGetBody(raw: unknown): ParserResult<CloudUserInfo> {
  const err = isBusinessError(raw);
  if (err.error) return { ok: false, error: err.message };

  const data = unwrapData(raw);
  const id = pickUserId(data);
  const user: CloudUserInfo = {
    id,
    username: pickUsername(data, id),
    nickname: isString(data.nickname) ? data.nickname : undefined,
    mobile: isString(data.mobile) ? data.mobile : undefined,
    avatar: isString(data.avatar) ? data.avatar : undefined,
    subscriptionPlan: pickSubscriptionPlan(data),
    coin: pickCoin(data),
  };
  return { ok: true, value: user };
}
