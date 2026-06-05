import { configureStore } from '@reduxjs/toolkit';
import { cleanup, render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { afterEach, describe, expect, test, vi } from 'vitest';

import cloudAuthReducer, { CloudUserInfo } from '../store/slices/cloudAuthSlice';
import { LoginGate } from './LoginGate';

vi.mock('./LoginModal', () => ({
  LoginModal: () => <div data-testid="login-modal">LoginModal</div>,
}));

afterEach(() => {
  cleanup();
});

function renderWithState(state: { isLoggedIn: boolean; hasCompletedFirstLogin: boolean | null; isLoading: boolean; user: CloudUserInfo | null }) {
  const store = configureStore({
    reducer: { cloudAuth: cloudAuthReducer },
    preloadedState: { cloudAuth: state },
  });
  return render(
    <Provider store={store}>
      <LoginGate>
        <div data-testid="children">children</div>
      </LoginGate>
    </Provider>
  );
}

describe('LoginGate', () => {
  test('shows loading when hasCompletedFirstLogin is null', () => {
    renderWithState({ isLoggedIn: false, hasCompletedFirstLogin: null, isLoading: true, user: null });
    expect(screen.queryByTestId('children')).toBeNull();
    expect(screen.queryByTestId('login-modal')).toBeNull();
  });

  test('shows first-run screen when hasCompletedFirstLogin is false', () => {
    renderWithState({ isLoggedIn: false, hasCompletedFirstLogin: false, isLoading: false, user: null });
    expect(screen.queryByTestId('children')).toBeNull();
  });

  test('renders children + login modal when logged out but first login done', () => {
    renderWithState({ isLoggedIn: false, hasCompletedFirstLogin: true, isLoading: false, user: null });
    expect(screen.getByTestId('children')).toBeTruthy();
  });

  test('renders children when logged in', () => {
    renderWithState({ isLoggedIn: true, hasCompletedFirstLogin: true, isLoading: false, user: { id: 1, username: 'u' } as CloudUserInfo });
    expect(screen.getByTestId('children')).toBeTruthy();
    expect(screen.queryByTestId('login-modal')).toBeNull();
  });
});
