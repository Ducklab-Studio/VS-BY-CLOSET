import Link from 'next/link';
import Image from 'next/image';
import { ArrowUpRight } from 'lucide-react';

/**
 * Lookbook editorial da home: abertura editorial e quatro retratos em uma grade assimétrica responsiva.
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
    sizes:
      '(min-width: 1600px) 650px, (min-width: 1101px) 39vw, (min-width: 701px) 48vw, calc(100vw - 32px)',
  },
  {
    id: 'vinicola',
    src: '/editorial/lookbook-02-vinicola.webp',
    alt: 'Mulher de casaco longo off-white com cinto caminhando entre videiras, em frente a uma vinícola de montanha',
    caption: 'Brinde na vinícola',
    sizes:
      '(min-width: 1600px) 900px, (min-width: 1101px) 55vw, (min-width: 701px) 48vw, calc(100vw - 32px)',
  },
  {
    id: 'jardim',
    src: '/editorial/lookbook-03-jardim.webp',
    alt: 'Mulher de trench coat preto de botões duplos e botas pretas em um caminho de jardim, entre arbustos floridos',
    caption: 'Passeio no jardim',
    sizes:
      '(min-width: 1600px) 650px, (min-width: 1101px) 39vw, (min-width: 701px) 48vw, calc(100vw - 32px)',
  },
  {
    id: 'varanda',
    src: '/editorial/lookbook-04-varanda.webp',
    alt: 'Mulher de casaco preto com gola e punhos de pelo, segurando uma taça de vinho em uma varanda com vista para as montanhas',
    caption: 'Taça na varanda',
    sizes:
      '(min-width: 1600px) 750px, (min-width: 1101px) 47vw, (min-width: 701px) 48vw, calc(100vw - 32px)',
  },
] as const;

function LookFigure({
  look,
  index,
  className,
}: {
  look: (typeof LOOKS)[number];
  index: number;
  className: string;
}) {
  return (
    <figure data-reveal className={`lookbook-figure ${className}`}>
      <div className="lookbook-frame">
        <Image
          src={look.src}
          alt={look.alt}
          width={1600}
          height={2000}
          sizes={look.sizes}
          className="lookbook-photo"
        />
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
      <div className="lookbook-inner">
        <header className="lookbook-intro" data-reveal>
          <div className="lookbook-heading">
            <p className="eyebrow">Lookbook · Chile</p>
            <h2 id="lookbook-title">
              Quatro cenas,
              <br />
              <em>um inverno inteiro.</em>
            </h2>
          </div>
          <div className="lookbook-intro-side">
            <p className="lookbook-lead">
              Do primeiro passeio à última taça, descubra o Chile em looks feitos para acompanhar
              cada momento.
            </p>
            <Link href="/pecas" className="editorial-link">
              Explore os looks <ArrowUpRight size={18} />
            </Link>
          </div>
          <span className="lookbook-edition">
            01 — 04 <span>·</span> Inverno no Chile
          </span>
        </header>
        <div className="lookbook-grid">
          <LookFigure look={noite} index={0} className="lookbook-a" />
          <LookFigure look={vinicola} index={1} className="lookbook-b" />
          <LookFigure look={jardim} index={2} className="lookbook-c" />
          <LookFigure look={varanda} index={3} className="lookbook-d" />
        </div>
      </div>
    </section>
  );
}
