import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowUpRight, Plus } from 'lucide-react';

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
  return <div className="faq-editorial">
    <header className="guide-heading"><p className="privacy-eyebrow">Antes de fazer as malas</p><h1>Menos dúvidas.<br /><em>Mais viagem.</em></h1><p>Tudo sobre escolher, reservar e aproveitar suas peças no Chile.</p></header>
    <div className="faq-layout"><aside className="faq-aside"><span className="faq-label">PERGUNTAS FREQUENTES</span><h2>Vamos deixar<br />tudo claro.</h2><p>Do primeiro look à devolução, encontre aqui os detalhes da sua locação.</p><Link href="/contato" className="editorial-link">Precisa de ajuda? <ArrowUpRight size={18} /></Link></aside>
    <div className="faq-questions">{faqs.map((faq, index) => <details key={faq.q} name="closet-faq"><summary><span className="faq-number">{String(index + 1).padStart(2, '0')}</span><span>{faq.q}</span><Plus size={20} strokeWidth={1.4} /></summary><p>{faq.a}</p></details>)}</div></div>
    <div className="guide-cta"><div><p className="privacy-eyebrow">Tudo pronto?</p><h2>Encontre o seu próximo look.</h2></div><Link href="/pecas" className="editorial-button">Explore o closet <ArrowUpRight size={18} /></Link></div>
  </div>;
}
