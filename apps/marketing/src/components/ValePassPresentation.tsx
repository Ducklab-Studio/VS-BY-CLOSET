import type { StorefrontVariant } from '@/lib/shopify';
import { valePassCheckoutHref } from '@/lib/vale-pass-product';

/**
 * Apresentação própria do Valle Pass — vale-presente/crédito de compra,
 * totalmente separado do fluxo de aluguel. Server component de
 * propósito: sem estado, sem efeito, sem fetch. Não consulta
 * disponibilidade, não cria HOLD, não depende do reservations-api — só
 * um link de compra direto pro checkout oficial da Shopify.
 */
export function ValePassPresentation({
  variant,
  productTitle,
}: {
  variant: StorefrontVariant;
  productTitle: string;
}) {
  const href = valePassCheckoutHref(variant.id);

  return (
    <section className="rounded-2xl border border-marsala/20 bg-marsala/[0.04] p-5 sm:p-6">
      <header className="mb-4">
        <h2 className="text-[0.95rem] font-semibold uppercase tracking-[0.14em] text-marsala">
          Vale-presente Valle Pass
        </h2>
        <p className="mt-2 text-[0.8rem] leading-relaxed text-ink/60">
          Um crédito de compra para usar quando quiser — sem data de retirada nem devolução.
          Depois de confirmado o pagamento, você recebe um código único, validado pela nossa
          equipe no momento do uso.
        </p>
      </header>

      <ul className="mb-5 space-y-1.5 text-[0.78rem] text-ink/65">
        <li>Não exige agenda nem disponibilidade de peças</li>
        <li>Validade conforme a campanha vigente</li>
        <li>Utilizável em qualquer peça do closet, dentro da validade</li>
      </ul>

      <a
        href={href}
        className="flex w-full items-center justify-center rounded-xl bg-marsala px-5 py-3.5 text-[0.8rem] font-semibold uppercase tracking-[0.12em] text-cream transition-opacity hover:opacity-90"
      >
        Comprar {productTitle}
      </a>

      <p className="mt-3 text-center text-[0.7rem] text-ink/50">
        Pagamento processado com segurança pela Shopify.
      </p>
    </section>
  );
}
