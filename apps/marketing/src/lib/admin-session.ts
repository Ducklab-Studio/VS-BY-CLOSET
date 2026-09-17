import 'server-only';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { adminPost } from './admin-api';

import { ADMIN_SESSION_COOKIE } from './admin-cookie';
export { ADMIN_SESSION_COOKIE } from './admin-cookie';

import { hasAdminModule, type AdminModuleName, type AdminSessionUser } from './admin-permissions';
export { hasAdminModule, hasAdminRole, type AdminModuleName, type AdminSessionUser } from './admin-permissions';

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
 *  pode usar.
 *
 *  Hierarquia (igual ao backend, `satisfiesRole`): SUPER_ADMIN satisfaz
 *  qualquer checagem de 'ADMIN' — Anderson nunca perde acesso a uma
 *  tela ADMIN-only por não ser literalmente 'ADMIN'. */
export function requireAdminRole(session: AdminSessionUser, role: 'ADMIN' | 'SUPER_ADMIN'): void {
  if (session.role === 'SUPER_ADMIN') return;
  if (session.role !== role) redirect('/closetadmin');
}

/** Páginas/ações que exigem um módulo específico — "Funcionários não
 *  podem gerenciar usuários nem alterar permissões" e módulos por área
 *  vêm daqui. Redireciona pro dashboard em vez de tela vazia/erro cru,
 *  igual a `requireAdminRole`. */
export function requireAdminModule(session: AdminSessionUser, module: AdminModuleName): void {
  if (!hasAdminModule(session, module)) redirect('/closetadmin');
}
