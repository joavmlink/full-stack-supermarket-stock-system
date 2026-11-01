import type { HttpClient } from './http';
import type { User } from './types';

export interface AuthApi {
  /** The signed-in user, or null without a valid session (always a 200). */
  session(): Promise<User | null>;
  login(email: string, password: string): Promise<User>;
  logout(): Promise<void>;
}

export function createAuthApi(http: HttpClient): AuthApi {
  return {
    session: async () => (await http.request<{ user: User | null }>('GET', '/auth/session')).user,
    login: (email, password) => http.request<User>('POST', '/auth/login', { body: { email, password } }),
    logout: () => http.request<void>('POST', '/auth/logout'),
  };
}
