import type { Metadata } from 'next';
import { hasAdminRole, requireAdminModule, requireAdminSession } from '@/lib/admin-session';
import { getValePassLaunchReadiness, listValePassCampaigns, listValePassOrders, listValePassVouchers, type LaunchReadiness } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { ErrorState, PageHeader } from '@/components/closetadmin/ui';
import { applyWebEvidence } from '@/lib/valle-pass-launch-readiness';
import { VALE_PASS_TERMS_HREF } from '@/lib/vale-pass-terms';
import { fetchVariantStock } from '@/lib/cart';
import { VALE_PASS_VARIANT_ID } from '@/lib/vale-pass-product';
import type { WebStockEvidence } from '@/lib/valle-pass-launch-readiness';
import { LaunchReadinessPanel } from './LaunchReadinessPanel';
import { ValePassSection } from './ValePassSection';

export const metadata: Metadata = { title: 'Valle Pass' };

/** Estoque da variante do Valle Pass lido do Storefront (SOMENTE LEITURA, no máximo 3 s). Erro, timeout ou Shopify bloqueada (testes) = `unknown`: o item fica pendente. */
async function readValePassStock(): Promise<WebStockEvidence> {
  const gid = `gid://shopify/ProductVariant/${VALE_PASS_VARIANT_ID}`;
  const timeout = new Promise<WebStockEvidence>((resolve) => setTimeout(() => resolve({ status: 'unknown' }), 3_000));
  const read = fetchVariantStock([gid]).then((map): WebStockEvidence => map.get(gid) ?? { status: 'unknown' }, (): WebStockEvidence => ({ status: 'unknown' }));
  return Promise.race([read, timeout]);
}

/**
 * Valle Pass — produto TOTALMENTE separado do fluxo de aluguel:
 * produto de dois vouchers (Valle Showroom e VS BY CLOSET) vendido pelo checkout oficial já
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
  let orders: Awaited<ReturnType<typeof listValePassOrders>> | null = null;
  let errorMessage: string | null = null;
  try {
    [campaigns, vouchers, orders] = await Promise.all([listValePassCampaigns(session.id), listValePassVouchers(session.id, {}), listValePassOrders(session.id)]);
  } catch (err) {
    errorMessage = err instanceof AdminApiError ? err.message : 'Erro inesperado.';
  }

  if (!campaigns || !vouchers || !orders) {
    return <ErrorState message={errorMessage ?? 'Erro inesperado.'} />;
  }

  // Painel "Pronta para vender?" (somente leitura). Falha aqui NÃO derruba o restante da tela: o painel mostra o próprio estado de erro.
  let readiness: LaunchReadiness | null = null;
  let readinessError: string | null = null;
  try {
    const [raw, shopifyStock] = await Promise.all([getValePassLaunchReadiness(session.id), readValePassStock()]);
    readiness = applyWebEvidence(raw, { termsHref: VALE_PASS_TERMS_HREF, shopifyStock });
  } catch (err) {
    readinessError = err instanceof AdminApiError ? err.message : 'Erro inesperado.';
  }

  return (
    <div>
      <PageHeader
        title="Valle Pass"
        description="Dois vouchers por unidade (Valle Showroom e VS BY CLOSET) — vendido pelo checkout oficial da Shopify, separado do fluxo de aluguel. Nunca depende de disponibilidade, HOLD ou datas de retirada/devolução."
      />
      <LaunchReadinessPanel readiness={readiness} error={readinessError} />
      <ValePassSection initialCampaigns={campaigns} initialVouchers={vouchers} initialOrders={orders} canManageCampaigns={hasAdminRole(session, 'ADMIN')} isOwner={session.role === 'SUPER_ADMIN'} />
    </div>
  );
}
