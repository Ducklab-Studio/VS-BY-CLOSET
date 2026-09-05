import type { Metadata } from 'next';
import { requireAdminSession, requireAdminRole } from '@/lib/admin-session';
import { getRules, listBlocks, listPieces } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { Card, ErrorState, PageHeader } from '@/components/closetadmin/ui';
import { RulesForm } from './RulesForm';
import { BlocksSection } from './BlocksSection';

export const metadata: Metadata = { title: 'Regras e bloqueios' };

/**
 * Fase 9, itens 12/13 — exclusivo de ADMIN
 * (`requireAdminRole` redireciona STAFF de volta pro dashboard). Editor
 * só de `RentalRuleConfig` + bloqueios operacionais — nenhuma regra
 * nova é decidida aqui, só os números que o `RentalPlanEngine` já
 * consome.
 */
export default async function ClosetAdminRulesPage() {
  const session = await requireAdminSession();
  requireAdminRole(session, 'ADMIN');

  let data: Awaited<ReturnType<typeof loadRulesPageData>> | null = null;
  let errorMessage: string | null = null;
  try {
    data = await loadRulesPageData(session.id);
  } catch (err) {
    errorMessage = err instanceof AdminApiError ? err.message : 'Erro inesperado.';
  }

  if (!data) {
    return <ErrorState message={errorMessage ?? 'Erro inesperado.'} />;
  }

  {
    const { rules, blocks, pieces } = data;
    return (
      <div>
        <PageHeader title="Regras e bloqueios" description="Editor da configuração operacional — o motor de regras aplica estes valores imediatamente." />

        <Card>
          <h2 className="font-heading text-base font-semibold text-ink dark:text-dark-text tracking-wide">Regras de aluguel</h2>
          <div className="mt-4">
            <RulesForm initial={rules} />
          </div>
        </Card>

        <div className="mt-6">
          <h2 className="mb-3 font-heading text-base font-semibold text-ink dark:text-dark-text tracking-wide">Bloqueios operacionais</h2>
          <BlocksSection blocks={blocks} pieces={pieces.filter((p) => p.active)} />
        </div>
      </div>
    );
  }
}

async function loadRulesPageData(adminUserId: string) {
  const [rules, blocks, pieces] = await Promise.all([getRules(adminUserId), listBlocks(adminUserId, true), listPieces(adminUserId)]);
  return { rules, blocks, pieces };
}
