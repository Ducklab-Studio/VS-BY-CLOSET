import type { Metadata } from 'next';
import { LegalPage } from '@/components/layout/LegalPage';

export const metadata: Metadata = { title: 'Trocas e Devoluções' };

export default function ReturnsPage() {
  return (
    <LegalPage title="Política de Troca e Devolução" updatedAt="Junho de 2026">
      <p>
        Sua satisfação é nossa prioridade. Conforme o Código de Defesa do Consumidor, você pode
        solicitar troca ou devolução nas condições abaixo.
      </p>
      <h2>1. Prazo</h2>
      <p>
        Você tem até <strong>7 dias corridos</strong> (direito de arrependimento) para devolução por
        desistência e até <strong>30 dias</strong> para troca por defeito ou tamanho.
      </p>
      <h2>2. Condições</h2>
      <p>
        O produto deve estar sem uso, com etiquetas e na embalagem original. Peças íntimas não são
        elegíveis por questões de higiene.
      </p>
      <h2>3. Como solicitar</h2>
      <p>
        Acesse <strong>Minha Conta → Pedidos</strong>, selecione o pedido e o item, escolha o motivo
        e anexe fotos. Após aprovação, enviaremos uma etiqueta de postagem.
      </p>
      <h2>4. Reembolso</h2>
      <p>
        Após o recebimento e inspeção do produto, o reembolso é processado em até 10 dias úteis na
        mesma forma de pagamento, ou você pode optar por troca/crédito.
      </p>
    </LegalPage>
  );
}
