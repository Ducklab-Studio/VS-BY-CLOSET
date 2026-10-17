'use client';

import { useState } from 'react';
import type { ValePassBenefitInput, ValePassCapacityBenefit, ValePassCapacityHold } from '@/lib/admin-data';
import { replaceValePassBenefitsAction, resolveValePassHoldAction } from './actions';

/**
 * Valle Pass 2027 — fila de pagamentos retidos e benefícios da campanha (ClosetAdmin).
 *
 * Retenção = pagamento CONFIRMADO que a emissão automática não atendeu (limite global esgotado ou campanha sem validade). A
 * unidade continua contando como consumida. Só ADMIN resolve, com justificativa (auditada): "Emitir" aprova um excedente
 * consciente; "Descartar" só vale depois de o pedido ter sido reembolsado/cancelado na Shopify. Nada aqui reembolsa ou cancela.
 */

const inputClass =
  'w-full rounded-lg border border-ink/15 bg-white px-3 py-2 text-sm text-ink outline-none transition focus:border-marsala focus:ring-2 focus:ring-marsala/20 dark:border-white/15 dark:bg-dark-surface dark:text-dark-text dark:focus:border-gold dark:focus:ring-gold/20';
const secondaryButton =
  'inline-flex items-center gap-1.5 rounded-lg border border-ink/15 px-2.5 py-1.5 text-xs font-medium text-ink/75 transition hover:bg-ink/[0.04] disabled:opacity-50 dark:border-white/15 dark:text-dark-text dark:hover:bg-white/5';
const hintClass = 'mt-1 text-[0.7rem] leading-snug text-ink/45 dark:text-dark-subtle';

