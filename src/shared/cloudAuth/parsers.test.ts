import { describe, expect,test } from 'vitest';

import {
  parseMemberAuthLoginBody,
  parseMemberAuthRefreshBody,
  parseMemberUserGetBody,
} from './parsers';

describe('parseMemberAuthLoginBody', () => {
  test('parses standard wrapped response', () => {
    const raw = {
      code: 0,
      data: {
        accessToken: 'at-123',
        refreshToken: 'rt-456',
        expiresIn: 7200,
        userInfo: { id: 1, username: 'u', nickname: 'n' },
      },
    };
    const r = parseMemberAuthLoginBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.accessToken).toBe('at-123');
      expect(r.value.refreshToken).toBe('rt-456');
      expect(r.value.expiresIn).toBe(7200);
      expect(r.value.userInfo.username).toBe('u');
    }
  });

  test('parses flat response (no data wrapper)', () => {
    const raw = {
      accessToken: 'at-123',
      refreshToken: 'rt-456',
      expiresIn: 7200,
      userInfo: { id: 1, username: 'u' },
    };
    const r = parseMemberAuthLoginBody(raw);
    expect(r.ok).toBe(true);
  });

  test('handles code 200 (alternate success code)', () => {
    const raw = { code: 200, data: { accessToken: 'a', refreshToken: 'r', expiresIn: 60 } };
    const r = parseMemberAuthLoginBody(raw);
    expect(r.ok).toBe(true);
  });

  test('rejects on missing accessToken', () => {
    const raw = { code: 0, data: { refreshToken: 'r', expiresIn: 60 } };
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
});

describe('parseMemberAuthRefreshBody', () => {
  test('parses with new refreshToken rotation', () => {
    const raw = { code: 0, data: { accessToken: 'a2', refreshToken: 'r2', expiresIn: 7200 } };
    const r = parseMemberAuthRefreshBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.accessToken).toBe('a2');
      expect(r.value.refreshToken).toBe('r2');
      expect(r.value.expiresIn).toBe(7200);
    }
  });

  test('parses without new refreshToken (server keeps old)', () => {
    const raw = { code: 0, data: { accessToken: 'a2', expiresIn: 7200 } };
    const r = parseMemberAuthRefreshBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.refreshToken).toBe('');
  });

  test('rejects on non-zero code', () => {
    const raw = { code: 401, message: 'expired' };
    const r = parseMemberAuthRefreshBody(raw);
    expect(r.ok).toBe(false);
  });
});

describe('parseMemberUserGetBody', () => {
  test('parses standard wrapped response', () => {
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
      expect(r.value.subscriptionPlan).toBe('Plus');
      expect(r.value.coin).toBe(1000);
    }
  });

  test('handles missing optional fields', () => {
    const raw = { code: 0, data: { id: 1, username: 'u' } };
    const r = parseMemberUserGetBody(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.nickname).toBeUndefined();
      expect(r.value.coin).toBe(0);
    }
  });

  test('rejects on non-zero code', () => {
    const raw = { code: 401, message: 'unauthorized' };
    const r = parseMemberUserGetBody(raw);
    expect(r.ok).toBe(false);
  });
});
