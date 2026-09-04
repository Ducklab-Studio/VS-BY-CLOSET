import Link from 'next/link';
import { Hero3D } from '@/components/Hero3D';
import { FeaturedProducts } from '@/components/FeaturedProducts';
import { HeroIntro } from '@/components/HeroIntro';
import { ScrollReveal } from '@/components/ScrollReveal';

/**
 * Home placeholder — estrutura pronta para receber a identidade visual.
 * Textos, cores e a cena 3D do Hero3D são o primeiro lugar a trocar quando
 * a marca definitiva chegar.
 */
export default function HomePage() {
  return (
    <>
      <HeroIntro>
        <section className="px-4 pt-16 text-center">
          <p data-hero-item className="text-xs uppercase tracking-[0.3em] text-ink/60">
            Aluguel de roupa de neve
          </p>
          <h1
            data-hero-item
            className="mt-5 font-heading text-4xl uppercase tracking-wide sm:text-6xl"
          >
            A neve não espera
            <br />
            seu guarda-roupa
          </h1>
          <p data-hero-item className="mx-auto mt-6 max-w-xl text-ink/60">
            Reserve online. Retire ao chegar no Chile.
          </p>

          {/* Sem guarda de configuração: o catálogo é rota interna agora,
              existe mesmo com a Shopify fora do ar (a página cuida do
              estado vazio). Esconder o CTA principal da home por causa de
              variável de ambiente era pior que mostrá-lo. */}
          <Link
            data-hero-item
            href="/pecas"
            className="mt-8 inline-flex rounded-full border border-marsala px-6 py-3 text-xs uppercase tracking-widest text-marsala transition hover:bg-marsala hover:text-cream"
          >
            Ver peças
          </Link>
        </section>
      </HeroIntro>

      <Hero3D />

      <section className="px-4 py-16">
        <ScrollReveal className="mx-auto max-w-6xl">
          <h2 className="text-center font-heading text-2xl uppercase tracking-wide">
            Mais alugados
          </h2>
          <div className="mt-10">
            <FeaturedProducts />
          </div>
        </ScrollReveal>
      </section>
    </>
  );
}
