import type { Metadata } from 'next';
import Link from 'next/link';
import { BooqableEmbed } from '@/components/booqable/BooqableEmbed';

export const metadata: Metadata = {
  title: 'Como funciona',
  description:
    'Entenda como alugar roupa de neve: escolha as datas, receba em casa, use na viagem e devolva sem lavar.',
};

const passos = [
  {
    titulo: 'Escolha o período',
    texto:
      'Informe a data de ida e de volta da viagem. O catálogo passa a mostrar apenas o que está disponível nesse intervalo, com o preço já calculado para o período.',
  },
  {
    titulo: 'Monte o look',
    texto:
      'Macacão, jaqueta, calça, botas, luvas e óculos. Monte o conjunto completo ou alugue só o que está faltando.',
  },
  {
    titulo: 'Confirme a reserva',
    texto:
      'Finalize o pedido com pagamento seguro. Você recebe a confirmação por e-mail com todos os detalhes e o prazo de envio.',
  },
  {
    titulo: 'Receba antes da viagem',
    texto:
      'Enviamos para todo o Brasil com folga em relação à data de ida. Tudo higienizado, revisado e pronto para usar.',
  },
  {
    titulo: 'Devolva sem lavar',
    texto:
      'Na volta, use a etiqueta de devolução e poste. A higienização é por nossa conta — você não precisa lavar nada.',
  },
];

export default function ComoFuncionaPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-12">
      <header className="border-b border-white/10 pb-8">
        <h1 className="font-heading text-3xl">Como funciona</h1>
        <p className="mt-2 text-sm text-white/50">
          Alugar roupa de neve em cinco passos — sem comprar peça que você usaria uma semana por ano.
        </p>
      </header>

      <ol className="mt-12 space-y-10">
        {passos.map((passo, i) => (
          <li key={passo.titulo} className="flex gap-6">
            <span className="font-heading shrink-0 text-3xl text-white/20">
              {String(i + 1).padStart(2, '0')}
            </span>
            <div>
              <h2 className="font-heading text-base tracking-widest">{passo.titulo}</h2>
              <p className="mt-2 leading-relaxed text-white/60">{passo.texto}</p>
            </div>
          </li>
        ))}
      </ol>

      {/* ── Por que alugar ──────────────────────────────────────────────── */}
      <section className="mt-16 rounded-2xl border border-white/10 bg-dusk p-8">
        <h2 className="font-heading text-lg">Por que alugar faz mais sentido</h2>
        <div className="mt-6 grid gap-8 sm:grid-cols-2">
          <div>
            <h3 className="font-heading text-sm tracking-widest text-white/80">Custo</h3>
            <ul className="mt-3 space-y-2 text-sm text-white/55">
              <li>· Um macacão bom custa mais que a viagem inteira de aluguel</li>
              <li>· Você usa uma semana por ano, no máximo duas</li>
              <li>· Sem custo de manutenção e impermeabilização</li>
            </ul>
          </div>
          <div>
            <h3 className="font-heading text-sm tracking-widest text-white/80">Praticidade</h3>
            <ul className="mt-3 space-y-2 text-sm text-white/55">
              <li>· Nada ocupando armário o ano inteiro</li>
              <li>· Criança cresce e o tamanho acompanha</li>
              <li>· Peça sempre atual, sem desgaste de temporadas antigas</li>
            </ul>
          </div>
        </div>
      </section>

      {/* ── CTA ─────────────────────────────────────────────────────────── */}
      <section className="mt-12 text-center">
        <h2 className="font-heading text-xl">Quando é sua viagem?</h2>
        <div className="mx-auto mt-6 max-w-xl">
          <BooqableEmbed component="datepicker" />
        </div>
        <Link href="/catalogo" className="btn-pill btn-pill-solid mt-8 inline-flex">
          Ver a coleção
        </Link>
      </section>
    </div>
  );
}
