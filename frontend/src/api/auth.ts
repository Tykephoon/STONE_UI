/**
 * Authentication endpoints.
 *
 * `skipRetry` is set throughout: these calls *are* the session machinery, so
 * the client's automatic refresh-and-retry would recurse.
 */
import { clearCsrfToken, request, setCsrfToken } from './client';
import type { User } from './types';

interface AuthResponse {
  user: User;
  csrf_token: string;
}

export async function register(input: {
  email: string;
  password: string;
  display_name?: string;
}): Promise<User> {
  const response = await request<AuthResponse>('/api/auth/register', {
    method: 'POST',
    body: input,
    skipRetry: true,
  });
  setCsrfToken(response.csrf_token);
  return response.user;
}

export async function login(input: { email: string; password: string }): Promise<User> {
  const response = await request<AuthResponse>('/api/auth/login', {
    method: 'POST',
    body: input,
    skipRetry: true,
  });
  setCsrfToken(response.csrf_token);
  return response.user;
}

export async function logout(): Promise<void> {
  try {
    await request<void>('/api/auth/logout', { method: 'POST', skipRetry: true });
  } finally {
    // Clear locally even if the call failed, so the UI never shows a signed-in
    // state the server has already torn down.
    clearCsrfToken();
  }
}

export async function logoutEverywhere(): Promise<{ revoked: number }> {
  const result = await request<{ revoked: number }>('/api/auth/logout-all', {
    method: 'POST',
    skipRetry: true,
  });
  clearCsrfToken();
  return result;
}

export interface MeResponse {
  user: User;
  session: { expires_at: string; absolute_expires_at: string };
}

export function me(signal?: AbortSignal): Promise<MeResponse> {
  return request<MeResponse>('/api/auth/me', { skipRetry: true, ...(signal ? { signal } : {}) });
}

/** Restores the CSRF token on a cold page load where the cookie already exists. */
export async function bootstrapCsrf(): Promise<boolean> {
  const response = await request<{ csrf_token: string | null; authenticated: boolean }>(
    '/api/auth/csrf',
    { skipRetry: true },
  );
  setCsrfToken(response.csrf_token);
  return response.authenticated;
}

export async function refresh(): Promise<User> {
  const response = await request<AuthResponse & { expires_at: string }>('/api/auth/refresh', {
    method: 'POST',
    skipRetry: true,
  });
  setCsrfToken(response.csrf_token);
  return response.user;
}
