import type { Metadata } from 'next';
import { Ban, CalendarRange, Clock3, DoorClosed, DoorOpen, PackageCheck, ShieldCheck } from 'lucide-react';
import { requireAdminSession, requireAdminRole } from '@/lib/admin-session';
import { getRules, listBlocks, listPieces, type BlockItem, type RentalRuleConfig } from '@/lib/admin-data';
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
  const activeBlocks = blocks.filter((block) => block.active);
  const storeWideBlocks = activeBlocks.filter((block) => block.scope === 'STORE_WIDE').length;
  const unitBlocks = activeBlocks.filter((block) => block.scope === 'UNIT').length;
  const status = storeStatus(rules, activeBlocks, todayIn(rules.timezone));

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
          label="Início da operação"
          value={rules.operationStartDate ? formatDatePt(rules.operationStartDate) : 'Sem data'}
          detail={rules.operationStartDate ? 'primeira retirada aceita' : 'loja aberta, sem data de início'}
        />
        <SummaryCard
          icon={<Ban size={18} />}
          label="Períodos fechados ativos"
          value={String(activeBlocks.length)}
          detail={`${storeWideBlocks} loja · ${unitBlocks} peça(s)`}
        />
      </section>

      <section
        className={`mt-4 flex items-start gap-3 rounded-xl border px-4 py-3.5 ${status.open ? 'border-emerald-500/20 bg-emerald-500/[0.06]' : 'border-amber-500/25 bg-amber-500/[0.07]'}`}
      >
        <div className={`rounded-lg p-2 ${status.open ? 'bg-emerald-500/10 text-emerald-500' : 'bg-amber-500/10 text-amber-400'}`}>
          {status.open ? <DoorOpen size={18} /> : <DoorClosed size={18} />}
        </div>
        <div className="min-w-0">
          <p className={`text-sm font-semibold ${status.open ? 'text-emerald-500' : 'text-amber-400'}`}>{status.title}</p>
          <p className="mt-0.5 text-xs leading-5 text-ink/55 dark:text-dark-muted">{status.detail}</p>
          {status.next ? <p className="mt-0.5 text-xs leading-5 text-ink/45 dark:text-dark-subtle">{status.next}</p> : null}
        </div>
      </section>

      <section className="mt-5 grid gap-4 xl:grid-cols-[1.35fr_0.65fr]">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-heading text-base font-semibold tracking-wide text-ink dark:text-dark-text">Regras de aluguel</h2>
              <p className="mt-1 max-w-2xl text-xs leading-5 text-ink/50 dark:text-dark-subtle">
                Defina antecedência, preparação, limpeza, limite de peças, início da operação e duração conforme a quantidade reservada.
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
              Períodos fechados têm prioridade sobre datas livres. Use-os para temporadas fechadas, manutenção, eventos ou indisponibilidade excepcional.
            </p>
          </div>
        </Card>
      </section>

      <section className="mt-5">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="font-heading text-base font-semibold tracking-wide text-ink dark:text-dark-text">Períodos fechados</h2>
            <p className="mt-1 text-xs text-ink/50 dark:text-dark-subtle">Feche a loja inteira ou uma peça física em um intervalo de datas. Sem período ativo, a loja segue aberta.</p>
          </div>
          <span className="text-xs text-ink/45 dark:text-dark-subtle">{activeBlocks.length} ativo(s) · {blocks.length - activeBlocks.length} desativado(s)</span>
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

function formatDatePt(iso: string): string {
  const [year, month, day] = iso.split('-');
  return year && month && day ? `${day}/${month}/${year}` : iso;
}

/** YYYY-MM-DD de hoje no fuso da loja (o mesmo que o motor usa). */
function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Situação de HOJE pra retirada online: início da operação e períodos da loja inteira ativos. */
function storeStatus(rules: RentalRuleConfig, activeBlocks: BlockItem[], today: string): { open: boolean; title: string; detail: string; next: string | null } {
  const storeBlocks = activeBlocks.filter((block) => block.scope === 'STORE_WIDE').sort((a, b) => a.startDate.localeCompare(b.startDate));
  const upcoming = storeBlocks.find((block) => block.startDate > today);
  const next = upcoming ? `Próximo período fechado: ${formatDatePt(upcoming.startDate)} – ${formatDatePt(upcoming.endDate)} (${upcoming.reason}).` : null;

  if (rules.operationStartDate && today < rules.operationStartDate) {
    return {
      open: false,
      title: `Loja fechada para reservas online até ${formatDatePt(rules.operationStartDate)}`,
      detail: 'Motivo: antes do início da operação. O calendário do site mostra essas datas como indisponíveis.',
      next,
    };
  }
  const current = storeBlocks.find((block) => block.startDate <= today && today <= block.endDate);
  if (current) {
    return {
      open: false,
      title: `Loja fechada hoje (até ${formatDatePt(current.endDate)})`,
      detail: `Motivo: ${current.reason}`,
      next,
    };
  }
  return { open: true, title: 'Loja aberta hoje', detail: 'Reservas seguem as regras normais de disponibilidade.', next };
}
