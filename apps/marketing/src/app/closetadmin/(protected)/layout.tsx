import type { Metadata } from 'next';
import { requireAdminSession } from '@/lib/admin-session';
import { AdminShell } from '@/components/closetadmin/AdminShell';
import { PresenceHeartbeat } from '@/components/closetadmin/PresenceHeartbeat';

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * Fase 9 — todo `/closetadmin/*` exceto `/closetadmin/login` passa por
 * aqui. `requireAdminSession()` redireciona pro login se o cookie
 * faltar, estiver expirado/revogado, ou o usuário tiver sido
 * desativado — sempre validado contra o reservations-api, nunca
 * confiando só no cookie existir (item: "Não considerar o nome obscuro
 * da URL como mecanismo de segurança" — aqui a segurança é a validação
 * de sessão real, não a URL).
 */
export default async function ClosetAdminProtectedLayout({ children }: { children: React.ReactNode }) {
  const session = await requireAdminSession();
  // PresenceHeartbeat: mantém este funcionário Online enquanto o painel está aberto.
  return (
    <AdminShell session={session}>
      <PresenceHeartbeat />
      {children}
    </AdminShell>
  );
}
