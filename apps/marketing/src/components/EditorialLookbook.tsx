import Link from 'next/link';
import Image from 'next/image';
import { ArrowUpRight } from 'lucide-react';

/**
 * Lookbook editorial da home: quatro fotografias da campanha em composição assimétrica (desktop) e em ritmo alternado (celular).
 *
 * - Todas as fotos são retratos 4:5 (1600×2000): `width`/`height` + `aspect-ratio` no quadro eliminam o layout shift e nenhum recorte é aplicado (sem `object-fit: cover`
 *   forçando outra proporção), então rosto e peça aparecem inteiros.
 * - Estão abaixo da primeira dobra: carregamento preguiçoso (padrão do `next/image`), sem `priority`.
 * - A revelação usa `data-reveal` (GSAP, já respeitando `prefers-reduced-motion` em `EditorialMotion`); o zoom suave ao passar o mouse é só CSS e também respeita a preferência.
 */
const LOOKS = [
  {
    id: 'noite',
    src: '/editorial/lookbook-01-noite.webp',
    alt: 'Mulher de casaco trench em tweed bege, com cinto, apoiada em uma varanda ao entardecer, com montanhas e luzes acesas ao fundo',
    caption: 'Entardecer nas montanhas',
    sizes: '(min-width: 1360px) 430px, (min-width: 901px) 32vw, 78vw',
  },
  {
    id: 'vinicola',
    src: '/editorial/lookbook-02-vinicola.webp',
    alt: 'Mulher de casaco longo off-white com cinto caminhando entre videiras, em frente a uma vinícola de montanha',
    caption: 'Brinde na vinícola',
    sizes: '(min-width: 1360px) 740px, (min-width: 901px) 54vw, 100vw',
  },
  {
    id: 'jardim',
    src: '/editorial/lookbook-03-jardim.webp',
    alt: 'Mulher de trench coat preto de botões duplos e botas pretas em um caminho de jardim, entre arbustos floridos',
    caption: 'Passeio no jardim',
    sizes: '(min-width: 1360px) 430px, (min-width: 901px) 32vw, 78vw',
  },
  {
    id: 'varanda',
    src: '/editorial/lookbook-04-varanda.webp',
    alt: 'Mulher de casaco preto com gola e punhos de pelo, segurando uma taça de vinho em uma varanda com vista para as montanhas',
    caption: 'Taça na varanda',
    sizes: '(min-width: 1360px) 560px, (min-width: 901px) 40vw, 100vw',
  },
] as const;

function LookFigure({ look, index, className }: { look: (typeof LOOKS)[number]; index: number; className: string }) {
  return (
    <figure data-reveal className={`lookbook-figure ${className}`}>
      <div className="lookbook-frame">
        <Image src={look.src} alt={look.alt} width={1600} height={2000} sizes={look.sizes} className="lookbook-photo" />
      </div>
      <figcaption>
        <span className="lookbook-number">{String(index + 1).padStart(2, '0')}</span>
        <span>{look.caption}</span>
      </figcaption>
    </figure>
  );
}

export function EditorialLookbook() {
  const [noite, vinicola, jardim, varanda] = LOOKS;
  return (
    <section className="lookbook" aria-labelledby="lookbook-title">
      <div className="lookbook-grid">
        <div className="lookbook-left">
          <div className="lookbook-intro" data-reveal>
            <p className="eyebrow">Lookbook · Chile</p>
            <h2 id="lookbook-title">
              Do passeio ao brinde,
              <br />
              <em>um look para cada cenário.</em>
            </h2>
            <p className="lookbook-lead">
              Casacos e looks de inverno vividos em cenários reais do Chile: a vinícola, o jardim e a varanda ao entardecer.
            </p>
            <Link href="/pecas" className="editorial-link">
              Explore os looks <ArrowUpRight size={18} />
            </Link>
          </div>
          <LookFigure look={noite} index={0} className="lookbook-b" />
        </div>
        <LookFigure look={vinicola} index={1} className="lookbook-a" />
        <LookFigure look={jardim} index={2} className="lookbook-c" />
        <LookFigure look={varanda} index={3} className="lookbook-d" />
      </div>
    </section>
  );
}
