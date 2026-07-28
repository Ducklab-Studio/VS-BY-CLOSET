'use client';

import { clearSession, getToken, saveSession, type SessionUser } from './auth';
import { apiBase } from './api-url';

const BASE = apiBase();

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Tenta renovar o access token com o refresh cookie httpOnly. */
async function tryRefresh(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
    if (!res.ok) return false;
    const data = (await res.json()) as { accessToken: string; user: SessionUser };
    saveSession(data.accessToken, data.user);
    return true;
  } catch {
    return false;
  }
}

async function call<T>(path: string, init: RequestInit, retry: boolean): Promise<T> {
  const token = getToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
      ...init.headers,
    },
  });

  if (res.status === 401 && retry) {
    if (await tryRefresh()) return call<T>(path, init, false);
    clearSession();
    throw new ApiError('Sessão expirada. Faça login novamente.', 401);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { message?: string | string[] });
    const raw = (body as { message?: string | string[] }).message;
    const message = Array.isArray(raw) ? raw[0] : (raw ?? `Erro ${res.status}`);
    throw new ApiError(message, res.status);
  }

  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function buildQuery(params: Record<string, string | number | undefined | null>) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  });
  const s = qs.toString();
  return s ? `?${s}` : '';
}

export const adminApi = {
  get: <T>(path: string, params?: Record<string, string | number | undefined | null>) =>
    call<T>(`${path}${params ? buildQuery(params) : ''}`, { method: 'GET' }, true),
  post: <T>(path: string, body?: unknown) =>
    call<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }, true),
  patch: <T>(path: string, body?: unknown) =>
    call<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }, true),
  delete: <T>(path: string) => call<T>(path, { method: 'DELETE' }, true),
};
