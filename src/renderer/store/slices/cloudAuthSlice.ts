import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface CloudUserInfo {
  id: string | number;
  username: string;
  nickname?: string;
  mobile?: string;
  avatar?: string;
  subscriptionPlan?: string;
  coin?: number;
}

export type FirstLoginState = null | boolean;

interface CloudAuthState {
  isLoggedIn: boolean;
  user: CloudUserInfo | null;
  hasCompletedFirstLogin: FirstLoginState;
  isLoading: boolean;
}

const initialState: CloudAuthState = {
  isLoggedIn: false,
  user: null,
  hasCompletedFirstLogin: null,
  isLoading: true,
};

const cloudAuthSlice = createSlice({
  name: 'cloudAuth',
  initialState,
  reducers: {
    setAuthLoading(state, action: PayloadAction<boolean>) {
      state.isLoading = action.payload;
    },
    setAuthStatus(
      state,
      action: PayloadAction<{ isLoggedIn: boolean; user?: CloudUserInfo | null; hasCompletedFirstLogin: boolean }>
    ) {
      state.isLoggedIn = action.payload.isLoggedIn;
      state.user = action.payload.user ?? null;
      state.hasCompletedFirstLogin = action.payload.hasCompletedFirstLogin;
      state.isLoading = false;
    },
    setLoggedIn(state, action: PayloadAction<{ user: CloudUserInfo }>) {
      state.isLoggedIn = true;
      state.user = action.payload.user;
      state.hasCompletedFirstLogin = true;
      state.isLoading = false;
    },
    setLoggedOut(state) {
      state.isLoggedIn = false;
      state.user = null;
      state.hasCompletedFirstLogin = true; // stays true once first login done
      state.isLoading = false;
    },
  },
});

export const { setAuthLoading, setAuthStatus, setLoggedIn, setLoggedOut } = cloudAuthSlice.actions;
export default cloudAuthSlice.reducer;
