import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { VALE_PASS_VOUCHERS } from '@/lib/vale-pass-offer';

/**
 * Chamada compacta do Valle Pass na home: só apresenta e leva para `/valle-pass`. Estática de propósito: sem consulta à Shopify, sem preço (o preço e o estado da
 * venda vivem na página) e sem botão de compra.
 */
export function ValePassHomeCallout() {
  return (
    <section className="vp-callout" aria-labelledby="vp-callout-title" data-testid="vp-home-callout">
      <div className="vp-callout-inner" data-reveal>
        <div className="vp-callout-copy">
          <p className="eyebrow">Pré-lançamento</p>
          <h2 id="vp-callout-title">
            Valle Pass <em>2027</em>
          </h2>
          <p className="vp-callout-text">Dois vouchers em um só passe, um para cada empresa. Conheça como vai funcionar.</p>
        </div>
        <ul className="vp-callout-vouchers" aria-label="Vouchers do Valle Pass">
          {VALE_PASS_VOUCHERS.map((voucher) => (
            <li key={voucher.id}>
              <span>{voucher.company}</span>
              <strong>{voucher.amountLabel}</strong>
            </li>
          ))}
        </ul>
        <Link href="/valle-pass" className="editorial-button light vp-callout-link">
          Conhecer o Valle Pass <ArrowUpRight size={18} />
        </Link>
      </div>
    </section>
  );
}
