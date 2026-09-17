import type { Metadata } from 'next';
import { hasAdminRole, requireAdminModule, requireAdminSession } from '@/lib/admin-session';
import { listValePassCampaigns, listValePassVouchers } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { ErrorState, PageHeader } from '@/components/closetadmin/ui';
import { ValePassSection } from './ValePassSection';

export const metadata: Metadata = { title: 'Valle Pass' };

/**
 * Valle Pass — produto TOTALMENTE separado do fluxo de aluguel:
 * vale-presente/crédito de compra vendido pelo checkout oficial já
 * configurado na loja Shopify. Nunca exige data de
 * retirada/devolução, disponibilidade ou HOLD — continua vendável
 * mesmo com agendamentos de aluguel bloqueados, porque esta tela (e o
 * backend por trás dela) nunca lê RentalUnit/Reservation.
 */
export default async function ClosetAdminValePassPage() {
  const session = await requireAdminSession();
  requireAdminModule(session, 'VALLE_PASS');

  let campaigns: Awaited<ReturnType<typeof listValePassCampaigns>> | null = null;
  let vouchers: Awaited<ReturnType<typeof listValePassVouchers>> | null = null;
  let errorMessage: string | null = null;
  try {
    [campaigns, vouchers] = await Promise.all([listValePassCampaigns(session.id), listValePassVouchers(session.id, {})]);
  } catch (err) {
    errorMessage = err instanceof AdminApiError ? err.message : 'Erro inesperado.';
  }

  if (!campaigns || !vouchers) {
    return <ErrorState message={errorMessage ?? 'Erro inesperado.'} />;
  }

  return (
    <div>
      <PageHeader
        title="Valle Pass"
        description="Vale-presente/crédito de compra — vendido pelo checkout oficial da Shopify, separado do fluxo de aluguel. Nunca depende de disponibilidade, HOLD ou datas de retirada/devolução."
      />
      <ValePassSection initialCampaigns={campaigns} initialVouchers={vouchers} canManageCampaigns={hasAdminRole(session, 'ADMIN')} />
    </div>
  );
}
