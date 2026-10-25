import type { LaunchChecklistItem, LaunchChecklistNature, LaunchChecklistOwner, LaunchChecklistStatus, LaunchReadiness } from '@/lib/admin-data';
import { formatGeneratedAt, groupItems, headline, NATURE_LABELS, openWithAnderson, openWithoutAnderson, OWNER_HINTS, OWNER_LABELS, STATUS_LABELS } from '@/lib/valle-pass-launch-readiness';

/**
 * "Pronta para vender?" — painel SOMENTE LEITURA do ClosetAdmin. Sem botões, formulários nem ações: não abre vendas, não altera estoque e não liga chaves
 * (isso é feito na Shopify e no Railway, com autorização). Separa o que o time resolve (técnico) do que depende do Anderson e nunca mostra "aprovado"
 * para o que o sistema não consegue comprovar. Componente de servidor: para atualizar, recarregue a página.
 */

const BADGE: Record<LaunchChecklistStatus, string> = {
  APPROVED: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300',
  PENDING: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  BLOCKED: 'bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300',
};

const NATURE_BADGE: Record<LaunchChecklistNature, string> = {
  TECNICO: 'bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300',
  COMERCIAL: 'bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300',
  JURIDICO: 'bg-rose-100 text-rose-800 dark:bg-rose-950/60 dark:text-rose-300',
};

const OWNERS: readonly LaunchChecklistOwner[] = ['TECNICO', 'ANDERSON'];

