"use client";

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pause, Play } from 'lucide-react';

export interface EditorialLook {
  id: string;
  file: string;
  title: string;
  subtitle: string;
  tag: string;
  location: string;
  alt: string;
}

const LOOKS: readonly EditorialLook[] = [
  {
    id: 'vinicola',
    file: 'lookbook-02-vinicola.webp',
    title: 'Brinde na Vinícola',
    subtitle: 'Casaco longo off-white com cinto estruturado',
    tag: 'Look 01',
    location: 'Valle de Casablanca',
    alt: 'Mulher de casaco longo off-white com cinto caminhando entre videiras, em frente a uma vinícola de montanha',
  },
  {
    id: 'noite',
    file: 'lookbook-01-noite.webp',
    title: 'Entardecer nas Montanhas',
    subtitle: 'Trench coat estruturado em tweed bege',
    tag: 'Look 02',
    location: 'Cordilheira dos Andes',
    alt: 'Mulher de casaco trench em tweed bege apoiada em uma varanda ao entardecer, com montanhas e luzes acesas ao fundo',
  },
  {
    id: 'jardim',
    file: 'lookbook-03-jardim.webp',
    title: 'Passeio no Jardim',
    subtitle: 'Trench coat preto com botões duplos clássicos',
    tag: 'Look 03',
    location: 'Parque Bicentenário',
    alt: 'Mulher de trench coat preto de botões duplos e botas pretas em um caminho de jardim, entre arbustos floridos',
  },
  {
    id: 'varanda',
    file: 'lookbook-04-varanda.webp',
    title: 'Taça na Varanda',
    subtitle: 'Sobretudo preto com gola volumosa e punhos em pelo',
    tag: 'Look 04',
    location: 'Santiago Centro',
    alt: 'Mulher de casaco preto com gola e punhos de pelo segurando uma taça de vinho em uma varanda com vista para as montanhas',
  },
] as const;

