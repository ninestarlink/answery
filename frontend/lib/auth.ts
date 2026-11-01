/** 登录态：Token 与用户信息存 localStorage，管理接口统一带 Authorization。 */

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/+$/, '') ?? '';

const TOKEN_KEY = 'yunqi_token';
const USER_KEY = 'yunqi_user';
export const AUTH_EVENT = 'yunqi-auth-change';

export interface AuthUser {
  id: string;
  name: string;
  phone: string;
  level: string;
  role: string;
}

const notify = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AUTH_EVENT));
};

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): AuthUser | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AuthUser;
  } catch {
    return null;
  }
}

/** 给 fetch 用的鉴权头；未登录时为空对象，不干扰匿名接口。 */
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function clearSession(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USER_KEY);
  notify();
}

export function logout(): void {
  clearSession();
}

export function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  if (window.location.pathname === '/login') return;
  const next = `${window.location.pathname}${window.location.search}`;
  window.location.href = `/login?next=${encodeURIComponent(next)}`;
}

export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });

  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    customer?: AuthUser;
    detail?: string;
  };
  if (!res.ok || !data.access_token || !data.customer) {
    throw new Error(data.detail ?? `登录失败（HTTP ${res.status}）`);
  }

  window.localStorage.setItem(TOKEN_KEY, data.access_token);
  window.localStorage.setItem(USER_KEY, JSON.stringify(data.customer));
  notify();
  return data.customer;
}
