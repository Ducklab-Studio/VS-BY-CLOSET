import type { Metadata } from 'next';
import { LegalPage } from '@/components/layout/LegalPage';

export const metadata: Metadata = { title: 'Termos de Uso' };

export default function TermsPage() {
  return (
    <LegalPage title="Termos de Uso" updatedAt="Junho de 2026">
      <p>
        Ao acessar e utilizar esta loja, você concorda com os termos descritos abaixo. Leia com
        atenção antes de realizar uma compra.
      </p>
      <h2>1. Cadastro</h2>
      <p>
        Você é responsável pela veracidade dos dados informados e pela confidencialidade da sua
        senha.
      </p>
      <h2>2. Pedidos e pagamentos</h2>
      <p>
        Todos os pedidos estão sujeitos a confirmação de pagamento e disponibilidade de estoque.
        Reservamo-nos o direito de cancelar pedidos com indícios de fraude.
      </p>
      <h2>3. Preços</h2>
      <p>
        Os preços podem ser alterados sem aviso prévio, respeitando-se o valor vigente no momento da
        finalização da compra.
      </p>
      <h2>4. Propriedade intelectual</h2>
      <p>
        Todo o conteúdo do site (textos, imagens, marca) é protegido e não pode ser reproduzido sem
        autorização.
      </p>
    </LegalPage>
  );
}
