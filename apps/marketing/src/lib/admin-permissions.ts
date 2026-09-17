/**
 * Sistema de autorização de funcionários — tipos e checagens puras de
 * papel/módulo, sem nenhuma dependência de servidor (`server-only`,
 * `next/headers`). Precisa ficar separado de admin-session.ts porque
 * AdminShell.tsx é um Client Component e só pode importar isto daqui —
 * importar uma função (não só o tipo) de um módulo `server-only` de um
 * Client Component quebra o build (achado real: o build só falha aqui,
 * nunca no typecheck nem no lint, que não seguem essa regra do Next).
 */

export type AdminModuleName = 'RESERVATIONS' | 'CALENDAR' | 'PIECES' | 'RULES' | 'REPORTS' | 'AUDIT';

export interface AdminSessionUser {
  readonly id: string;
  readonly name: string;
  readonly role: 'SUPER_ADMIN' | 'ADMIN' | 'STAFF';
  readonly isTechnical: boolean;
  readonly moduleAccess: readonly AdminModuleName[];
}

/** Checagem só-de-UI (não redireciona) pra mostrar/esconder botões e
 *  seções. Hierarquia (igual ao backend, `satisfiesRole`): SUPER_ADMIN
 *  satisfaz qualquer checagem de 'ADMIN' — Anderson nunca perde acesso a
 *  um controle ADMIN-only por não ser literalmente 'ADMIN'. O backend
 *  sempre valida de novo; isto só evita mostrar um controle que a
 *  chamada real vai recusar. */
export function hasAdminRole(session: AdminSessionUser, role: 'ADMIN' | 'SUPER_ADMIN'): boolean {
  return session.role === 'SUPER_ADMIN' || session.role === role;
}

/** Módulo concedido ao funcionário (Reservas, Calendário, Peças, Regras,
 *  Relatórios, Auditoria) — "Permissões separadas por módulo". SUPER_ADMIN
 *  sempre tem acesso a todos os módulos, sem depender da lista salva. */
export function hasAdminModule(session: AdminSessionUser, module: AdminModuleName): boolean {
  return session.role === 'SUPER_ADMIN' || session.moduleAccess.includes(module);
}
