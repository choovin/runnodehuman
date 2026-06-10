import { beforeEach,describe, expect, test, vi } from 'vitest';

let mockFetch: ReturnType<typeof vi.fn>;

describe('cloudFetch', () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    (globalThis as any).fetch = mockFetch;
  });

  test('returns response on 2xx', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
    const { cloudFetch } = await import('./cloudFetch');
    const r = await cloudFetch('test', 'https://api.example.com/x');
    expect(r.status).toBe(200);
  });

  test('throws CloudFetchError on non-ok response with body', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ code: 400, message: 'bad' }),
    });
    const { cloudFetch, CloudFetchError } = await import('./cloudFetch');
    await expect(cloudFetch('test', 'https://api.example.com/x')).rejects.toBeInstanceOf(CloudFetchError);
  });
});
