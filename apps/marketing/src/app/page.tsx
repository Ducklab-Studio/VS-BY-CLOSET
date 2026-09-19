import Link from 'next/link';
import Image from 'next/image';
import { ArrowDown, ArrowUpRight } from 'lucide-react';
import { FeaturedProducts } from '@/components/FeaturedProducts';
import { EditorialMotion } from '@/components/EditorialMotion';
import { Hero3D } from '@/components/Hero3D';

export default function HomePage() {
  return (
    <EditorialMotion>
      <section className="editorial-hero">
        <div className="hero-copy">
          <p data-intro className="eyebrow">VS by Closet · Chile</p>
          <h1 data-intro>Seu closet.<br />Em toda <em>estação.</em></h1>
          <p data-intro className="hero-description">Santiago esquenta de dia e esfria à noite.<br />Um closet pronto pra qualquer estação.</p>
          <Link data-intro href="/pecas" className="editorial-button">Explore as peças <ArrowUpRight size={19} /></Link>
          <p data-intro className="hero-note">Alugue online. Retire ao chegar no Chile.</p>
        </div>
        <div className="hero-photo">
          {/* TODO(campanha "todas as estações"): trocar por foto/vídeo novo do drive — imagem de destaque da home */}
          {/*
            Ponto de entrada do futuro vídeo do hero: quando o arquivo
            estiver disponível, troque a <Image> abaixo por um <video
            autoPlay muted loop playsInline poster="/editorial/winter-campaign.webp"
            className="campaign-image"><source src="/editorial/hero.mp4" type="video/mp4" /></video>.
            A classe "campaign-image" já resolve object-fit/position — não
            mexe em mais nada. Nenhuma mídia nova foi baixada ou trocada
            agora; a imagem atual continua sendo usada até lá.
          */}
          <Image src="/editorial/winter-campaign.webp" alt="Editorial de inverno: look claro em uma paisagem de montanhas nevadas" fill priority sizes="(max-width: 760px) 100vw, 58vw" className="campaign-image" />
          <div className="photo-caption"><span>THE ALL-SEASON EDIT</span><span>Estilo em qualquer altitude.</span></div>
          <span className="photo-credit">Imagem editorial ilustrativa</span>
        </div>
        <a className="scroll-cue" href="#colecao"><ArrowDown size={16} /> Descubra o closet de toda estação</a>
      </section>
      <div className="editorial-strip"><span>Menos bagagem.</span><span aria-hidden="true">✳</span><span>Mais histórias.</span><span aria-hidden="true">✳</span><span>Seu closet no Chile.</span></div>
      <section className="brand-story" aria-labelledby="story-title">
        <div className="story-copy"><p className="eyebrow">Feito para viver lá fora</p><h2 id="story-title">Leve a viagem.<br /><em>Deixe o closet<br />com a gente.</em></h2><p>De dia quente a noite fria — Santiago muda em poucas horas, em qualquer época do ano. Encontre as peças que combinam com você e reserve para as datas da sua viagem.</p><Link href="/como-funciona" className="editorial-link">Descubra como funciona <ArrowUpRight size={18} /></Link></div>
        <div className="story-mark"><span className="mark-orbit" aria-hidden="true" /><Hero3D /><span className="mark-caption">VS BY CLOSET / SEU CLOSET EM TODAS AS ESTAÇÕES</span></div>
      </section>
      <section id="colecao" className="collection-section">
        <div className="collection-heading" data-reveal><div><p className="eyebrow">A seleção do closet</p><h2>Prontas para a sua<br /><em>próxima história.</em></h2></div><Link href="/pecas" className="editorial-link">Ver todas as peças <ArrowUpRight size={18} /></Link></div>
        <FeaturedProducts />
      </section>
      <section className="winter-story" aria-labelledby="winter-title">
        {/* TODO(campanha "todas as estações"): trocar por foto/vídeo novo do drive — imagem de destaque desta seção */}
        <div className="winter-image"><Image src="/editorial/winter-campaign.webp" alt="Montanhas cobertas de neve em um editorial de inverno" fill sizes="100vw" className="campaign-image" /></div>
        <div className="winter-content"><p className="eyebrow">A sua próxima parada</p><h2 id="winter-title">Frio à noite.<br /><em>Estilo o ano inteiro.</em></h2><Link href="/pecas" className="editorial-button light">Encontre seu look <ArrowUpRight size={18} /></Link></div>
      </section>
      <section className="rental-steps" aria-label="Como alugar"><div data-reveal><span>01 / ESCOLHA</span><h3>Seu estilo, sua seleção.</h3><p>Explore o closet e encontre suas peças favoritas.</p></div><div data-reveal><span>02 / RESERVE</span><h3>A data da sua viagem.</h3><p>Confira a disponibilidade para os dias da sua viagem.</p></div><div data-reveal><span>03 / VIVA</span><h3>O Chile espera por você.</h3><p>Retire suas peças ao chegar e aproveite cada momento.</p></div></section>
    </EditorialMotion>
  );
}
