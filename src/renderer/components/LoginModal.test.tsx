import { configureStore } from '@reduxjs/toolkit';
import { cleanup, fireEvent,render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach,describe, expect, test, vi } from 'vitest';

import cloudAuthReducer from '../store/slices/cloudAuthSlice';
import { LoginModal } from './LoginModal';

vi.mock('../services/cloudAuth', () => ({
  cloudAuthService: {
    loginWithPassword: vi.fn(),
    sendSmsCode: vi.fn(),
    loginWithSms: vi.fn(),
    loginWithWechat: vi.fn(),
  },
}));
vi.mock('./WechatQrDialog', () => ({
  WechatQrDialog: () => <div data-testid="wechat-qr-dialog" />,
}));

import { cloudAuthService } from '../services/cloudAuth';

function renderModal(props: { isFirstRun?: boolean; onClose?: () => void; onSuccess?: () => void } = {}) {
  const store = configureStore({
    reducer: { cloudAuth: cloudAuthReducer },
    preloadedState: {
      cloudAuth: { isLoggedIn: false, hasCompletedFirstLogin: true, isLoading: false, user: null },
    },
  });
  return render(
    <Provider store={store}>
      <LoginModal {...props} />
    </Provider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('LoginModal', () => {
  test('renders all three tabs by default', () => {
    renderModal();
    expect(screen.getByTestId('tab-password')).toBeTruthy();
    expect(screen.getByTestId('tab-sms')).toBeTruthy();
    expect(screen.getByTestId('tab-wechat')).toBeTruthy();
  });

  test('switches to sms tab on click', () => {
    renderModal();
    fireEvent.click(screen.getByTestId('tab-sms'));
    expect(screen.getByTestId('sms-mobile-input')).toBeTruthy();
  });

  test('switches to wechat tab and shows launch button', () => {
    renderModal();
    fireEvent.click(screen.getByTestId('tab-wechat'));
    expect(screen.getByTestId('wechat-launch')).toBeTruthy();
  });

  test('calls loginWithPassword on submit', async () => {
    vi.mocked(cloudAuthService.loginWithPassword).mockResolvedValue({ success: true });
    renderModal();
    fireEvent.change(screen.getByTestId('mobile-input'), { target: { value: '13800000000' } });
    fireEvent.change(screen.getByTestId('password-input'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('password-submit'));
    expect(cloudAuthService.loginWithPassword).toHaveBeenCalledWith('13800000000', 'pw');
  });

  test('hides register/reset links in first-run mode', () => {
    renderModal({ isFirstRun: true });
    expect(screen.queryByTestId('link-register')).toBeNull();
    expect(screen.queryByTestId('link-reset-password')).toBeNull();
  });
});
