import { describe, expect,test } from 'vitest';

import {
  parseMemberAuthLoginBody,
  parseMemberAuthRefreshBody,
  parseMemberUserGetBody,
} from './parsers';

describe('parseMemberAuthLoginBody', () => {
  test('parses RunNode production response (curl-verified 2026-06-06)', () => {
    // Mirrors the actual shape returned by https://www.runnode.cn/app-api/member/auth/login.
    // The login response carries no nested userInfo — the service layer fetches the
    // profile via /app-api/member/user/get after a successful login.
    const raw = {
      code: 0,
      msg: 'SUCCESS',
      data: {
        userId: 15111171271,
        accessToken: '1185ae4d5b74415db50d7e897313b55e',
        refreshToken: '6773565343bc4ba1896e813c3c3e627e',
        expiresTime: 1780932491889,
        openid: null,
        giveCoin: null,
      },
    };
    const r = parseMemberAuthLoginBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.accessToken).toBe('1185ae4d5b74415db50d7e897313b55e');
      expect(r.value.refreshToken).toBe('6773565343bc4ba1896e813c3c3e627e');
      expect(r.value.expiresIn).toBe(1780932491889);
      // userInfo falls back to an empty shell; the service layer overwrites it
      // with the real profile from /user/get.
      expect(r.value.userInfo.id).toBe(0);
      expect(r.value.userInfo.username).toBe('');
    }
  });

  test('parses flat response (no data wrapper)', () => {
    const raw = {
      accessToken: 'at-123',
      refreshToken: 'rt-456',
      expiresTime: 1780932491889,
    };
    const r = parseMemberAuthLoginBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.accessToken).toBe('at-123');
      expect(r.value.expiresIn).toBe(1780932491889);
    }
  });

  test('handles code 200 (alternate success code)', () => {
    const raw = { code: 200, data: { accessToken: 'a', refreshToken: 'r', expiresTime: 1780932491889 } };
    const r = parseMemberAuthLoginBody(raw);
    expect(r.ok).toBe(true);
  });

  test('rejects on missing accessToken', () => {
    const raw = { code: 0, data: { refreshToken: 'r', expiresTime: 1780932491889 } };
    const r = parseMemberAuthLoginBody(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/accessToken/);
  });

  test('rejects on business error code', () => {
    const raw = { code: 401, message: 'invalid credentials' };
    const r = parseMemberAuthLoginBody(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid credentials');
  });

  test('rejects when neither expiresTime nor expiresIn is present', () => {
    const raw = { code: 0, data: { accessToken: 'a', refreshToken: 'r' } };
    const r = parseMemberAuthLoginBody(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('missing expiresTime');
  });

  test('picks userInfo when caller includes it (legacy RClaw-style compatibility)', () => {
    const raw = {
      code: 0,
      data: {
        accessToken: 'at-1',
        refreshToken: 'rt-1',
        expiresTime: 1780932491889,
        userInfo: { id: 1, username: 'u', nickname: 'n' },
      },
    };
    const r = parseMemberAuthLoginBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.userInfo.id).toBe(1);
      expect(r.value.userInfo.username).toBe('u');
      expect(r.value.userInfo.nickname).toBe('n');
    }
  });
});

