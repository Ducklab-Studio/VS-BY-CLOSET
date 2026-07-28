import type { Metadata } from 'next';
import { LegalPage } from '@/components/layout/LegalPage';

export const metadata: Metadata = { title: 'Perguntas frequentes (FAQ)' };

const faqs = [
  {
    q: 'Qual o prazo de entrega?',
    a: 'O prazo varia conforme a região e é calculado no checkout a partir do seu CEP. Em média, de 3 a 10 dias úteis.',
  },
  {
    q: 'Como funciona a troca?',
    a: 'Você tem até 30 dias após o recebimento para solicitar troca ou devolução pela sua área do cliente.',
  },
  {
    q: 'Quais as formas de pagamento?',
    a: 'Aceitamos cartão de crédito (até 6x sem juros), PIX (com desconto) e boleto bancário.',
  },
  {
    q: 'O pagamento é seguro?',
    a: 'Sim. Utilizamos criptografia e gateways certificados (Mercado Pago e Stripe). Não armazenamos dados do cartão.',
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
