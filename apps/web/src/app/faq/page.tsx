import type { Metadata } from 'next';
import { LegalPage } from '@/components/layout/LegalPage';

export const metadata: Metadata = {
  title: 'Perguntas frequentes (FAQ)',
  description:
    'Dúvidas sobre aluguel de roupa de neve: prazos, tamanhos, higienização, caução, danos e compra de peças.',
};

const faqs = [
  {
    q: 'Com quanta antecedência devo reservar?',
    a: 'Recomendamos pelo menos 15 dias antes da viagem. Em julho e agosto, alta temporada, as peças mais procuradas esgotam com semanas de antecedência. A reserva garante o item nas suas datas.',
  },
  {
    q: 'Quando recebo e quando devolvo?',
    a: 'Enviamos para chegar com folga antes da data de ida. A contagem do período considera os dias de uso, não o trânsito dos Correios. Na volta, você tem até 2 dias úteis após a data de devolução para postar.',
  },
  {
    q: 'Preciso lavar antes de devolver?',
    a: 'Não. A higienização é por nossa conta e já está no valor. Devolva a peça como está — só pedimos que esteja seca, para não danificar no transporte.',
  },
  {
    q: 'E se eu errar o tamanho?',
    a: 'Cada peça tem tabela de medidas detalhada. Se errar, fale com a gente assim que receber: havendo disponibilidade e tempo hábil antes da viagem, trocamos sem custo além do frete.',
  },
  {
    q: 'E se a peça danificar durante o uso?',
    a: 'Desgaste normal está coberto. Danos maiores — rasgo, queimadura, mancha permanente — são avaliados na devolução e podem gerar cobrança proporcional ao reparo. Perda ou não devolução implica cobrança do valor da peça.',
  },
  {
    q: 'Existe cobrança de caução?',
    a: 'Em algumas peças, sim. Quando houver, o valor aparece no checkout antes de você confirmar. A caução é liberada em até 7 dias após a devolução ser conferida.',
  },
  {
    q: 'Posso comprar em vez de alugar?',
    a: 'Pode. Parte da coleção está disponível para compra, sinalizada no catálogo. Peças de uso pessoal como luvas, meias e óculos costumam ser só para venda, por questão de higiene.',
  },
  {
    q: 'Posso estender o período do aluguel?',
    a: 'Sim, desde que a peça não esteja reservada para outro cliente na sequência. Avise antes do fim do período combinado para verificarmos.',
  },
  {
    q: 'Quais as formas de pagamento?',
    a: 'Cartão de crédito, PIX e boleto. O processamento é feito por gateway certificado — não armazenamos dados do seu cartão.',
  },
  {
    q: 'Posso cancelar a reserva?',
    a: 'Com mais de 7 dias de antecedência, reembolso integral. Entre 7 e 2 dias, reembolso parcial. Com menos de 48h do envio não há reembolso, porque a peça já foi separada e ficou indisponível para outros clientes.',
  },
];

export default function FaqPage() {
  return (
    <LegalPage title="Perguntas frequentes">
      {faqs.map((f) => (
        <div key={f.q}>
          <h2>{f.q}</h2>
          <p>{f.a}</p>
        </div>
      ))}
    </LegalPage>
  );
}
