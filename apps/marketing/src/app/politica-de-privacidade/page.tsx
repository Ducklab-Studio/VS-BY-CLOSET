import type { Metadata } from 'next';
import { LegalPage } from '@/components/LegalPage';

export const metadata: Metadata = { title: 'Política de Privacidade' };

/**
 * Rascunho de boa-fé alinhado à arquitetura real (dados de checkout e conta
 * processados pelo Shopify, cobrança em reais por gateway brasileiro ainda
 * não escolhido — ver README) — não substitui revisão jurídica. Cobrança em
 * BRL, mas retirada/devolução acontecem fisicamente no Chile: vale confirmar
 * com advogado se isso implica aplicação da Ley 19.628 chilena além da LGPD
 * (Lei nº 13.709/2018), e qual jurisdição rege o negócio conforme onde a
 * empresa for registrada.
 */
export default function PrivacyPage() {
  return (
    <LegalPage title="Política de Privacidade" updatedAt="Agosto de 2026">
      <p>
        Esta Política descreve como coletamos, usamos e protegemos seus dados pessoais ao reservar
        uma locação na Valle&apos;s Closet.
      </p>

      <h2>1. Dados que coletamos</h2>
      <p>
        Nome, e-mail, telefone e histórico de reservas — coletados no checkout, hospedado e
        processado pela nossa plataforma de comércio (Shopify). Dados de pagamento são processados
        diretamente pelo gateway de pagamento; não temos acesso ao número do seu cartão.
      </p>

      <h2>2. Como usamos seus dados</h2>
      <p>
        Para confirmar a reserva, identificá-lo na retirada e devolução na loja, e enviar
        atualizações sobre o pedido. Com seu consentimento, também para comunicação de novidades.
      </p>

      <h2>3. Compartilhamento</h2>
      <p>
        Compartilhamos dados apenas com parceiros essenciais à operação — Shopify (checkout e conta)
        e o gateway de pagamento — e quando exigido por lei.
      </p>

      <h2>4. Seus direitos</h2>
      <p>
        Você pode acessar, corrigir ou excluir seus dados, além de revogar consentimentos, entrando
        em contato pela página de <strong>Contato</strong>.
      </p>
    </LegalPage>
  );
}
