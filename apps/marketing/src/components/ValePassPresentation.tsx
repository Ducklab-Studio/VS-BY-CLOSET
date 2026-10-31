import { formatPrice, type StorefrontVariant } from '@/lib/shopify';
import { resolveValePassCheckout } from '@/lib/vale-pass-offer-data';
import { valePassGateNote } from '@/lib/vale-pass-offer';
import { valePassClosedNote, valePassSaleState } from '@/lib/vale-pass-sale';
import { VALE_PASS_TERMS_HREF } from '@/lib/vale-pass-terms';

/**
 * Apresentação própria do Valle Pass (dois vouchers independentes: Valle Showroom e
 * VS BY CLOSET), totalmente separado do fluxo de aluguel. Server component de
 * propósito: sem estado, sem efeito, sem fetch. Não consulta
 * disponibilidade, não cria HOLD, não depende do reservations-api.
 *
 * Duas telas, decididas SÓ pela disponibilidade que a Shopify informa para a variante (nunca por data):
 *  - pré-lançamento (venda fechada): botão "Em breve" INERTE — não é link e o endereço do checkout nem chega ao HTML;
 *  - venda aberta: link de compra direto pro checkout oficial da Shopify.
 * Termos: só são citados/linkados quando existirem (`VALE_PASS_TERMS_HREF`); nunca se afirma que estão publicados sem estarem.
 */
export function ValePassPresentation({
  variant,
  productTitle,
  now = new Date(),
}: {
  variant: StorefrontVariant;
  productTitle: string;
  now?: Date;
}) {
  // MESMA regra da página /valle-pass: o checkout só existe com a Shopify aberta, os termos publicados E aprovados (fail closed).
  const checkout = resolveValePassCheckout({ saleState: valePassSaleState(variant), variantId: variant.id });
  const closed = !checkout.purchasable;
  const state = closed ? 'closed' : 'open';
  const price = formatPrice(variant.price.amount, variant.price.currencyCode);

  return (
    <section
      data-testid="valle-pass-presentation"
      data-sale-state={state}
      className="rounded-2xl border border-marsala/20 bg-marsala/[0.04] p-5 sm:p-6"
    >
      <header className="mb-4">
        {closed && (
          <p
            data-testid="valle-pass-prelaunch-badge"
            className="mb-3 inline-flex rounded-full border border-marsala/30 px-3 py-1 text-[0.66rem] font-semibold uppercase tracking-[0.16em] text-marsala"
          >
            Pré-lançamento
          </p>
        )}
        <h2 className="text-[0.95rem] font-semibold uppercase tracking-[0.14em] text-marsala">
          Valle Pass
        </h2>
        {closed && (
          <p data-testid="valle-pass-unavailable" role="status" className="mt-2 text-[0.85rem] font-medium leading-relaxed text-ink/80">
            O Valle Pass 2027 ainda não está disponível para compra.
          </p>
        )}
        <p className="mt-2 text-[0.8rem] leading-relaxed text-ink/60">
          Cada Valle Pass inclui um voucher de R$ 500 para a Valle Showroom e um voucher de R$ 50
          para a VS BY CLOSET, independentes entre si e intransferíveis. Depois de confirmado o
          pagamento, você recebe os códigos dos seus vouchers, validados pela nossa equipe no
          momento do uso.
        </p>
      </header>

      <dl className="mb-5 grid grid-cols-3 gap-2 text-center" data-testid="valle-pass-values">
        <div className="rounded-xl bg-white/70 px-2 py-3">
          <dt className="text-[0.62rem] uppercase tracking-[0.12em] text-ink/50">Valle Pass</dt>
          <dd className="mt-1 text-[0.95rem] font-semibold text-marsala">{price}</dd>
        </div>
        <div className="rounded-xl bg-white/70 px-2 py-3">
          <dt className="text-[0.62rem] uppercase tracking-[0.12em] text-ink/50">Valle Showroom</dt>
          <dd className="mt-1 text-[0.95rem] font-semibold text-marsala">R$ 500</dd>
        </div>
        <div className="rounded-xl bg-white/70 px-2 py-3">
          <dt className="text-[0.62rem] uppercase tracking-[0.12em] text-ink/50">VS BY CLOSET</dt>
          <dd className="mt-1 text-[0.95rem] font-semibold text-marsala">R$ 50</dd>
        </div>
      </dl>

      <ul className="mb-5 space-y-1.5 text-[0.78rem] text-ink/65">
        <li>Não exige agenda nem disponibilidade de peças</li>
        <li>Validade conforme a campanha vigente</li>
        {VALE_PASS_TERMS_HREF ? (
          <li>
            <a href={VALE_PASS_TERMS_HREF} data-testid="valle-pass-terms-link" className="underline underline-offset-2 hover:text-marsala">
              Ler os termos e condições do Valle Pass
            </a>
          </li>
        ) : closed ? (
          <li data-testid="valle-pass-terms-pending">Os termos e condições do Valle Pass serão publicados antes da abertura das vendas.</li>
        ) : null}
      </ul>

      {closed ? (
        <>
          <button
            type="button"
            disabled
            aria-disabled="true"
            aria-describedby="valle-pass-closed-note"
            data-testid="valle-pass-cta"
            data-state="closed"
            className="flex w-full cursor-not-allowed items-center justify-center rounded-xl border border-marsala/30 bg-marsala/10 px-5 py-3.5 text-[0.8rem] font-semibold uppercase tracking-[0.12em] text-marsala/80"
          >
            Em breve
          </button>
          <p id="valle-pass-closed-note" data-testid="valle-pass-closed-note" className="mt-3 text-center text-[0.72rem] leading-relaxed text-ink/60">
            {valePassGateNote(checkout.gateReason) ?? valePassClosedNote(now)}
          </p>
        </>
      ) : (
        <>
          <a
            href={checkout.href ?? undefined}
            data-testid="valle-pass-cta"
            data-state="open"
            className="flex w-full items-center justify-center rounded-xl bg-marsala px-5 py-3.5 text-[0.8rem] font-semibold uppercase tracking-[0.12em] text-cream transition-opacity hover:opacity-90"
          >
            Comprar {productTitle}
          </a>
          <p className="mt-3 text-center text-[0.7rem] text-ink/50">
            Pagamento processado com segurança pela Shopify.
          </p>
        </>
      )}
    </section>
  );
}