export function WinterCarousel() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isVisible, setIsVisible] = useState(true);
  const [isTabVisible, setIsTabVisible] = useState(true);
  const [isReducedMotion, setIsReducedMotion] = useState(false);
  const [animKey, setAnimKey] = useState(0);

  const stageRef = useRef<HTMLDivElement>(null);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);

  // Navega para o próximo slide
  const next = useCallback(() => {
    setActiveIndex((current) => (current + 1) % LOOKS.length);
    setAnimKey((k) => k + 1);
  }, []);

  // Navega para o slide anterior
  const prev = useCallback(() => {
    setActiveIndex((current) => (current - 1 + LOOKS.length) % LOOKS.length);
    setAnimKey((k) => k + 1);
  }, []);

  // Seleciona um slide específico
  const goTo = useCallback((index: number) => {
    setActiveIndex(index);
    setAnimKey((k) => k + 1);
  }, []);

  // Alterna play/pause manual
  const togglePlayPause = useCallback(() => {
    setIsPaused((p) => !p);
  }, []);

  // Trata término da animação da barra de progresso (avanço automático)
  const handleAnimationEnd = useCallback(() => {
    if (!isPaused && !isHovered && isVisible && isTabVisible && !isReducedMotion) {
      next();
    }
  }, [isPaused, isHovered, isVisible, isTabVisible, isReducedMotion, next]);

  // Teclado: setas esquerda/direita e barra de espaço
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prev();
      } else if (e.key === ' ') {
        e.preventDefault();
        togglePlayPause();
      }
    },
    [next, prev, togglePlayPause]
  );

  // Gestos de toque (swipe) no mobile
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const deltaX = e.changedTouches[0].clientX - touchStartX.current;
    const deltaY = e.changedTouches[0].clientY - touchStartY.current;

    // Apenas dispara se for um swipe horizontal intencional
    if (Math.abs(deltaX) > 40 && Math.abs(deltaX) > Math.abs(deltaY)) {
      if (deltaX < 0) {
        next();
      } else {
        prev();
      }
    }
    touchStartX.current = null;
    touchStartY.current = null;
  };

  // Pré-carrega todas as 4 fotos para transições instantâneas sem flash
  useEffect(() => {
    LOOKS.forEach((look) => {
      const img = new window.Image();
      img.src = `/editorial/${look.file}`;
    });
  }, []);

  // Prefers-reduced-motion
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setIsReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsReducedMotion(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Visibilidade da aba (pausa quando minimizada para não gastar CPU)
  useEffect(() => {
    const handler = () => setIsTabVisible(!document.hidden);
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, []);

  // IntersectionObserver: pausa quando fora do viewport
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsVisible(entry.isIntersecting);
      },
      { threshold: 0.25 }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const currentLook = LOOKS[activeIndex];
  const isAnimationSuspended = isPaused || isHovered || !isVisible || !isTabVisible || isReducedMotion;

  return (
    <div className="winter-carousel-wrapper">
      <div
        ref={stageRef}
        className="winter-carousel-stage"
        role="region"
        aria-roledescription="carrossel"
        aria-label="Lookbook Editorial VS BY CLOSET"
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Slides com as 4 fotos 1600x2000 (aspect ratio exato 4:5) */}
        <div className="winter-carousel-track">
          {LOOKS.map((look, index) => {
            const isActive = index === activeIndex;
            return (
              <div
                key={look.id}
                className={`winter-carousel-slide ${isActive ? 'is-active' : ''}`}
                aria-hidden={!isActive}
              >
                <Image
                  src={`/editorial/${look.file}`}
                  alt={look.alt}
                  fill
                  priority={index === 0}
                  sizes="(max-width: 900px) 94vw, (max-width: 1280px) 48vw, 560px"
                  className="winter-carousel-img"
                />
              </div>
            );
          })}
        </div>

        {/* Gradientes sutis para garantir contraste 100% legível com as fotos */}
        <div className="winter-carousel-scrim-top" aria-hidden="true" />
        <div className="winter-carousel-scrim-bottom" aria-hidden="true" />

        {/* Barra Superior: Tag Editorial do Look + Botão Play/Pausa */}
        <div className="winter-carousel-top-bar">
          <div className="winter-carousel-pill">
            <span className="winter-carousel-spark" aria-hidden="true">✦</span>
            <span>{currentLook.tag} · {currentLook.location}</span>
          </div>

          <button
            type="button"
            onClick={togglePlayPause}
            className="winter-carousel-play-btn"
            aria-label={isPaused ? 'Iniciar rotação automática' : 'Pausar rotação automática'}
            title={isPaused ? 'Iniciar rotação automática' : 'Pausar rotação automática'}
          >
            {isPaused ? <Play size={13} fill="currentColor" /> : <Pause size={13} fill="currentColor" />}
            <span className="winter-play-text">{isPaused ? 'Play' : 'Pausa'}</span>
          </button>
        </div>

        {/* Setas de Navegação Minimalistas */}
        <button
          type="button"
          onClick={prev}
          className="winter-carousel-arrow prev"
          aria-label="Look anterior"
        >
          <ChevronLeft size={22} />
        </button>
        <button
          type="button"
          onClick={next}
          className="winter-carousel-arrow next"
          aria-label="Próximo look"
        >
          <ChevronRight size={22} />
        </button>

        {/* Painel Inferior: Legenda do Look + Barras de Progresso Interativas */}
        <div className="winter-carousel-bottom-panel">
          <div className="winter-carousel-caption">
            <div className="caption-meta">
              <span className="caption-number">
                {String(activeIndex + 1).padStart(2, '0')}
                <span className="caption-slash">/</span>
                {String(LOOKS.length).padStart(2, '0')}
              </span>
              <span className="caption-dot">·</span>
              <span className="caption-brand">Santiago Edit</span>
            </div>
            <h3 className="caption-title">{currentLook.title}</h3>
            <p className="caption-subtitle">{currentLook.subtitle}</p>
          </div>

          {/* Barras de Progresso estilo Stories/Editorial */}
          <div
            className="winter-carousel-progress"
            role="tablist"
            aria-label="Navegação dos looks da campanha"
          >
            {LOOKS.map((look, i) => {
              const isActive = i === activeIndex;
              const isViewed = i < activeIndex;

              return (
                <button
                  key={look.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-label={`Ver ${look.title}`}
                  className={`progress-segment ${isActive ? 'is-active' : ''} ${isViewed ? 'is-viewed' : ''}`}
                  onClick={() => goTo(i)}
                >
                  <span
                    key={isActive ? `fill-${i}-${animKey}` : `static-${i}`}
                    className={`progress-bar-fill ${isActive ? (isAnimationSuspended ? 'is-paused' : 'is-running') : ''}`}
                    onAnimationEnd={isActive ? handleAnimationEnd : undefined}
                  />
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
