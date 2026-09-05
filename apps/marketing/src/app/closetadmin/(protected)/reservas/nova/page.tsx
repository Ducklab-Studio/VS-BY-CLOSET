import type { Metadata } from 'next';
import { requireAdminSession } from '@/lib/admin-session';
import { listPieces } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { ErrorState, PageHeader } from '@/components/closetadmin/ui';
import { ManualReservationWizard } from './ManualReservationWizard';

export const metadata: Metadata = { title: 'Nova reserva manual' };

export default async function ClosetAdminNewReservationPage() {
  const session = await requireAdminSession();

  let pieces: Awaited<ReturnType<typeof listPieces>> | null = null;
  let errorMessage: string | null = null;
  try {
    pieces = await listPieces(session.id);
  } catch (err) {
    errorMessage = err instanceof AdminApiError ? err.message : 'Erro inesperado.';
  }

  if (!pieces) {
    return <ErrorState message={errorMessage ?? 'Erro inesperado.'} />;
  }

  return (
    <div>
      <PageHeader title="Nova reserva manual" description="Cliente → Datas → Peças → Validação → Resumo → Confirmar" />
      <ManualReservationWizard pieces={pieces} />
    </div>
  );
}
