import Link from 'next/link';
import Image from 'next/image';
import { ArrowDown, ArrowUpRight } from 'lucide-react';
import { FeaturedProducts } from '@/components/FeaturedProducts';
import { EditorialMotion } from '@/components/EditorialMotion';
import { WinterCarousel } from '@/components/WinterCarousel';
import { ValePassHomeCallout } from '@/components/ValePassHomeCallout';
import { HeroMedia } from '@/components/HeroMedia';
import { HERO_VIDEO } from '@/lib/hero-media';

export default function HomePage() {
  return (
    <EditorialMotion>
      <section className="editorial-hero">
        <div className="hero-copy">
          <p data-intro className="eyebrow">
            VS by Closet · Chile
          </p>
          <h1 data-intro>
            Seu closet em todas as <em>estações.</em>
          </h1>
          <p data-intro className="hero-description">
            Alugue looks que traduzem seu estilo e viva Santiago com uma mala mais leve.
            <br />
            Do passeio na cidade ao brinde na vinícola, encontre o look para cada momento.
          </p>
          <Link data-intro href="/pecas" className="editorial-button">
            Explore os looks <ArrowUpRight size={19} />
          </Link>
          <p data-intro className="hero-note">
            Reserve online. Retire em Santiago.
          </p>
        </div>
        <div className="hero-photo">
          {/* Vídeo do hero: ver `HERO_VIDEO` em lib/hero-media.ts (hoje null = só a imagem) e docs/HERO-VIDEO.md. */}
          <HeroMedia
            image={{ src: '/editorial/winter-campaign.webp', alt: 'Editorial de inverno: look claro em uma paisagem de montanhas nevadas' }}
            video={HERO_VIDEO}
          />
          <div className="photo-caption">
            <span>THE ALL-SEASON EDIT</span>
            <span>Estilo em qualquer altitude.</span>
          </div>
          <span className="photo-credit">Imagem editorial ilustrativa</span>
        </div>
        <a className="scroll-cue" href="#colecao">
          <ArrowDown size={16} /> Descubra o closet de toda estação
        </a>
      </section>
      <div className="editorial-strip">
        <div className="editorial-strip-track" aria-hidden="true">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="editorial-strip-content">
              <span>Menos bagagem.</span>
              <span className="strip-dot">✦</span>
              <span>Mais histórias.</span>
              <span className="strip-dot">✦</span>
              <span>Seu closet no Chile.</span>
              <span className="strip-dot">✦</span>
            </div>
          ))}
        </div>
      </div>
      <section className="brand-story" aria-labelledby="story-title">
        <div className="story-copy">
          <p className="eyebrow">Feito para viver lá fora</p>
          <h2 id="story-title">
            Leve a viagem.
            <br />
            <em>
              Deixe o closet
              <br />
              com a gente.
            </em>
          </h2>
          <p>
            De dia quente a noite fria — Santiago muda em poucas horas, em qualquer época do ano.
            Encontre as peças que combinam com você e reserve para as datas da sua viagem.
          </p>
          <Link href="/como-funciona" className="editorial-link">
            Descubra como funciona <ArrowUpRight size={18} />
          </Link>
        </div>
        <div className="story-mark">
          <span className="mark-orbit" aria-hidden="true" />
          <Image
            src="/brand/logo-mark.svg"
            alt="VS by Closet"
            width={335}
            height={380}
            unoptimized
            className="story-mark-logo"
          />
          <span className="mark-caption">VS BY CLOSET / SEU CLOSET EM TODAS AS ESTAÇÕES</span>
        </div>
      </section>
      <section id="colecao" className="collection-section">
        <div className="collection-heading" data-reveal>
          <div>
            <p className="eyebrow">EXPLORE O CLOSET</p>
            <h2>
              Seu próximo look favorito
              <br />
              <em>está aqui.</em>
            </h2>
            <p className="collection-description">
              Escolha suas peças e reserve para as datas da sua viagem.
            </p>
          </div>
          <Link href="/pecas" className="editorial-link">
            Ver todo o closet <ArrowUpRight size={18} />
          </Link>
        </div>
        <FeaturedProducts />
      </section>
      <ValePassHomeCallout />
      <section className="winter-story" aria-labelledby="winter-title">
        <div className="winter-content">
          <div className="winter-header-block">
            <p className="eyebrow">ALUGUEL VS BY CLOSET · SANTIAGO</p>
            <h2 id="winter-title">
              Por que comprar para uma viagem,
              <br />
              <em>se você pode ter um closet à disposição?</em>
            </h2>
          </div>

          <div className="winter-body-block">
            <p className="winter-description">
              Use os looks que deseja, sem precisar comprar. Ter seu closet em Santiago é mais simples do que você imagina: peças selecionadas para cada ocasião do seu roteiro.
            </p>

            <div className="winter-features">
              <div className="winter-feature-item">
                <span className="winter-feature-badge">01</span>
                <div>
                  <strong>Mala sem excesso</strong>
                  <p>Viaje leve sem pagar taxa de bagagem nem carregar sobretudos pesados.</p>
                </div>
              </div>
              <div className="winter-feature-item">
                <span className="winter-feature-badge">02</span>
                <div>
                  <strong>Retirada flexível</strong>
                  <p>Retire no nosso espaço em Santiago ou solicite entrega no seu hotel.</p>
                </div>
              </div>
              <div className="winter-feature-item">
                <span className="winter-feature-badge">03</span>
                <div>
                  <strong>Peças impecáveis</strong>
                  <p>Higienização profissional a vapor, prontas para vestir e fotografar.</p>
                </div>
              </div>
            </div>

            <div className="winter-cta-row">
              <Link href="/como-funciona" className="editorial-button light">
                Descubra como funciona o aluguel <ArrowUpRight size={18} />
              </Link>
              <span className="winter-guarantee">
                ✦ Reserva antecipada online · Suporte em Santiago
              </span>
            </div>
          </div>
        </div>

        <WinterCarousel />
      </section>
      <section className="rental-steps" aria-label="Como alugar">
        <div data-reveal>
          <span>01 / ESCOLHA</span>
          <h3>Seu estilo, sua seleção.</h3>
          <p>Explore o closet e encontre suas peças favoritas.</p>
        </div>
        <div data-reveal>
          <span>02 / RESERVE</span>
          <h3>A data da sua viagem.</h3>
          <p>Confira a disponibilidade para os dias da sua viagem.</p>
        </div>
        <div data-reveal>
          <span>03 / VIVA</span>
          <h3>O Chile espera por você.</h3>
          <p>Retire suas peças ao chegar e aproveite cada momento.</p>
        </div>
      </section>
    </EditorialMotion>
  );
}
