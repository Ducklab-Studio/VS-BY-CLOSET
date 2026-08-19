import type { Metadata } from 'next';
import { isStoreUrlConfigured, storeUrl } from '@/lib/shopify';

export const metadata: Metadata = {
  title: 'Como funciona',
  description:
    'Reserve online no Brasil, retire e devolva a roupa de neve numa loja física no Chile — sem frete, sem alfândega, sem risco de extravio.',
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
      'Chegou ao Chile, vai até a loja com o e-mail de confirmação. As peças já estão separadas no seu tamanho — prova, ajusta, sai vestido pra neve.',
  },
  {
    titulo: 'Devolva antes de embarcar',
    texto:
      'Na mesma loja, antes do voo de volta. A higienização é por nossa conta — você não precisa lavar nada.',
  },
];

export default function ComoFuncionaPage() {
  return (
    <div className="mx-auto max-w-4xl px-4 py-12">
      <header className="border-b border-ink/10 pb-8">
        <h1 className="font-heading text-3xl text-ink">Como funciona</h1>
        <p className="mt-2 text-sm text-ink/60">
          Aluguel de roupa de neve em cinco passos — sem frete, sem alfândega, sem comprar peça que
          você usaria uma semana por ano.
        </p>
      </header>

      <ol className="mt-12 space-y-10">
        {passos.map((passo, i) => (
          <li key={passo.titulo} className="flex gap-6">
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
      <section className="mt-16 rounded-2xl border border-ink/10 bg-sand/40 p-8">
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
      {isStoreUrlConfigured && (
        <section className="mt-12 text-center">
          <h2 className="font-heading text-xl text-ink">Quando é sua viagem?</h2>
          <a
            href={storeUrl('/collections/all')}
            className="mt-8 inline-flex rounded-full border border-marsala px-6 py-3 text-xs uppercase tracking-widest text-marsala transition hover:bg-marsala hover:text-cream"
          >
            Ver a coleção
          </a>
        </section>
      )}
    </div>
  );
}
