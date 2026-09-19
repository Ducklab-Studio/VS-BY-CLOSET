import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Como funciona',
  description:
    'Reserve online no Brasil, retire e devolva suas peças numa loja física no Chile — sem frete, sem alfândega, sem risco de extravio.',
};

const passos = [
  {
    titulo: 'Escolha o período',
    texto:
      'Informe a data de retirada e de devolução — os dias da sua viagem. O calendário mostra o que está disponível e calcula o preço do período em tempo real.',
  },
  {
    titulo: 'Monte o look',
    texto:
      'Macacão, jaqueta, calça, botas, luvas e óculos. Monte o conjunto completo ou alugue só o que está faltando.',
  },
  {
    titulo: 'Confirme a reserva',
    texto:
      'Finalize com pagamento seguro em reais — cartão, Pix ou boleto. Você recebe a confirmação por e-mail.',
  },
  {
    titulo: 'Retire na loja, no Chile',
    texto:
      'Chegou ao Chile, vai até a loja com o e-mail de confirmação. As peças já estão separadas no seu tamanho — prova, ajusta e já sai usando.',
  },
  {
    titulo: 'Devolva antes de embarcar',
    texto:
      'Na mesma loja, antes do voo de volta. A higienização é por nossa conta — você não precisa lavar nada.',
  },
];

export default function ComoFuncionaPage() {
  return (
    <div className="how-editorial">
      <header className="guide-heading">
        <p className="privacy-eyebrow">Como funciona</p><h1>Você escolhe o look.<br /><em>A gente cuida do closet.</em></h1>
        <p className="mt-2 text-sm text-ink/60">
          Reserva em cinco passos — sem frete, sem alfândega, sem comprar peça que
          você usaria uma semana por ano.
        </p>
      </header>

      <ol className="how-steps">
        {passos.map((passo, i) => (
          <li key={passo.titulo} className="how-step">
            <span className="font-heading shrink-0 text-3xl text-ink/20">
              {String(i + 1).padStart(2, '0')}
            </span>
            <div>
              <h2 className="font-heading text-base tracking-widest text-ink">{passo.titulo}</h2>
              <p className="mt-2 leading-relaxed text-ink/60">{passo.texto}</p>
            </div>
          </li>
        ))}
      </ol>

      {/* ── Por que alugar ──────────────────────────────────────────────── */}
      <section className="how-benefits">
        <h2 className="font-heading text-lg text-ink">Por que alugar faz mais sentido</h2>
        <div className="mt-6 grid gap-8 sm:grid-cols-2">
          <div>
            <h3 className="font-heading text-sm tracking-widest text-ink/80">Custo</h3>
            <ul className="mt-3 space-y-2 text-sm text-ink/60">
              <li>· Um macacão bom custa mais que a viagem inteira de aluguel</li>
              <li>· Você usa uma semana por ano, no máximo duas</li>
              <li>· Sem custo de manutenção e impermeabilização</li>
            </ul>
          </div>
          <div>
            <h3 className="font-heading text-sm tracking-widest text-ink/80">Praticidade</h3>
            <ul className="mt-3 space-y-2 text-sm text-ink/60">
              <li>· Nada ocupando armário o ano inteiro</li>
              <li>· Criança cresce e o tamanho acompanha</li>
              <li>· Sem risco de extravio — a peça nunca sai do Chile</li>
            </ul>
          </div>
        </div>
      </section>

      {/* ── CTA ─────────────────────────────────────────────────────────── */}
      <section className="guide-cta">
        <h2 className="font-heading text-xl text-ink">Quando é sua viagem?</h2>
        <Link href="/pecas" className="editorial-button">
          Ver as peças <ArrowUpRight size={18} />
        </Link>
      </section>
    </div>
  );
}