function Row({ entry }: { entry: LaunchChecklistItem }) {
  return (
    <li className="flex items-start gap-3 py-2" data-item={entry.id} data-status={entry.status}>
      <span className={`mt-0.5 inline-block shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${BADGE[entry.status]}`}>{STATUS_LABELS[entry.status]}</span>
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink dark:text-dark-text">
          {entry.label}{' '}
          <span className={`ml-1 inline-block rounded-full px-2 py-px align-middle text-[0.62rem] font-semibold uppercase tracking-wide ${NATURE_BADGE[entry.nature]}`} data-nature={entry.nature}>
            {NATURE_LABELS[entry.nature]}
          </span>
        </p>
        <p className="mt-0.5 text-[0.75rem] leading-snug text-ink/60 dark:text-dark-muted">{entry.message}</p>
        {entry.nextStep ? (
          <p className="mt-0.5 text-[0.72rem] leading-snug text-ink/75 dark:text-dark-text" data-next-step={entry.id}>
            <span className="font-semibold">Próximo passo:</span> {entry.nextStep}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function OwnerColumn({ owner, readiness }: { owner: LaunchChecklistOwner; readiness: LaunchReadiness }) {
  const groups = groupItems(readiness.items, owner);
  const c = owner === 'TECNICO' ? readiness.summary.technical : readiness.summary.anderson;
  return (
    <section className="rounded-xl border border-ink/10 p-3 dark:border-white/10" data-owner={owner} aria-label={OWNER_LABELS[owner]}>
      <h4 className="text-sm font-semibold text-ink dark:text-dark-text">{OWNER_LABELS[owner]}</h4>
      <p className="mt-0.5 text-[0.7rem] text-ink/45 dark:text-dark-subtle">{OWNER_HINTS[owner]}</p>
      <p className="mt-1 text-xs text-ink/60 dark:text-dark-muted" data-counts={owner}>
        {c.approved} aprovado(s) · {c.pending} pendente(s) · {c.blocked} bloqueado(s)
      </p>
      {groups.length === 0 ? (
        <p className="mt-2 text-xs text-ink/50 dark:text-dark-subtle">Nenhum requisito neste grupo.</p>
      ) : (
        groups.map((g) => (
          <div key={g.group} className="mt-3" data-group={g.group}>
            <h5 className="text-[0.68rem] font-semibold uppercase tracking-[0.12em] text-ink/50 dark:text-dark-subtle">{g.label}</h5>
            <ul className="divide-y divide-ink/5 dark:divide-white/5">
              {g.items.map((entry) => (
                <Row key={entry.id} entry={entry} />
              ))}
            </ul>
          </div>
        ))
      )}
    </section>
  );
}

export function LaunchReadinessPanel({ readiness, error }: { readiness: LaunchReadiness | null; error: string | null }) {
  const verdictClass = readiness?.readyToSell ? BADGE.APPROVED : readiness ? BADGE.BLOCKED : BADGE.PENDING;
  return (
    <details className="mb-6 rounded-xl border border-ink/10 bg-white/60 p-4 dark:border-white/10 dark:bg-dark-surface/60" data-testid="launch-readiness" open={readiness !== null && !error ? undefined : true}>
      <summary className="cursor-pointer select-none text-sm font-semibold text-ink dark:text-dark-text">
        <span data-testid="launch-readiness-headline">{error ? 'Pronta para vender? Não foi possível verificar' : headline(readiness)}</span>
        {!error && readiness ? (
          <span className={`ml-2 inline-block rounded-full px-2.5 py-0.5 align-middle text-xs font-semibold ${verdictClass}`} data-testid="launch-readiness-verdict">
            {readiness.readyToSell ? 'PRONTA' : 'NÃO PRONTA'}
          </span>
        ) : null}
      </summary>

      <p className="mt-3 text-[0.75rem] leading-snug text-ink/60 dark:text-dark-muted" data-testid="launch-readiness-notice">
        Somente leitura. Esta tela não abre vendas, não altera o estoque da Shopify e não liga chaves. Nenhum item é aprovado sem evidência real no sistema; decisões do
        Anderson, parecer jurídico e a compra de teste real ficam pendentes até serem comprovados por outro meio. Campanha, contagens e chaves vêm da API no momento da leitura; o endereço
        dos termos vem do site publicado; o estoque da Shopify NÃO é consultado.
      </p>

      {error ? (
        <p role="alert" className="mt-3 rounded-lg border border-red-300/60 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300" data-testid="launch-readiness-error">
          Não foi possível carregar a prontidão: {error}
        </p>
      ) : !readiness ? (
        <p className="mt-3 text-sm text-ink/60 dark:text-dark-muted" data-testid="launch-readiness-empty">
          Sem dados de prontidão no momento.
        </p>
      ) : (
        <>
          <p className="mt-3 text-xs text-ink/60 dark:text-dark-muted" data-testid="launch-readiness-freshness">
            {formatGeneratedAt(readiness.generatedAt)
              ? `Leitura feita em ${formatGeneratedAt(readiness.generatedAt)} (horário de São Paulo), ao abrir esta página. Não atualiza sozinha: recarregue para ler de novo.`
              : 'Horário da leitura indisponível: não trate estes dados como atuais. Recarregue a página.'}
          </p>
          <p className="mt-1 text-xs text-ink/60 dark:text-dark-muted" data-testid="launch-readiness-campaign">
            {readiness.campaign ? `Campanha: ${readiness.campaign.name}${readiness.campaign.active ? '' : ' (inativa)'}` : 'Nenhuma campanha cadastrada.'}
          </p>
          <p className="mt-2 rounded-lg border border-sky-300/50 bg-sky-50 p-2.5 text-[0.75rem] leading-snug text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-200" data-testid="launch-readiness-split">
            Podem ser concluídos <strong>sem esperar o Anderson</strong>: {openWithoutAnderson(readiness.items).length} item(ns) abertos. Dependem dele ou do jurídico:{' '}
            {openWithAnderson(readiness.items).length}. Concluir sem o Anderson não dispensa a autorização expressa para mexer na produção (chaves, termos publicados, compra de teste).
          </p>
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            {OWNERS.map((owner) => (
              <OwnerColumn key={owner} owner={owner} readiness={readiness} />
            ))}
          </div>
        </>
      )}
    </details>
  );
}
