import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { LegalPage } from '@/components/LegalPage';
import { DRAFT_NOTICE, TERMS_APPROVED, TERMS_SECTIONS, termsPageEnabled } from '@/lib/vale-pass-terms-draft';

// Lida do ambiente a cada pedido (não vira página estática): ligar/desligar é só configuração do servidor.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Termos e condições do Valle Pass',
  description: 'Estrutura dos termos e condições do Valle Pass 2027 (texto oficial pendente de aprovação).',
  // Nunca indexada enquanto o texto oficial não existir.
  robots: { index: false, follow: false },
};

/**
 * Estrutura da página de termos do Valle Pass. Fica NÃO publicada (404) até `VALE_PASS_TERMS_PAGE=on`. Enquanto `TERMS_APPROVED` for falso, mostra
 * o aviso de rascunho e separa o que já é confirmado do que ainda está em definição — sem cláusulas inventadas.
 */
export default function ValePassTermsPage() {
  if (!termsPageEnabled()) notFound();
  return (
    <LegalPage title="Termos e condições do Valle Pass" updatedAt={TERMS_APPROVED ? undefined : 'Rascunho — texto oficial pendente'}>
      {!TERMS_APPROVED ? (
        <p data-testid="valle-pass-terms-draft-notice" role="note">
          <strong>{DRAFT_NOTICE}</strong>
        </p>
      ) : (
        <p>Estes termos e condições valem para o Valle Pass 2027.</p>
      )}
      {TERMS_SECTIONS.flatMap((section, index) => [
        <h2 key={`${section.id}-h`}>{`${index + 1}. ${section.title}`}</h2>,
        <div key={`${section.id}-b`} data-section={section.id}>
          {section.confirmed.length > 0 ? (
            <>
              <p>
                <strong>Já confirmado</strong>
              </p>
              <ul>
                {section.confirmed.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : null}
          {section.pending.length > 0 ? (
            <>
              <p>
                <strong>Em definição</strong>
              </p>
              <ul data-pending>
                {section.pending.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </>
          ) : null}
          {section.id === 'atendimento' ? (
            <p>
              <Link href="/contato">Ir para a página de contato</Link>
            </p>
          ) : null}
          {section.id === 'dados-pessoais' ? (
            <p>
              <Link href="/politica-de-privacidade">Ler a política de privacidade</Link>
            </p>
          ) : null}
        </div>,
      ])}
    </LegalPage>
  );
}
