import type { Metadata } from 'next';
import { LegalPage } from '@/components/LegalPage';

export const metadata: Metadata = {
  title: 'Perguntas frequentes (FAQ)',
  description:
    'Dúvidas sobre aluguel de roupa de neve no Chile: prazos, tamanhos, higienização, caução e pagamento.',
};

const faqs = [
  {
    q: 'Com quanta antecedência devo reservar?',
    a: 'Recomendamos pelo menos 15 dias antes da viagem. Em julho e agosto, alta temporada, as peças mais procuradas esgotam com semanas de antecedência. A reserva garante o item nas suas datas.',
  },
  {
    q: 'Onde retiro e devolvo as peças?',
    a: 'Numa loja física no Chile — sem frete, sem alfândega, sem risco de extravio. Você retira ao chegar e devolve na mesma loja antes de embarcar de volta.',
  },
  {
    q: 'Preciso lavar antes de devolver?',
    a: 'Não. A higienização é por nossa conta e já está no valor da locação.',
  },
  {
    q: 'E se eu errar o tamanho?',
    a: 'Sem problema — você prova na hora da retirada. Se não servir, trocamos na própria loja, na hora, conforme a disponibilidade.',
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
    q: 'As peças são higienizadas entre um cliente e outro?',
    a: 'Sempre. Toda peça passa por higienização profissional e inspeção antes de sair para o próximo cliente.',
  },
  {
    q: 'Posso estender o período do aluguel?',
    a: 'Sim, desde que a peça não esteja reservada para outro cliente na sequência. Avise a loja antes do fim do período combinado.',
  },
  {
    q: 'Em que moeda eu pago?',
    a: 'Em reais (BRL). Mesmo a retirada sendo no Chile, o checkout é todo em real — sem conversão, sem surpresa na fatura do cartão.',
  },
  {
    q: 'Quais as formas de pagamento?',
    a: 'Cartão de crédito, Pix e boleto. O processamento é feito por gateway certificado — não armazenamos dados do seu cartão.',
  },
  {
    q: 'Posso cancelar a reserva?',
    a: 'Com mais de 7 dias de antecedência da data de retirada, reembolso integral. Entre 7 e 2 dias, reembolso parcial. Com menos de 48h, não há reembolso, pois a peça já foi separada e ficou indisponível para outros clientes.',
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
