'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { adminPost, AdminApiError } from '@/lib/admin-api';
import { ADMIN_SESSION_COOKIE } from '@/lib/admin-session';

export interface LoginFormState {
  readonly error: string | null;
}

interface LoginResponse {
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * Fase 9, item 2 — nome + telefone + PIN. A validação de credenciais é
 * TODA feita pelo reservations-api (`AdminAuthService.login`, já com
 * anti-enumeração — as 4 falhas possíveis chegam aqui como a MESMA
 * mensagem genérica). Este Server Action só encaminha e, em caso de
 * sucesso, grava o cookie de sessão — o valor de sessão real (o token
 * aleatório) nunca passa por client-side JS, só por este roundtrip
 * server-to-server + `Set-Cookie`.
 */
export async function loginAction(_prev: LoginFormState, formData: FormData): Promise<LoginFormState> {
  const name = String(formData.get('name') ?? '').trim();
  const phone = String(formData.get('phone') ?? '').trim();
  const pin = String(formData.get('pin') ?? '').trim();

  if (!name || !phone || !pin) {
    return { error: 'Preencha nome, telefone e PIN.' };
  }

  let result: LoginResponse;
  try {
    result = await adminPost<LoginResponse>('/admin/auth/login', { name, phone, pin });
  } catch (err) {
    if (err instanceof AdminApiError && err.status === 401) {
      return { error: 'Credenciais inválidas.' };
    }
    if (err instanceof AdminApiError && err.status === 429) {
      return { error: 'Muitas tentativas. Aguarde um minuto e tente novamente.' };
    }
    return { error: 'Não foi possível entrar agora. Tente novamente em instantes.' };
  }

  const store = await cookies();
  const maxAgeSeconds = Math.max(1, Math.floor((new Date(result.expiresAt).getTime() - Date.now()) / 1000));
  store.set(ADMIN_SESSION_COOKIE, result.token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });

  redirect('/closetadmin');
}
