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

export function parseMemberAuthLoginBody(raw: unknown): ParserResult<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userInfo: CloudUserInfo;
}> {
  const err = isBusinessError(raw);
  if (err.error) return { ok: false, error: err.message };

  const data = unwrapData(raw);
  const accessToken = data.accessToken;
  const refreshToken = data.refreshToken;
  const expiresIn = data.expiresIn;
  const userInfo = data.userInfo;

  if (!isString(accessToken)) return { ok: false, error: 'missing accessToken' };
  if (!isString(refreshToken)) return { ok: false, error: 'missing refreshToken' };
  if (!isNumber(expiresIn)) return { ok: false, error: 'missing expiresIn' };

  let parsedUser: CloudUserInfo;
  if (userInfo == null || typeof userInfo !== 'object') {
    parsedUser = { id: 0, username: '' };
  } else {
    const u = userInfo as Record<string, unknown>;
    parsedUser = {
      id: (u.id as string | number) ?? 0,
      username: (u.username as string) ?? '',
      nickname: u.nickname as string | undefined,
      mobile: u.mobile as string | undefined,
      avatar: u.avatar as string | undefined,
      subscriptionPlan: u.subscriptionPlan as string | undefined,
      coin: isNumber(u.coin) ? u.coin : 0,
    };
  }

  return { ok: true, value: { accessToken, refreshToken, expiresIn, userInfo: parsedUser } };
}

export function parseMemberAuthRefreshBody(raw: unknown): ParserResult<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const err = isBusinessError(raw);
  if (err.error) return { ok: false, error: err.message };

  const data = unwrapData(raw);
  const accessToken = data.accessToken;
  const expiresIn = data.expiresIn;
  const refreshToken = data.refreshToken;

  if (!isString(accessToken)) return { ok: false, error: 'missing accessToken' };
  if (!isNumber(expiresIn)) return { ok: false, error: 'missing expiresIn' };

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
  if (!isString(data.username)) return { ok: false, error: 'missing username' };

  return {
    ok: true,
    value: {
      id: (data.id as string | number) ?? 0,
      username: data.username,
      nickname: data.nickname as string | undefined,
      mobile: data.mobile as string | undefined,
      avatar: data.avatar as string | undefined,
      subscriptionPlan: data.subscriptionPlan as string | undefined,
      coin: isNumber(data.coin) ? data.coin : 0,
    },
  };
}
