import type { Metadata } from 'next';
import { Ban, CalendarRange, Clock3, PackageCheck, ShieldCheck } from 'lucide-react';
import { requireAdminSession, requireAdminRole } from '@/lib/admin-session';
import { getRules, listBlocks, listPieces } from '@/lib/admin-data';
import { AdminApiError } from '@/lib/admin-api';
import { Card, ErrorState, PageHeader } from '@/components/closetadmin/ui';
import { RulesForm } from './RulesForm';
import { BlocksSection } from './BlocksSection';
import { AvailabilityFormationPreview } from './AvailabilityFormationPreview';

export const metadata: Metadata = { title: 'Regras e bloqueios' };

/**
 * Configuração operacional exclusiva de ADMIN. O backend continua sendo a
 * fonte da verdade: esta tela apenas edita RentalRuleConfig e bloqueios que
 * o motor de disponibilidade já aplica em reservas, calendário e checkout.
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

  const { rules, blocks, pieces } = data;
  const activePieces = pieces.filter((piece) => piece.active);
  const storeWideBlocks = blocks.filter((block) => block.scope === 'STORE_WIDE').length;
  const unitBlocks = blocks.filter((block) => block.scope === 'UNIT').length;

  return (
    <div>
      <PageHeader
        title="Regras e bloqueios"
        description="Controle central da disponibilidade do aluguel. Alterações salvas passam a valer imediatamente para novas reservas."
      />

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          icon={<Clock3 size={18} />}
          label="Antecedência mínima"
          value={`${rules.minAdvanceDays} dias`}
          detail="antes da retirada"
        />
        <SummaryCard
          icon={<PackageCheck size={18} />}
          label="Máximo por reserva"
          value={`${rules.maxPieces} peças`}
          detail={`${activePieces.length} peça(s) ativa(s) no inventário`}
        />
        <SummaryCard
          icon={<CalendarRange size={18} />}
          label="Temporada bloqueada"
          value={`${formatMonthDay(rules.blackoutStart)} – ${formatMonthDay(rules.blackoutEnd)}`}
          detail="bloqueio anual recorrente"
        />
        <SummaryCard
          icon={<Ban size={18} />}
          label="Bloqueios ativos"
          value={String(blocks.length)}
          detail={`${storeWideBlocks} loja · ${unitBlocks} peça(s)`}
        />
      </section>

      <section className="mt-5 grid gap-4 xl:grid-cols-[1.35fr_0.65fr]">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-heading text-base font-semibold tracking-wide text-ink dark:text-dark-text">Regras de aluguel</h2>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-ink/50 dark:text-dark-subtle">
                Defina antecedência, preparação, limpeza, limite de peças, temporada bloqueada e duração conforme a quantidade reservada.
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/15 bg-emerald-500/[0.07] px-2.5 py-1 text-xs font-medium text-emerald-500">
              <ShieldCheck size={13} />
              Motor ativo
            </span>
          </div>

          <div className="mt-5">
            <RulesForm initial={rules} />
          </div>
        </Card>

        <Card>
          <h2 className="font-heading text-base font-semibold tracking-wide text-ink dark:text-dark-text">Como a disponibilidade é formada</h2>
          <p className="mt-1 text-xs leading-5 text-ink/50 dark:text-dark-subtle">
            O período ocupado não é só o aluguel. O sistema protege automaticamente preparação e limpeza antes de liberar a peça novamente.
          </p>

          <AvailabilityFormationPreview initial={rules} />

          <div className="mt-5 rounded-xl border border-amber-500/15 bg-amber-500/[0.06] px-4 py-3">
            <p className="text-xs font-medium text-amber-400">Importante</p>
            <p className="mt-1 text-xs leading-5 text-ink/55 dark:text-dark-muted">
              Bloqueios operacionais têm prioridade sobre datas livres. Use-os para manutenção, eventos ou indisponibilidade excepcional.
            </p>
          </div>
        </Card>
      </section>

      <section className="mt-5">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="font-heading text-base font-semibold tracking-wide text-ink dark:text-dark-text">Bloqueios operacionais</h2>
            <p className="mt-1 text-xs text-ink/50 dark:text-dark-subtle">Bloqueie a loja inteira ou uma peça física específica em um intervalo de datas.</p>
          </div>
          <span className="text-xs text-ink/45 dark:text-dark-subtle">{blocks.length} ativo(s)</span>
        </div>
        <BlocksSection blocks={blocks} pieces={activePieces} />
      </section>
    </div>
  );
}

async function loadRulesPageData(adminUserId: string) {
  const [rules, blocks, pieces] = await Promise.all([
    getRules(adminUserId),
    listBlocks(adminUserId, true),
    listPieces(adminUserId),
  ]);
  return { rules, blocks, pieces };
}

function SummaryCard({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return (
    <Card className="flex items-center gap-3.5">
      <div className="rounded-xl bg-marsala/10 p-3 text-marsala dark:bg-gold/10 dark:text-gold">{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-ink/50 dark:text-dark-subtle">{label}</p>
        <p className="mt-0.5 truncate text-lg font-semibold text-ink dark:text-dark-text">{value}</p>
        <p className="mt-0.5 truncate text-[11px] text-ink/40 dark:text-dark-subtle">{detail}</p>
      </div>
    </Card>
  );
}

function formatMonthDay(value: string): string {
  const [month, day] = value.split('-');
  return month && day ? `${day}/${month}` : value;
}