const REASON_LABELS: Record<ValePassCapacityHold['reason'], string> = {
  CAPACITY_EXCEEDED: 'Limite global esgotado',
  CAMPAIGN_NOT_READY: 'Campanha sem validade/benefícios prontos',
};
const COMPANY_LABELS = { VALLE_SHOWROOM: 'Valle Showroom', VS_BY_CLOSET: 'VS BY CLOSET' } as const;
const formatCurrency = (cents: number) => (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const formatDateTime = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function HoldsPanel({ holds, canManage, onChanged }: { holds: readonly ValePassCapacityHold[]; canManage: boolean; onChanged: () => void }) {
  return (
    <section aria-label="Pagamentos retidos">
      <h4 className="mb-2 text-xs font-semibold text-red-500">Pagamentos confirmados aguardando resolução ({holds.length})</h4>
      <ul className="space-y-2">
        {holds.map((hold) => (
          <HoldRow key={hold.id} hold={hold} canManage={canManage} onChanged={onChanged} />
        ))}
      </ul>
      <p className={hintClass}>
        A unidade retida continua contando como vendida. &quot;Emitir&quot; cria os vouchers acima do limite (decisão consciente);
        &quot;Descartar&quot; só é aceito depois que o pedido for reembolsado ou cancelado na Shopify. Nenhuma das duas ações mexe no pagamento.
      </p>
    </section>
  );
}

function HoldRow({ hold, canManage, onChanged }: { hold: ValePassCapacityHold; canManage: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function resolve(action: 'issue' | 'dismiss') {
    setPending(true);
    setError(null);
    const result = await resolveValePassHoldAction(hold.id, action, note);
    setPending(false);
    if (result.error) return setError(result.error);
    setOpen(false);
    setNote('');
    onChanged();
  }

  return (
    <li className="rounded-lg border border-red-500/20 px-3 py-2 text-xs text-ink dark:text-dark-text">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          Pedido {hold.shopifyOrderName ?? hold.shopifyOrderId}: {hold.units} unidade(s) · {REASON_LABELS[hold.reason]} · {formatDateTime(hold.createdAt)}
        </span>
        {canManage ? (
          <button type="button" className={secondaryButton} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
            Resolver
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="mt-2 space-y-2">
          <label className="block text-xs font-medium text-ink/60 dark:text-dark-muted">
            Justificativa (fica registrada na auditoria)
            <input className={`${inputClass} mt-1`} value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} />
          </label>
          {error ? (
            <p role="alert" className="text-xs text-red-500">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="button" className={secondaryButton} disabled={pending || note.trim().length < 3} onClick={() => void resolve('issue')}>
              Emitir (excedente aprovado)
            </button>
            <button type="button" className={secondaryButton} disabled={pending || note.trim().length < 3} onClick={() => void resolve('dismiss')}>
              Descartar (pedido não está mais pago)
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/** Modelo comercial do Valle Pass 2027. É só uma SUGESTÃO: nada é salvo até o ADMIN confirmar. As condições do desconto de 10% ainda estão pendentes. */
const VALLE_PASS_2027_PRESET: readonly ValePassBenefitInput[] = [
  { code: 'valle_showroom_500', kind: 'VOUCHER', company: 'VALLE_SHOWROOM', label: 'Voucher Valle Showroom', amountCents: 50_000, sortOrder: 0 },
  { code: 'vs_by_closet_50', kind: 'VOUCHER', company: 'VS_BY_CLOSET', label: 'Voucher VS BY CLOSET', amountCents: 5_000, sortOrder: 1 },
  { code: 'desconto_passeios', kind: 'DISCOUNT', label: '10% de desconto em passeios elegíveis', discountPercent: 10, terms: 'Condições a definir. Direito comercial: não gera desconto automático.', sortOrder: 2 },
];

export function BenefitsPanel({ campaignId, benefits, canManage, onChanged }: { campaignId: string; benefits: readonly ValePassCapacityBenefit[]; canManage: boolean; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setPending(true);
    setError(null);
    const result = await replaceValePassBenefitsAction(campaignId, VALLE_PASS_2027_PRESET);
    setPending(false);
    if (result.error) return setError(result.error);
    setConfirming(false);
    onChanged();
  }

  return (
    <section aria-label="Benefícios do Valle Pass">
      <h4 className="mb-2 text-xs font-semibold text-marsala dark:text-gold">Benefícios por unidade comprada</h4>
      {benefits.length === 0 ? (
        <p className="text-xs text-ink/55 dark:text-dark-muted">Nenhum benefício cadastrado: esta campanha segue o modelo antigo (um voucher por passe).</p>
      ) : (
        <ul className="space-y-1.5">
          {benefits.map((benefit) => (
            <li key={benefit.code} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink/10 px-3 py-2 text-xs text-ink dark:border-white/10 dark:text-dark-text">
              <span>
                {benefit.label}
                {benefit.kind === 'VOUCHER' && benefit.company && benefit.amountCents !== null
                  ? ` · ${formatCurrency(benefit.amountCents)} · exclusivo ${COMPANY_LABELS[benefit.company]}`
                  : benefit.discountPercent !== null
                    ? ` · ${benefit.discountPercent}% (direito comercial, sem código nem saldo)`
                    : ''}
              </span>
              <span className="text-ink/50 dark:text-dark-subtle">
                {benefit.active ? 'ativo' : 'inativo'} · {benefit.vouchersIssued} emitido(s)
              </span>
            </li>
          ))}
        </ul>
      )}
      {canManage && benefits.length === 0 ? (
        confirming ? (
          <div className="mt-2 space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] p-3 text-xs text-ink dark:text-dark-text">
            <p>
              Cadastrar o modelo Valle Pass 2027 (voucher R$ 500 Valle Showroom + voucher R$ 50 VS BY CLOSET + 10% em passeios)? Isto só registra a
              configuração; a emissão dos dois vouchers só passa a valer quando a ligação ao pagamento for autorizada.
            </p>
            {error ? (
              <p role="alert" className="text-red-500">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2">
              <button type="button" className={secondaryButton} disabled={pending} onClick={() => void save()}>
                Confirmar cadastro
              </button>
              <button type="button" className={secondaryButton} disabled={pending} onClick={() => setConfirming(false)}>
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className={`${secondaryButton} mt-2`} onClick={() => setConfirming(true)}>
            Sugerir modelo Valle Pass 2027
          </button>
        )
      ) : null}
      <p className={hintClass}>Empresa e valor de um voucher não mudam depois da primeira emissão. Cada empresa tem saldo próprio: um voucher nunca vale na outra empresa.</p>
    </section>
  );
}
