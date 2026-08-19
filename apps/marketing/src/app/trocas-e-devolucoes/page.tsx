import type { Metadata } from 'next';
import { LegalPage } from '@/components/LegalPage';

export const metadata: Metadata = {
  title: 'Devoluções, trocas e cancelamentos',
  description:
    'Como funciona a devolução na loja, prazos de cancelamento, troca de tamanho e política de danos.',
};

export default function ReturnsPage() {
  return (
    <LegalPage title="Devoluções, trocas e cancelamentos" updatedAt="Agosto de 2026">
      <p>
        Trabalhamos exclusivamente com locação: todas as peças são retiradas e devolvidas na nossa
        loja física no Chile — não há envio pelo correio em nenhuma das duas pontas.
      </p>

      <h2>1. Devolução</h2>
      <p>
        A devolução acontece na mesma loja onde a peça foi retirada, até a data e horário combinados
        no momento da reserva — normalmente antes do seu voo de volta. Atraso na devolução gera
        cobrança proporcional aos dias adicionais, porque a peça pode estar reservada para o próximo
        cliente.
      </p>
      <p>
        <strong>Não é necessário lavar.</strong> A higienização está incluída no valor da locação.
      </p>

      <h2>2. Cancelamento de reserva</h2>
      <p>Reembolso conforme a antecedência em relação à data de retirada:</p>
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
        Como a retirada é presencial, a troca é imediata: prove a peça na loja e, havendo
        disponibilidade, trocamos na hora, sem custo.
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
        <li>Não devolução dentro do prazo combinado</li>
      </ul>
      <p>
        A avaliação é feita na conferência da devolução, com registro fotográfico, e o valor é
        proporcional ao reparo. Em perda ou dano irreparável, cobra-se o valor de reposição da peça.
      </p>

      <h2>5. Como solicitar</h2>
      <p>
        Fale conosco pela página de <strong>Contato</strong> (WhatsApp ou e-mail), informando o
        número da reserva. Respondemos em até 1 dia útil.
      </p>

      <h2>6. Reembolsos</h2>
      <p>
        Aprovado o reembolso, o valor volta pela mesma forma de pagamento em até 10 dias úteis.
        Cauções são liberadas em até 7 dias após a conferência da devolução.
      </p>
    </LegalPage>
  );
}
