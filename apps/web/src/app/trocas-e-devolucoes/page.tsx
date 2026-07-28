import type { Metadata } from 'next';
import { LegalPage } from '@/components/layout/LegalPage';

export const metadata: Metadata = {
  title: 'Devoluções, trocas e cancelamentos',
  description:
    'Como devolver as peças alugadas, prazos de cancelamento, troca de tamanho e política de danos.',
};

export default function ReturnsPage() {
  return (
    <LegalPage title="Devoluções, trocas e cancelamentos" updatedAt="Julho de 2026">
      <p>
        Esta política cobre dois casos distintos: peças <strong>alugadas</strong>, que voltam para
        nós ao fim do período, e peças <strong>compradas</strong>, que ficam com você.
      </p>

      <h2>1. Devolução das peças alugadas</h2>
      <p>
        Você tem até <strong>2 dias úteis</strong> após a data de devolução acordada para postar as
        peças. A etiqueta de postagem vai junto do pedido. Atraso gera cobrança proporcional aos
        dias adicionais, porque a peça pode estar reservada para outro cliente na sequência.
      </p>
      <p>
        <strong>Não é necessário lavar.</strong> A higienização está incluída no valor da locação.
        Pedimos apenas que a peça esteja seca ao ser embalada.
      </p>

      <h2>2. Cancelamento de reserva</h2>
      <p>Reembolso conforme a antecedência em relação à data de envio:</p>
      <ul>
        <li>
          <strong>Mais de 7 dias:</strong> reembolso integral.
        </li>
        <li>
          <strong>Entre 7 e 2 dias:</strong> reembolso de 50%.
        </li>
        <li>
          <strong>Menos de 48 horas:</strong> sem reembolso — a peça já foi separada e ficou
          indisponível para outros clientes no período.
        </li>
      </ul>

      <h2>3. Troca de tamanho</h2>
      <p>
        Confira o caimento assim que receber. Havendo disponibilidade e tempo hábil antes da viagem,
        trocamos o tamanho sem custo além do frete de reenvio. É por isso que recomendamos receber
        com alguns dias de folga.
      </p>

      <h2>4. Danos e perdas</h2>
      <p>
        Desgaste natural de uso está coberto e não gera cobrança — é esperado em peça de locação.
        Geram cobrança:
      </p>
      <ul>
        <li>Rasgos, furos e queimaduras</li>
        <li>Manchas permanentes que não saem na higienização profissional</li>
        <li>Perda de peças, acessórios ou zíperes</li>
        <li>Não devolução dentro do prazo</li>
      </ul>
      <p>
        A avaliação é feita na conferência da devolução, com registro fotográfico, e o valor é
        proporcional ao reparo. Em perda ou dano irreparável, cobra-se o valor de reposição da peça.
      </p>

      <h2>5. Peças compradas</h2>
      <p>
        Para itens adquiridos, vale o Código de Defesa do Consumidor: <strong>7 dias corridos</strong>{' '}
        de direito de arrependimento a contar do recebimento e <strong>30 dias</strong> para troca
        por defeito de fabricação. A peça deve estar sem uso, com etiquetas e na embalagem original.
      </p>
      <p>
        Itens de uso pessoal — luvas, meias, toucas e protetores — não são elegíveis a troca por
        arrependimento, por questão de higiene, salvo defeito de fabricação.
      </p>

      <h2>6. Como solicitar</h2>
      <p>
        Fale conosco pela página de <strong>Contato</strong> ou responda o e-mail de confirmação do
        pedido, informando o número da reserva e, quando houver, fotos do problema. Respondemos em
        até 1 dia útil.
      </p>

      <h2>7. Reembolsos</h2>
      <p>
        Aprovado o reembolso, o valor volta pela mesma forma de pagamento em até 10 dias úteis.
        Cauções são liberadas em até 7 dias após a conferência da devolução.
      </p>
    </LegalPage>
  );
}
