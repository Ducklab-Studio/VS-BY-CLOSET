import { Hero3D } from '@/components/Hero3D';
import { FeaturedProducts } from '@/components/FeaturedProducts';

const SHOPIFY_STORE_URL = (process.env.NEXT_PUBLIC_SHOPIFY_STORE_URL ?? '').replace(/\/$/, '');

/**
 * Home placeholder — estrutura pronta para receber a identidade visual.
 * Textos, cores e a cena 3D do Hero3D são o primeiro lugar a trocar quando
 * a marca definitiva chegar.
 */
export default function HomePage() {
  return (
    <>
      <section className="px-4 pt-16 text-center">
        <p className="text-xs uppercase tracking-[0.3em] text-ink/60">Aluguel de roupa de neve</p>
        <h1 className="mt-5 font-heading text-4xl uppercase tracking-wide sm:text-6xl">
          A neve não espera
          <br />
          seu guarda-roupa
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-ink/60">
          Reserve online. Retire ao chegar no Chile.
        </p>

        {SHOPIFY_STORE_URL && (
          <a
            href={`${SHOPIFY_STORE_URL}/collections/all`}
            className="mt-8 inline-flex rounded-full border border-marsala px-6 py-3 text-xs uppercase tracking-widest text-marsala transition hover:bg-marsala hover:text-cream"
          >
            Ver coleção
          </a>
        )}
      </section>

      <Hero3D />

      <section className="px-4 py-16">
        <h2 className="text-center font-heading text-2xl uppercase tracking-wide">Mais alugados</h2>
        <div className="mx-auto mt-10 max-w-6xl">
          <FeaturedProducts />
        </div>
      </section>
    </>
  );
}
