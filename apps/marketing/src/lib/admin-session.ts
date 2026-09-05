import 'server-only';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { adminPost } from './admin-api';

export const ADMIN_SESSION_COOKIE = 'closetadmin_session';

export interface AdminSessionUser {
  readonly id: string;
  readonly name: string;
  readonly role: 'ADMIN' | 'STAFF';
}

/**
 * Fase 9, item 2 — lê o cookie HttpOnly deste domínio (apps/marketing) e
 * pede ao reservations-api pra validar (server-to-server, com
 * `ADMIN_API_TOKEN`). O navegador nunca vê o token de sessão sendo
 * validado nem o `ADMIN_API_TOKEN` — só o cookie opaco. `null` sempre que
 * a sessão não é válida (ausente, expirada, revogada, usuário
 * desativado) — nunca lança, quem chama decide o que fazer (página de
 * login deixa passar, layout protegido redireciona).
 */
export async function getAdminSession(): Promise<AdminSessionUser | null> {
  const store = await cookies();
  const token = store.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) return null;

  try {
    return await adminPost<AdminSessionUser>('/admin/auth/session', { token });
  } catch {
    return null;
  }
}

/** Usado pelo layout protegido — nunca confia só em esconder um link no
 *  menu (item 15: "Backend precisa validar role em TODA ação
 *  protegida"). Toda página sob `(protected)` chama isto antes de
 *  renderizar qualquer dado. */
export async function requireAdminSession(): Promise<AdminSessionUser> {
  const session = await getAdminSession();
  if (!session) redirect('/closetadmin/login');
  return session;
}

/** Páginas exclusivas de ADMIN (regras, bloqueios, auditoria) chamam isto
 *  além de `requireAdminSession` — redireciona STAFF de volta pro
 *  dashboard em vez de mostrar uma tela vazia/erro cru. O
 *  `AdminRoleGuard` do reservations-api recusa a chamada de qualquer
 *  forma; isto só evita a viagem de rede pra uma tela que a pessoa não
 *  pode usar. */
export function requireAdminRole(session: AdminSessionUser, role: 'ADMIN'): void {
  if (session.role !== role) redirect('/closetadmin');
}
