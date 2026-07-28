'use client';

export interface SessionUser {
  id: string;
  email: string;
  role: 'ADMIN' | 'MANAGER' | 'SUPPORT' | 'CUSTOMER';
}

const TOKEN_KEY = 'accessToken';
const USER_KEY = 'authUser';

export const STAFF_ROLES: SessionUser['role'][] = ['ADMIN', 'MANAGER', 'SUPPORT'];

export function saveSession(accessToken: string, user: SessionUser) {
  sessionStorage.setItem(TOKEN_KEY, accessToken);
  sessionStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return sessionStorage.getItem(TOKEN_KEY);
}

export function getUser(): SessionUser | null {
  if (typeof window === 'undefined') return null;
  const raw = sessionStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SessionUser;
  } catch {
    return null;
  }
}

export function clearSession() {
  sessionStorage.removeItem(TOKEN_KEY);
  sessionStorage.removeItem(USER_KEY);
}

export function isStaff(user: SessionUser | null): boolean {
  return !!user && STAFF_ROLES.includes(user.role);
}
