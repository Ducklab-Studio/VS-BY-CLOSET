'use client';

import { useEffect, useState, useId } from 'react';
import Link from 'next/link';
import {
  fetchPublicTerms,
  postTermsAcceptance,
  type PublicTermsData,
} from '@/lib/vale-pass-terms-api';
import { isOfficialTermsMatch } from '@/lib/vale-pass-official-terms';
import { valePassCheckoutWithTermsToken } from '@/lib/vale-pass-product';
import type { ValePassOffer } from '@/lib/vale-pass-offer-data';
import { valePassClosedNote } from '@/lib/vale-pass-sale';
import { valePassGateNote } from '@/lib/vale-pass-offer';

interface VallePassTermsBoxProps {
  offer: ValePassOffer;
  variantId: string;
  where: 'hero' | 'final';
}

export function VallePassTermsBox({ offer, variantId, where }: VallePassTermsBoxProps) {
  const checkboxId = useId();
  const [terms, setTerms] = useState<PublicTermsData | null>(null);
  const [termsStatus, setTermsStatus] = useState<'idle' | 'checking' | 'not_approved' | 'approved' | 'error'>('idle');
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function checkTerms() {
    setTermsStatus('checking');
    setErrorMessage(null);
    const result = await fetchPublicTerms();
    if (result.ok && result.status === 200) {
      if (isOfficialTermsMatch(result.terms)) {
        setTerms(result.terms);
        setTermsStatus('approved');
      } else {
        // Fail closed: hash ou versão retornados pela API não batem com o documento oficial embutido.
        // Bloqueia a compra e mantém indisponível sem vazar o hash no cliente.
        setTerms(null);
        setTermsStatus('error');
        console.error('[VallePassTermsBox] Hash ou versão da API diverge dos termos oficiais 2027-1 embutidos.');
      }
    } else if (result.status === 404) {
      setTerms(null);
      setTermsStatus('not_approved');
    } else {
      setTerms(null);
      setTermsStatus('error');
    }
  }

  useEffect(() => {
    // Consulta os termos vigentes no servidor ao montar no navegador
    void checkTerms();

    // Se o cliente voltar da Shopify pelo botão do navegador, exige novo aceite e novo token
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setAccepted(false);
        setSubmitting(false);
        setErrorMessage(null);
      }
    };

    window.addEventListener('pageshow', handlePageShow);
    return () => window.removeEventListener('pageshow', handlePageShow);
  }, []);

  async function handleBuy() {
    if (!accepted || submitting || !terms || !isOfficialTermsMatch(terms)) {
      if (terms && !isOfficialTermsMatch(terms)) {
        setAccepted(false);
        setTerms(null);
        setTermsStatus('error');
      }
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);

    const result = await postTermsAcceptance({
      termsVersion: terms.version,
      termsSha256: terms.sha256,
      accepted: true,
      variantId,
    });

    if (result.ok && result.status === 201) {
      // 201: token emitido com sucesso. Monta link e redireciona sem gravar o token no cliente.
      const checkoutUrl = valePassCheckoutWithTermsToken(variantId, result.grant.token);
      window.location.assign(checkoutUrl);
      return;
    }

    setSubmitting(false);

    if (result.status === 409) {
      // 409 TERMS_VERSION_MISMATCH: desmarca a caixa, recarrega os termos vigentes e notifica o usuário
      setAccepted(false);
      setErrorMessage(result.message);
      void checkTerms();
      return;
    }

    if (result.status === 404) {
      // 404 TERMS_NOT_APPROVED: termos foram revogados ou desativados
      setAccepted(false);
      setTermsStatus('not_approved');
      setErrorMessage(result.message);
      return;
    }

    setErrorMessage(result.message);
  }

  // Só libera quando a API confirma termos aprovados e vigentes
  const isApproved = termsStatus === 'approved' && terms !== null;

  if (!isApproved) {
    const note = valePassGateNote(offer.gateReason) ?? valePassClosedNote(new Date());
    return (
      <div className="vp-cta-block">
        <button
          type="button"
          disabled
          aria-disabled="true"
          aria-describedby={`vp-note-${where}`}
          data-testid={`vp-cta-${where}`}
          data-state="closed"
          className="vp-cta"
        >
          Em breve
        </button>
        <p id={`vp-note-${where}`} data-testid={`vp-note-${where}`} className="vp-cta-note">
          {note}
        </p>
      </div>
    );
  }

  // Termos aprovados e disponíveis: exibe caixa de aceite e botão de compra
  return (
    <div className="vp-cta-block vp-terms-cta-block" data-testid={`vp-terms-cta-${where}`}>
      <div className="vp-terms-box" data-testid="vp-terms-acceptance-box">
        <p className="vp-terms-intro">
          Para prosseguir, leia os{' '}
          <Link
            href="/termos-valle-pass"
            target="_blank"
            rel="noopener noreferrer"
            className="vp-terms-anchor"
            onClick={(e) => e.stopPropagation()}
          >
            Termos e Condições do Valle Pass 2027
          </Link>
          .
        </p>

        <div className="vp-terms-check-row">
          <input
            type="checkbox"
            id={checkboxId}
            checked={accepted}
            disabled={submitting}
            onChange={(e) => {
              setAccepted(e.target.checked);
              if (errorMessage) setErrorMessage(null);
            }}
            className="vp-terms-checkbox"
            data-testid={`vp-terms-checkbox-${where}`}
          />
          <label htmlFor={checkboxId} className="vp-terms-label">
            Li e aceito os{' '}
            <Link
              href="/termos-valle-pass"
              target="_blank"
              rel="noopener noreferrer"
              className="vp-terms-inline-link"
              onClick={(e) => e.stopPropagation()}
            >
              Termos e Condições do Valle Pass 2027 (versão {terms.version})
            </Link>
          </label>
        </div>

        {errorMessage && (
          <p
            role="alert"
            className="vp-terms-error"
            data-testid={`vp-terms-error-${where}`}
          >
            {errorMessage}
          </p>
        )}
      </div>

      <button
        type="button"
        disabled={!accepted || submitting}
        aria-disabled={!accepted || submitting}
        data-testid={`vp-cta-${where}`}
        data-state={accepted ? 'open' : 'closed'}
        onClick={() => void handleBuy()}
        className={`vp-cta ${accepted && !submitting ? 'vp-cta-open' : ''}`}
      >
        {submitting ? 'Preparando...' : 'Comprar o Valle Pass'}
      </button>

      <p className="vp-cta-note">Pagamento processado com segurança pela Shopify.</p>
    </div>
  );
}
