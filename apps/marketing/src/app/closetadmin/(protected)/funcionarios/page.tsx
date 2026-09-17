import type { Metadata } from 'next';
import { requireAdminRole, requireAdminSession } from '@/lib/admin-session';
import { listEmployees } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
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

  let employees: Awaited<ReturnType<typeof listEmployees>> | null = null;
  let errorMessage: string | null = null;
  try {
    employees = await listEmployees(session.id);
  } catch (err) {
    errorMessage = err instanceof AdminApiError ? err.message : 'Erro inesperado.';
  }

  if (!employees) {
    return <ErrorState message={errorMessage ?? 'Erro inesperado.'} />;
  }

  return (
    <div>
      <PageHeader
        title="Funcionários"
        description="Cada funcionário tem login próprio (telefone + PIN), nunca credenciais compartilhadas. Acesso por módulo: reservas, calendário, peças, regras, relatórios e auditoria."
      />
      <EmployeesSection employees={employees} currentUserId={session.id} />
    </div>
  );
}
