import type { Metadata } from 'next';
import { requireAdminRole, requireAdminSession } from '@/lib/admin-session';
import { listEmployees } from '@/lib/admin-data';
import { AdminApiError, adminGet } from '@/lib/admin-api';
import type { EmployeePresence } from '@/lib/closetadmin-presence';
import { ErrorState, PageHeader } from '@/components/closetadmin/ui';
import { EmployeesSection } from './EmployeesSection';

export const metadata: Metadata = { title: 'Funcionários' };

/**
 * Sistema de autorização de funcionários — exclusivo de Anderson
 * (SUPER_ADMIN/proprietário). O backend (AdminEmployeesController)
 * recusa de qualquer forma; esta checagem só evita mostrar uma tela
 * vazia/erro cru pra quem não pode acessá-la.
 */
export default async function ClosetAdminEmployeesPage() {
  const session = await requireAdminSession();
  requireAdminRole(session, 'SUPER_ADMIN');

  // Lista e presença são independentes: em paralelo, não em fila.
  const [employeesResult, presenceResult] = await Promise.allSettled([
    listEmployees(session.id),
    adminGet<EmployeePresence[]>('/admin/presence', session.id),
  ]);

  if (employeesResult.status === 'rejected') {
    const err = employeesResult.reason;
    return <ErrorState message={err instanceof AdminApiError ? err.message : 'Erro inesperado.'} />;
  }
  const employees = employeesResult.value;
  // Online/offline — falha aqui não impede a lista (a tela tenta de novo sozinha).
  const presence: EmployeePresence[] | null = presenceResult.status === 'fulfilled' ? presenceResult.value : null;

  return (
    <div>
      <PageHeader
        title="Funcionários"
        description="Cada funcionário tem login próprio (telefone + PIN), nunca credenciais compartilhadas. Acesso por módulo: reservas, calendário, peças, regras, relatórios e auditoria."
      />
      <EmployeesSection
        employees={employees}
        initialPresence={presence}
        currentUserId={session.id}
        canGrantSuperAdmin={session.role === 'SUPER_ADMIN'}
      />
    </div>
  );
}
