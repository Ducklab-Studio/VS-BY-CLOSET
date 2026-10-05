'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { adminPost, AdminApiError } from '@/lib/admin-api';
import { ADMIN_SESSION_COOKIE } from '@/lib/admin-session';
import { CLIENT_IP_HEADER, clientIpFromHeaders } from '@/lib/client-ip';
import { LOGIN_FAILURE_MESSAGES, classifyLoginFailure, isValidLoginResponse } from './login-errors';

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
 * mensagem genérica — ver login-errors.ts pra como o 401 de configuração
 * se separa do de credencial). Este Server Action só encaminha e, em caso de
 * sucesso, grava o cookie de sessão — o valor de sessão real (o token
 * aleatório) nunca passa por client-side JS, só por este roundtrip
 * server-to-server + `Set-Cookie`.
 */
export async function loginAction(_prev: LoginFormState, formData: FormData): Promise<LoginFormState> {
  const name = String(formData.get('name') ?? '').trim();
  const phone = String(formData.get('phone') ?? '').trim();
  const pin = String(formData.get('pin') ?? '').trim();

  // "+55" sozinho (campo nacional vazio) também conta como telefone vazio.
  if (!name || phone.replace(/\D/g, '').length < 8 || !pin) {
    return { error: 'Preencha nome, telefone e PIN.' };
  }

  let result: LoginResponse;
  try {
    // IP de quem digitou, para a API contar tentativas por pessoa (ver client-ip.ts).
    const clientIp = clientIpFromHeaders(await headers());
    const response = await adminPost<unknown>('/admin/auth/login', { name, phone, pin }, clientIp ? { [CLIENT_IP_HEADER]: clientIp } : undefined);
    // Sucesso só com token e validade legíveis: resposta vazia/quebrada (proxy, HTML)
    // é falha interna, nunca uma exceção sem tratamento nem um cookie com lixo.
    if (!isValidLoginResponse(response, Date.now())) {
      console.error('[closetadmin/login] A API respondeu com sucesso, mas sem token/validade válidos.');
      return { error: LOGIN_FAILURE_MESSAGES.internal };
    }
    result = response as LoginResponse;
  } catch (err) {
    const kind = err instanceof AdminApiError ? classifyLoginFailure(err.status, err.message) : 'internal';
    // Só no log do servidor, nunca na tela; só o código HTTP, nenhum valor de segredo.
    if (kind === 'misconfigured') {
      console.error(
        `[closetadmin/login] A API recusou a credencial do site (HTTP ${(err as AdminApiError).status}). ` +
          'Confira se ADMIN_API_TOKEN e RESERVATIONS_API_ADMIN_URL do site batem com a API.',
      );
    } else if (kind === 'unavailable' || kind === 'internal') {
      console.error(`[closetadmin/login] Falha ao entrar: ${kind} (HTTP ${err instanceof AdminApiError ? err.status : 'sem resposta'}).`);
    }
    return { error: LOGIN_FAILURE_MESSAGES[kind] };
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
