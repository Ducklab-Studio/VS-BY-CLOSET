import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LegalPage } from '@/components/LegalPage';
import { termsPageEnabled } from '@/lib/vale-pass-terms-draft';
import {
  loadAndVerifyOfficialTerms,
  type TermBlock,
} from '@/lib/vale-pass-official-terms-loader';

// Lida do ambiente a cada pedido (não vira página estática): ligar/desligar é só configuração do servidor.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Termos e Condições do Valle Pass 2027',
  description: 'Termos e Condições de Compra e Utilização do Valle Pass 2027 (versão oficial 2027-1).',
  // Não indexada até deliberação de publicação final
  robots: { index: false, follow: false },
};

function renderBlock(block: TermBlock, key: string) {
  switch (block.type) {
    case 'p':
      return <p key={key}>{block.text}</p>;
    case 'h3':
      return <h3 key={key}>{block.text}</h3>;
    case 'brand_heading':
      return (
        <h4 key={key} className="vp-terms-brand-title">
          {block.text}
        </h4>
      );
    case 'bullet_list':
      return (
        <ul key={key}>
          {block.items.map((item, i) => (
            <li key={`${key}-${i}`}>{item}</li>
          ))}
        </ul>
      );
    case 'letter_list':
      return (
        <ul key={key} className="vp-terms-letter-list">
          {block.items.map((item, i) => (
            <li key={`${key}-${i}`}>{item}</li>
          ))}
        </ul>
      );
    case 'signature':
      return (
        <div key={key} className="vp-terms-signature">
          <p className="vp-terms-signature-group">
            <strong>{block.brandGroup}</strong>
          </p>
          <p className="vp-terms-signature-brands">{block.brands}</p>
          <p className="vp-terms-signature-tagline">
            <em>{block.tagline}</em>
          </p>
        </div>
      );
  }
}

/**
 * Página oficial dos Termos e Condições do Valle Pass 2027 (versão oficial 2027-1).
 *
 * Requisitos estritos cumpridos:
 *  1. Preserva fielmente todas as 36 cláusulas, palavras, formatações e condições do documento original.
 *  2. Não aplica tipografia destrutiva (aspas inteligentes, hifenização forçada, substituição de moeda).
 *  3. Preserva a hierarquia completa: seções 1 a 8, subseções 5.1 a 5.4, alíneas a a e, assinatura.
 *  4. Exibe identificação explícita "Versão 2027-1".
 *  5. Validação obrigatória de SHA-256 e bytes do arquivo oficial na carga da página (fail closed).
 *  6. Bloqueada em 404 até `VALE_PASS_TERMS_PAGE=on` estar expressamente configurado.
 */
export default function ValePassTermsPage() {
  if (!termsPageEnabled()) notFound();

  const terms = loadAndVerifyOfficialTerms();

  return (
    <LegalPage
      title={terms.docHeader.title}
      updatedAt={`Versão oficial ${terms.meta.version}`}
    >
      <div className="vp-terms-intro" data-testid="valle-pass-terms-official-intro">
        <div className="vp-terms-version-badge-wrap">
          <span className="vp-terms-version-badge" data-testid="valle-pass-terms-version-badge">
            Versão {terms.meta.version}
          </span>
          <span className="vp-terms-validity-badge">
            {terms.docHeader.validity}
          </span>
        </div>
        <p className="vp-terms-doc-subtitle">
          {terms.docHeader.subtitle}
        </p>
      </div>

      {terms.sections.flatMap((section) => [
        <h2 key={`h2-${section.number}`}>{section.title}</h2>,
        <div
          key={`body-${section.number}`}
          data-section={`secao-${section.number}`}
          className="vp-terms-section-content"
        >
          {section.blocks.map((block, idx) => renderBlock(block, `${section.number}-${idx}`))}
        </div>,
      ])}
    </LegalPage>
  );
}
