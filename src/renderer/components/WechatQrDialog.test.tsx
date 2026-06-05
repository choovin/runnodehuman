import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach,describe, expect, test, vi } from 'vitest';

import { WechatQrDialog } from './WechatQrDialog';

vi.mock('../services/cloudAuth', () => ({
  cloudAuthService: {
    wechatGetQr: vi.fn(),
    wechatPoll: vi.fn(),
    loginWithWechat: vi.fn(),
  },
}));
vi.mock('../services/i18n', () => ({
  i18nService: { t: (k: string) => k },
}));

import { cloudAuthService } from '../services/cloudAuth';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WechatQrDialog', () => {
  test('fetches QR on mount and shows image', async () => {
    vi.mocked(cloudAuthService.wechatGetQr).mockResolvedValue({
      success: true,
      ticket: 'T1',
      qrUrl: 'data:image/png;base64,XYZ',
    });
    vi.mocked(cloudAuthService.wechatPoll).mockResolvedValue({ status: 'waiting' });

    render(<WechatQrDialog onSuccess={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('wechat-qr-img')).toBeTruthy();
    });
  });

  test('shows error when QR fetch fails', async () => {
    vi.mocked(cloudAuthService.wechatGetQr).mockResolvedValue({ success: false, error: 'boom' });

    render(<WechatQrDialog onSuccess={vi.fn()} onCancel={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByTestId('wechat-error')?.textContent).toContain('boom');
    });
  });
});