describe('parseMemberAuthRefreshBody', () => {
  test('parses RunNode refresh response (curl-verified 2026-06-06)', () => {
    // Same shape as the login response minus accessToken. refreshToken is
    // sometimes reused without rotation.
    const raw = {
      code: 0,
      msg: 'SUCCESS',
      data: {
        userId: 15111171271,
        accessToken: '2d81ac6dd0794cb488bbbd8bb19106a2',
        refreshToken: '6773565343bc4ba1896e813c3c3e627e',
        expiresTime: 1780932540496,
        openid: null,
        giveCoin: null,
      },
    };
    const r = parseMemberAuthRefreshBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.accessToken).toBe('2d81ac6dd0794cb488bbbd8bb19106a2');
      expect(r.value.refreshToken).toBe('6773565343bc4ba1896e813c3c3e627e');
      expect(r.value.expiresIn).toBe(1780932540496);
    }
  });

  test('keeps empty refreshToken when server does not return a new one', () => {
    const raw = { code: 0, data: { accessToken: 'a2', expiresTime: 1780932491889 } };
    const r = parseMemberAuthRefreshBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.refreshToken).toBe('');
  });

  test('rejects on non-zero code', () => {
    const raw = { code: 401, message: 'expired' };
    const r = parseMemberAuthRefreshBody(raw);
    expect(r.ok).toBe(false);
  });

  test('rejects on missing accessToken', () => {
    const raw = { code: 0, data: { refreshToken: 'r', expiresTime: 1780932491889 } };
    const r = parseMemberAuthRefreshBody(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/accessToken/);
  });

  test('rejects on missing expiresTime', () => {
    const raw = { code: 0, data: { accessToken: 'a' } };
    const r = parseMemberAuthRefreshBody(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('missing expiresTime');
  });
});

describe('parseMemberUserGetBody', () => {
  test('parses RunNode production response (curl-verified 2026-06-06)', () => {
    // Mirrors the actual shape returned by https://www.runnode.cn/app-api/member/user/get.
    // - `id` is the numeric user id (no `username` field on RunNode)
    // - `vip.vipName` is the subscription plan
    // - `coin` is a float
    const raw = {
      code: 0,
      msg: 'SUCCESS',
      data: {
        id: 15111171271,
        nickname: 'choovin',
        avatar: 'https://rn-oss-cn-guangzhou.runnode.cn/rn-input/input/x.png',
        mobile: '15521113501',
        sex: 1,
        coin: 4549264.74,
        cash: 57.6734,
        inviteCode: 'IUH78QJ0',
        signature: '这个人很懒！',
        watermark: '',
        vip: {
          vipId: 15111171270,
          vipName: '大师版 Pro ',
          vipLevel: 6,
          startTime: 1778428800000,
          endTime: 1781107199000,
        },
      },
    };
    const r = parseMemberUserGetBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe(15111171271);
      expect(r.value.username).toBe('choovin'); // fallback: nickname
      expect(r.value.nickname).toBe('choovin');
      expect(r.value.mobile).toBe('15521113501');
      expect(r.value.avatar).toContain('rn-oss-cn-guangzhou.runnode.cn');
      expect(r.value.subscriptionPlan).toBe('大师版 Pro '); // pulled from vip.vipName
      expect(r.value.coin).toBe(4549264.74);
    }
  });

  test('accepts legacy RClaw-style fields (subscriptionPlan, username) when present', () => {
    const raw = {
      code: 0,
      data: {
        id: 42,
        username: 'u',
        nickname: 'nick',
        mobile: '13800138000',
        avatar: 'https://example.com/avatar.png',
        subscriptionPlan: 'Plus',
        coin: 1000,
      },
    };
    const r = parseMemberUserGetBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe(42);
      expect(r.value.username).toBe('u');
      expect(r.value.subscriptionPlan).toBe('Plus');
      expect(r.value.coin).toBe(1000);
    }
  });

  test('handles minimal payload (only id, no name fields)', () => {
    const raw = { code: 0, data: { id: 1 } };
    const r = parseMemberUserGetBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.id).toBe(1);
      expect(r.value.username).toBe('1'); // id-to-string fallback
      expect(r.value.nickname).toBeUndefined();
      expect(r.value.coin).toBeUndefined();
    }
  });

  test('handles RunNode vip object without subscriptionPlan top-level', () => {
    const raw = {
      code: 0,
      data: { id: 7, nickname: 'p', coin: 1, vip: { vipName: 'Pro Max' } },
    };
    const r = parseMemberUserGetBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.subscriptionPlan).toBe('Pro Max');
    }
  });

  test('rejects on non-zero code', () => {
    const raw = { code: 401, message: 'unauthorized' };
    const r = parseMemberUserGetBody(raw);
    expect(r.ok).toBe(false);
  });
});
