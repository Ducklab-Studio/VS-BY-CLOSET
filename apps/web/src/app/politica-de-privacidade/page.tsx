import type { Metadata } from 'next';
import { LegalPage } from '@/components/layout/LegalPage';

export const metadata: Metadata = { title: 'Política de Privacidade' };

export default function PrivacyPage() {
  return (
    <LegalPage title="Política de Privacidade" updatedAt="Junho de 2026">
      <p>
        Esta Política descreve como coletamos, usamos e protegemos seus dados pessoais, em
        conformidade com a Lei Geral de Proteção de Dados (LGPD — Lei nº 13.709/2018).
      </p>
      <h2>1. Dados que coletamos</h2>
      <p>
        Nome, e-mail, telefone, CPF, endereço de entrega e histórico de reservas — dados necessários
        para processar suas locações, entregas e devoluções.
      </p>
      <h2>2. Como usamos seus dados</h2>
      <p>
        Para processar pedidos, emitir nota fiscal, calcular frete, enviar atualizações de entrega e,
        com seu consentimento, comunicações de marketing.
      </p>
      <h2>3. Compartilhamento</h2>
      <p>
        Compartilhamos dados apenas com parceiros essenciais (transportadoras, gateways de pagamento)
        e quando exigido por lei.
      </p>
      <h2>4. Seus direitos</h2>
      <p>
        Você pode acessar, corrigir ou excluir seus dados, além de revogar consentimentos, entrando
        em contato pelo e-mail privacidade@minhaloja.com.br.
      </p>
    </LegalPage>
  );
}
