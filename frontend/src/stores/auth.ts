// The session, wired to the real API. The shell (layout, route guards, sign-in)
// needs only this module; the data stores (`stores/index.ts`) load with the
// pages, so they stay out of the first download.
import { useStore } from 'zustand';
import { createAuthApi } from '../api/auth-api';
import { apiClient } from '../api/client';
import { createAuthStore, type AuthState } from './auth-store';

export const authStore = createAuthStore(createAuthApi(apiClient));

apiClient.onUnauthenticated(() => authStore.getState().sessionExpired());

export const useAuth = <T>(selector: (state: AuthState) => T): T => useStore(authStore, selector);
