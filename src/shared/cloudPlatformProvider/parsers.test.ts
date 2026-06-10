import { describe, expect, test } from 'vitest';

import {
  ensureOpenAiCompatibleBaseUrlV1,
  parseNewApiConfig,
} from './parsers';

describe('ensureOpenAiCompatibleBaseUrlV1', () => {
  test('appends /v1 when missing', () => {
    expect(ensureOpenAiCompatibleBaseUrlV1('https://api.example.com')).toBe('https://api.example.com/v1');
  });
  test('strips trailing slashes before adding /v1', () => {
    expect(ensureOpenAiCompatibleBaseUrlV1('https://api.example.com/')).toBe('https://api.example.com/v1');
    expect(ensureOpenAiCompatibleBaseUrlV1('https://api.example.com///')).toBe('https://api.example.com/v1');
  });
  test('does not double-append when already ends in /v1', () => {
    expect(ensureOpenAiCompatibleBaseUrlV1('https://api.example.com/v1')).toBe('https://api.example.com/v1');
    expect(ensureOpenAiCompatibleBaseUrlV1('https://api.example.com/v1/')).toBe('https://api.example.com/v1');
  });
  test('is case-insensitive on /V1 detection', () => {
    expect(ensureOpenAiCompatibleBaseUrlV1('https://api.example.com/V1')).toBe('https://api.example.com/V1');
  });
  test('returns empty string unchanged', () => {
    expect(ensureOpenAiCompatibleBaseUrlV1('')).toBe('');
  });
});

describe('parseNewApiConfig', () => {
  test('parses standard wrapped response with apiKey', () => {
    const raw = { code: 0, data: { baseUrl: 'https://api.example.com', apiKey: 'sk-abc' } };
    const r = parseNewApiConfig(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.baseUrl).toBe('https://api.example.com/v1');
      expect(r.value.apiKey).toBe('sk-abc');
    }
  });
  test('parses flat response (no data wrapper)', () => {
    const raw = { baseUrl: 'https://api.example.com', apiKey: 'sk-abc' };
    const r = parseNewApiConfig(raw);
    expect(r.ok).toBe(true);
  });
  test('falls back to platformAccessToken when apiKey missing', () => {
    const raw = { code: 0, data: { baseUrl: 'https://api.example.com', platformAccessToken: 'pat-xyz' } };
    const r = parseNewApiConfig(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.apiKey).toBe('pat-xyz');
  });
  test('handles code 200 (alternate success)', () => {
    const raw = { code: 200, data: { baseUrl: 'https://api.example.com', apiKey: 'sk' } };
    const r = parseNewApiConfig(raw);
    expect(r.ok).toBe(true);
  });
  test('rejects on missing baseUrl', () => {
    const raw = { code: 0, data: { apiKey: 'sk' } };
    const r = parseNewApiConfig(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/baseUrl/);
  });
  test('rejects on missing apiKey AND platformAccessToken', () => {
    const raw = { code: 0, data: { baseUrl: 'https://api.example.com' } };
    const r = parseNewApiConfig(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/apiKey|platformAccessToken/);
  });
  test('rejects on business error', () => {
    const raw = { code: 401, message: 'unauthorized' };
    const r = parseNewApiConfig(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('unauthorized');
  });
});
