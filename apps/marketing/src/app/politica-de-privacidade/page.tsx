import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage } from '@/components/LegalPage';

export const metadata: Metadata = {
  title: 'Política de Privacidade',
  description: 'Como coletamos, usamos e protegemos seus dados pessoais ao reservar uma locação na VS by Closet.',
};

// Fase 10, item 10 — mesmo componente LegalPage usado por Termos de uso e
// Devoluções/trocas, em vez de reimplementar o layout à mão. Conteúdo
// jurídico preservado exatamente como estava.
export default function PrivacyPage() {
  return (
    <LegalPage title="Política de Privacidade" updatedAt="Agosto de 2026">
      <p>
        Esta Política descreve como coletamos, usamos e protegemos seus dados pessoais ao
        reservar uma locação na VS by Closet.
      </p>

      <h2>Dados que coletamos</h2>
      <p>
        Nome, e-mail, telefone e histórico de reservas — coletados no checkout, hospedado e
        processado pela nossa plataforma de comércio (Shopify). Dados de pagamento são
        processados diretamente pelo gateway de pagamento; não temos acesso ao número do seu
        cartão.
      </p>

      <h2>Como usamos seus dados</h2>
      <p>
        Para confirmar a reserva, identificá-lo na retirada e devolução na loja, e enviar
        atualizações sobre o pedido. Com seu consentimento, também para comunicação de
        novidades.
      </p>

      <h2>Compartilhamento</h2>
      <p>
        Compartilhamos dados apenas com parceiros essenciais à operação — Shopify (checkout e
        conta) e o gateway de pagamento — e quando exigido por lei.
      </p>

      <h2>Seus direitos</h2>
      <p>
        Você pode acessar, corrigir ou excluir seus dados, além de revogar consentimentos,
        entrando em contato pela página de <Link href="/contato">Contato</Link>.
      </p>
    </LegalPage>
  );
}
