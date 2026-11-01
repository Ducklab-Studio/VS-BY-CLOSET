import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import './valle-pass.css';
import { getValePassOffer, type ValePassOffer } from '@/lib/vale-pass-offer-data';
import {
  VALE_PASS_VALIDITY_DISCLAIMER,
  VALE_PASS_VOUCHERS,
  valePassHowItWorks,
  valePassPageIndexable,
  valePassValidityText,
} from '@/lib/vale-pass-offer';
import { TERMS_APPROVED } from '@/lib/vale-pass-terms-draft';
import { VALE_PASS_VARIANT_ID } from '@/lib/vale-pass-product';
import { VallePassTermsBox } from '@/components/VallePassTermsBox';

// Disponibilidade e preço vêm da Shopify (somente leitura) e revalidam a cada minuto, como o restante da vitrine.
export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  const offer = await getValePassOffer();
  // `noindex` enquanto a venda estiver fechada, os termos pendentes ou o texto oficial sem aprovação.
  const indexable = valePassPageIndexable({ saleState: offer.saleState, termsHref: offer.termsHref, termsApproved: TERMS_APPROVED });
  return {
    title: 'Valle Pass 2027',
    description: 'Conheça o Valle Pass 2027: um voucher de R$ 500 para a Valle Showroom e outro de R$ 50 para a VS BY CLOSET.',
    robots: indexable ? { index: true, follow: true } : { index: false, follow: false },
  };
}

/**
 * Ação comercial com aceite eletrônico dos termos.
 * FAIL CLOSED: só habilita compra quando os termos foram aceitos com checkbox explícito e token emitido.
 */
function PassCta({ offer, where }: { offer: ValePassOffer; now: Date; where: 'hero' | 'final' }) {
  return <VallePassTermsBox offer={offer} variantId={VALE_PASS_VARIANT_ID} where={where} />;
}

export default async function ValePassPage() {
  const offer = await getValePassOffer();
  const now = new Date();
  const ready = offer.purchasable;

  return (
    <div className="vp" data-testid="vp-page" data-sale-state={ready ? 'open' : 'closed'} data-shopify-state={offer.saleState} data-purchasable={ready ? 'yes' : 'no'}>
      <section className="vp-hero" aria-labelledby="vp-title">
        <span className="vp-orbit" aria-hidden="true" />
        <Image src="/brand/logo-mark.svg" alt="" width={335} height={380} unoptimized aria-hidden="true" className="vp-mark" />
        <p className="eyebrow vp-eyebrow">VS BY CLOSET · VALLE SHOWROOM</p>
        {!ready && (
          <p className="vp-badge" data-testid="vp-badge">
            Pré-lançamento
          </p>
        )}
        <h1 id="vp-title">
          Valle Pass <em>2027</em>
        </h1>
        <p className="vp-lead">Dois vouchers em um só passe: um para a Valle Showroom e outro para a VS BY CLOSET.</p>
        <p className="vp-price" data-testid="vp-price">
          <span className="vp-price-label">Valle Pass 2027</span>
          <strong>{offer.priceLabel}</strong>
        </p>
        <PassCta offer={offer} now={now} where="hero" />
      </section>

      <section className="vp-vouchers" aria-labelledby="vp-vouchers-title">
        <div className="vp-section-head">
          <p className="eyebrow">O que está incluído</p>
          <h2 id="vp-vouchers-title">
            Dois vouchers, <em>um passe.</em>
          </h2>
        </div>
        <div className="vp-voucher-grid">
          {VALE_PASS_VOUCHERS.map((voucher, index) => (
            <article key={voucher.id} className="vp-voucher" data-testid={`vp-voucher-${voucher.id}`}>
              <p className="vp-voucher-index" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </p>
              <p className="vp-voucher-kicker">Voucher</p>
              <h3>{voucher.company}</h3>
              <p className="vp-voucher-amount">{voucher.amountLabel}</p>
              <p className="vp-voucher-note">{voucher.note}</p>
              <p className="vp-voucher-tags">Independente · Intransferível</p>
            </article>
          ))}
        </div>
      </section>

      <section className="vp-validity" aria-labelledby="vp-validity-title">
        <div className="vp-section-head">
          <p className="eyebrow">Validade prevista</p>
          <h2 id="vp-validity-title">
            Uma temporada <em>para viver.</em>
          </h2>
        </div>
        <p className="vp-validity-range" data-testid="vp-validity">
          {valePassValidityText()}
        </p>
        <p className="vp-validity-note">{VALE_PASS_VALIDITY_DISCLAIMER}</p>
      </section>

      <section className="vp-how" aria-labelledby="vp-how-title">
        <div className="vp-section-head">
          <p className="eyebrow">Como funciona</p>
          <h2 id="vp-how-title">
            Simples, <em>do começo ao uso.</em>
          </h2>
        </div>
        <ol className="vp-steps">
          {valePassHowItWorks(ready).map((step, index) => (
            <li key={step.title} className="vp-step" data-testid="vp-step">
              <span className="vp-step-number" aria-hidden="true">
                {String(index + 1).padStart(2, '0')}
              </span>
              <h3>{step.title}</h3>
              <p>{step.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="vp-terms" aria-labelledby="vp-terms-title">
        <h2 id="vp-terms-title">Termos e condições</h2>
        {offer.termsHref ? (
          <p>
            <a href={offer.termsHref} data-testid="vp-terms-link" className="vp-terms-link">
              Ler os termos e condições do Valle Pass
            </a>
          </p>
        ) : (
          <p data-testid="vp-terms-pending">Os termos e condições do Valle Pass serão publicados antes da abertura das vendas.</p>
        )}
        <p className="vp-terms-help">
          Dúvidas? <Link href="/contato">Fale com a gente</Link>.
        </p>
      </section>

      <section className="vp-final" aria-labelledby="vp-final-title">
        <p className="eyebrow vp-final-eyebrow">VS BY CLOSET</p>
        <h2 id="vp-final-title">
          Valle Pass <em>2027</em>
        </h2>
        <PassCta offer={offer} now={now} where="final" />
        <Link href="/pecas" className="vp-final-link">
          Conhecer o closet enquanto isso <ArrowUpRight size={17} />
        </Link>
      </section>
    </div>
  );
}
