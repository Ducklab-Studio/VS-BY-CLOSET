'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Store } from 'lucide-react';
import type { ValePassOperatorCompany, ValePassOperatorOverview } from '@/lib/admin-data';
import { loadValePassOperatorsAction, setValePassOperatorCompanyAction } from './actions';

/**
 * Vínculo operador↔estabelecimento (só o proprietário). Mostra quem pode resgatar vouchers de cada loja e permite conceder/revogar, com confirmação.
 * A tela só ENCAMINHA: a API revalida (somente SUPER_ADMIN), audita (ação crítica) e é a barreira de verdade. Nenhum vínculo é criado por padrão.
 */
const COMPANIES: readonly { readonly id: ValePassOperatorCompany; readonly label: string }[] = [
  { id: 'VALLE_SHOWROOM', label: 'Valle Showroom' },
  { id: 'VS_BY_CLOSET', label: 'VS BY CLOSET' },
];
const ROLE_LABELS = { ADMIN: 'Administrador', STAFF: 'Funcionário' } as const;

const buttonClass =
  'inline-flex items-center justify-center rounded-lg border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-50 border-ink/15 text-ink/75 hover:bg-ink/[0.04] dark:border-white/15 dark:text-dark-text dark:hover:bg-white/5';

interface Pending {
  readonly userId: string;
  readonly userName: string;
  readonly company: ValePassOperatorCompany;
  readonly grant: boolean;
}

export function OperatorScopesPanel() {
  const [expanded, setExpanded] = useState(false);
  const [overview, setOverview] = useState<ValePassOperatorOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const result = await loadValePassOperatorsAction();
    setLoading(false);
    if (result.error !== null) setError(result.error);
    else {
      setError(null);
      setOverview(result.data);
    }
  }, []);

  useEffect(() => {
    if (expanded && !overview) void refresh();
  }, [expanded, overview, refresh]);

  async function confirm() {
    if (!pending || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    const result = await setValePassOperatorCompanyAction(pending.userId, pending.company, pending.grant);
    inFlight.current = false;
    setBusy(false);
    if (result.ok) {
      setNotice(`${pending.grant ? 'Vínculo concedido' : 'Vínculo revogado'}: ${pending.userName} — ${COMPANIES.find((c) => c.id === pending.company)?.label}.`);
      setError(null);
      setPending(null);
      await refresh();
    } else {
      setError(result.error);
      setPending(null);
    }
  }

  return (
    <section className="space-y-4" aria-label="Quem opera cada estabelecimento">
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded} className="flex w-full items-center justify-between gap-2 text-left">
        <span className="flex items-center gap-2">
          <Store size={18} className="text-marsala dark:text-gold" />
          <h2 className="font-heading text-lg font-semibold text-ink dark:text-dark-text">Quem opera cada estabelecimento</h2>
        </span>
        {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      {expanded ? (
        <div className="space-y-3">
          <p className="text-xs leading-relaxed text-ink/60 dark:text-dark-subtle">
            Define quem pode resgatar vouchers de cada loja. Ninguém recebe vínculo por padrão. Administrador <strong>sem</strong> vínculo mantém, por enquanto, o acesso às duas lojas;
            <strong> com</strong> vínculo fica restrito às lojas marcadas. Funcionários (STAFF) ainda não podem resgatar, mesmo vinculados: essa liberação depende de decisão comercial.
          </p>
          {loading && !overview ? <p role="status" className="text-sm text-ink/60">Carregando…</p> : null}
          {error ? <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/[0.08] px-3 py-2 text-xs text-red-500">{error}</p> : null}
          {notice ? <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/[0.08] px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">{notice}</p> : null}
          {overview ? (
            <>
              <p className="text-xs text-ink/60 dark:text-dark-subtle">
                {overview.summary.adminsWithoutScope} administrador(es) sem vínculo (não realizam resgates) · {overview.summary.legacyAdminOperationsLast30Days} operação(ões) pelo antigo acesso às duas lojas nos últimos 30 dias.
              </p>
              {overview.users.length === 0 ? <p className="text-sm text-ink/60">Nenhum administrador ou funcionário do Valle Pass encontrado.</p> : null}
              <ul className="space-y-2">
                {overview.users.map((user) => (
                  <li key={user.id} className="rounded-xl border border-ink/10 p-3 dark:border-white/10" data-testid="operator-row">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm font-medium text-ink dark:text-dark-text">
                        {user.name} <span className="ml-1 rounded-full bg-ink/[0.06] px-2 py-0.5 text-[0.68rem] font-semibold text-ink/60 dark:bg-white/10 dark:text-dark-subtle">{ROLE_LABELS[user.role]}</span>
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {COMPANIES.map((company) => {
                          const has = user.companies.includes(company.id);
                          return (
                            <button
                              key={company.id}
                              type="button"
                              disabled={busy}
                              aria-pressed={has}
                              onClick={() => { setNotice(null); setPending({ userId: user.id, userName: user.name, company: company.id, grant: !has }); }}
                              className={`${buttonClass} ${has ? 'border-marsala/40 bg-marsala/10 text-marsala dark:border-gold/40 dark:bg-gold/10 dark:text-gold' : ''}`}
                            >
                              {company.label}: {has ? 'autorizado' : 'sem vínculo'}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                    <p className="mt-1.5 text-[0.7rem] text-ink/50 dark:text-dark-subtle">
                      {user.role === 'STAFF'
                        ? user.companies.length > 0 ? 'Vinculado, mas o resgate por funcionários ainda não foi liberado.' : 'Sem vínculo: não realiza resgates.'
                        : user.companies.length === 0 ? 'Sem vínculo: não realiza resgates.' : 'Restrito às lojas marcadas.'}
                    </p>
                    {pending && pending.userId === user.id ? (
                      <div role="alertdialog" aria-label="Confirmar alteração de vínculo" className="mt-2 space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.07] p-2.5 text-xs">
                        <p>
                          {pending.grant ? 'Conceder' : 'Revogar'} o vínculo de <strong>{pending.userName}</strong> com a <strong>{COMPANIES.find((c) => c.id === pending.company)?.label}</strong>?
                          {!pending.grant && user.companies.length === 1 && user.role === 'ADMIN' ? ' Sem nenhum vínculo, este administrador deixa de realizar resgates.' : ''}
                        </p>
                        <div className="flex gap-2">
                          <button type="button" disabled={busy} onClick={() => void confirm()} className={buttonClass}>{busy ? 'Salvando…' : 'Confirmar'}</button>
                          <button type="button" disabled={busy} onClick={() => setPending(null)} className={buttonClass}>Cancelar</button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
