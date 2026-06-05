import { describe, test, expect, beforeEach, vi } from 'vitest';

describe('getCloudApiBaseUrl', () => {
  beforeEach(() => {
    vi.resetModules();
    delete (globalThis as any).__CLOUD_API_BASE_URL_OVERRIDE__;
    delete process.env.VITE_CLOUD_API_BASE_URL;
  });

  test('reads from override when set', async () => {
    (globalThis as any).__CLOUD_API_BASE_URL_OVERRIDE__ = 'https://override.example.com';
    process.env.VITE_CLOUD_API_BASE_URL = 'https://env.example.com';
    const { getCloudApiBaseUrl } = await import('./cloudApiBaseUrl');
    expect(getCloudApiBaseUrl()).toBe('https://override.example.com');
  });

  test('falls back to env when no override', async () => {
    process.env.VITE_CLOUD_API_BASE_URL = 'https://env.example.com';
    const { getCloudApiBaseUrl } = await import('./cloudApiBaseUrl');
    expect(getCloudApiBaseUrl()).toBe('https://env.example.com');
  });

  test('throws when neither set', async () => {
    const { getCloudApiBaseUrl } = await import('./cloudApiBaseUrl');
    expect(() => getCloudApiBaseUrl()).toThrow(/RunNode base URL/);
  });
});
