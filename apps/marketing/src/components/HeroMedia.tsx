'use client';

import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties } from 'react';
import Image from 'next/image';
import { Pause, Play } from 'lucide-react';
import {
  HERO_MOBILE_QUERY,
  HERO_VIDEO_DEFAULT_STALL_MS,
  HERO_VIDEO_DEFAULT_TIMEOUT_MS,
  decideHeroVideo,
  heroControl,
  heroReducer,
  heroShouldRun,
  heroVideoMounted,
  heroVideoPosition,
  heroVideoSources,
  initialHeroState,
  type HeroVideo,
  type HeroVideoConditions,
} from '@/lib/hero-media';

interface HeroMediaProps {
  readonly image: { readonly src: string; readonly alt: string };
  /** `null` (padrão do projeto hoje) = só a imagem. */
  readonly video: HeroVideo | null;
}

interface NetworkInformationLike extends EventTarget {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
}

type VideoWithFrameCallback = HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };

function readConditions(): HeroVideoConditions {
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  return {
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    saveData: connection?.saveData === true,
    effectiveType: connection?.effectiveType ?? null,
  };
}

/**
 * Mídia do hero. A IMAGEM é sempre renderizada (prioridade, sem layout shift) e é o fallback/poster; o vídeo só cobre a imagem depois de ter um frame válido
 * (nunca há tela preta) e some de volta para a imagem se travar, falhar ou for recusado. Toda a lógica de estados está em `lib/hero-media.ts` (testada).
 *
 * - Só pede o vídeo depois que a imagem (LCP) terminou: não disputa banda com ela, sem atraso artificial.
 * - Autoplay automático só em condições boas; "reduzir movimento", economia de dados e conexão lenta ficam em modo manual (nada é baixado até a pessoa pedir).
 * - Se o navegador/sistema recusar o play() (NotAllowedError, inclusive Modo Pouca Energia do iOS), a imagem fica e aparece o botão "Reproduzir". Sem hacks.
 * - Pausa fora da tela e com a aba oculta; botão discreto para pausar/reproduzir.
 */
export function HeroMedia({ image, video }: HeroMediaProps) {
  const [state, dispatch] = useReducer(heroReducer, undefined, initialHeroState);
  const [isMobile, setIsMobile] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });
  const position = heroVideoPosition(video);
  const timeoutMs = video?.timeoutMs ?? HERO_VIDEO_DEFAULT_TIMEOUT_MS;
  const stallMs = video?.stallMs ?? HERO_VIDEO_DEFAULT_STALL_MS;

  // Decisão inicial + reação a mudanças de preferência (reduzir movimento, economia de dados, conexão) enquanto a página está aberta.
  useEffect(() => {
    dispatch({ type: 'INIT', decision: decideHeroVideo(video, readConditions()) });
    if (!video) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
    const onChange = () => dispatch({ type: 'PREF_CHANGE', decision: decideHeroVideo(video, readConditions()) });
    motion.addEventListener('change', onChange);
    connection?.addEventListener?.('change', onChange);
    return () => {
      motion.removeEventListener('change', onChange);
      connection?.removeEventListener?.('change', onChange);
    };
  }, [video]);

  // Conjunto de fontes: celular ou desktop (decidido aqui, não por `media` em <source>, que vídeo não respeita).
  useEffect(() => {
    const query = window.matchMedia(HERO_MOBILE_QUERY);
    setIsMobile(query.matches);
    const onChange = () => setIsMobile(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Espera a imagem do hero (LCP) terminar; sem atraso fixo.
  useEffect(() => {
    if (state.phase !== 'waiting-image') return;
    const img = imageRef.current;
    if (!img || (img.complete && img.naturalWidth > 0)) {
      dispatch({ type: 'IMAGE_READY' });
      return;
    }
    const ready = () => dispatch({ type: 'IMAGE_READY' });
    img.addEventListener('load', ready, { once: true });
    img.addEventListener('error', ready, { once: true });
    return () => {
      img.removeEventListener('load', ready);
      img.removeEventListener('error', ready);
    };
  }, [state.phase]);

  // Visibilidade da aba e do hero.
  useEffect(() => {
    if (!video) return;
    const onVisibility = () => dispatch({ type: 'TAB', visible: !document.hidden });
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [video]);

  useEffect(() => {
    const el = imageRef.current?.parentElement;
    if (!video || !el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => dispatch({ type: 'VIEW', inView: entry?.isIntersecting ?? true }), { threshold: 0.05 });
    observer.observe(el);
    return () => observer.disconnect();
  }, [video]);

  const run = heroShouldRun(state);
  const mounted = heroVideoMounted(state);

  // Liga/desliga a reprodução conforme o estado (play() com tratamento da Promise: a recusa vira estado `blocked`, não erro).
  useEffect(() => {
    const el = videoRef.current;
    if (!mounted || !el) return;
    if (run) {
      const promise = el.play();
      if (promise !== undefined) promise.catch((error: unknown) => dispatch({ type: 'PLAY_REJECTED', name: error instanceof DOMException ? error.name : 'Error' }));
    } else {
      el.pause();
    }
  }, [run, mounted]);

  // Timeout até o primeiro frame (só enquanto deveria estar tocando).
  useEffect(() => {
    if (state.phase !== 'loading' || !run) return;
    const timer = window.setTimeout(() => dispatch({ type: 'TIMEOUT' }), timeoutMs);
    return () => window.clearTimeout(timer);
  }, [state.phase, run, timeoutMs]);

  // Buffer/stall: se travar além do limite, volta à imagem; se recuperar, o vídeo volta (evento "playing").
  const stallTimer = useRef<number | undefined>(undefined);
  const clearStall = useCallback(() => {
    if (stallTimer.current !== undefined) window.clearTimeout(stallTimer.current);
    stallTimer.current = undefined;
  }, []);
  useEffect(() => clearStall, [clearStall]);

  // Ao sair do ar (erro/timeout/preferência), solta o download em andamento.
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    const previous = videoRef.current;
    if (!el && previous) {
      previous.pause();
      previous.removeAttribute('src');
      while (previous.firstChild) previous.removeChild(previous.firstChild);
      previous.load();
    }
    videoRef.current = el;
    if (el) {
      // Atributos que o iOS/Safari exige ANTES do play(): mudo e inline (a propriedade sozinha nem sempre vira atributo).
      el.defaultMuted = true;
      el.muted = true;
      el.setAttribute('muted', '');
      el.setAttribute('playsinline', '');
      el.setAttribute('webkit-playsinline', '');
    }
  }, []);

  const onPlaying = (el: HTMLVideoElement) => {
    clearStall();
    const target = el as VideoWithFrameCallback;
    // Só mostra o vídeo quando há um frame realmente apresentado (nunca tela preta).
    if (typeof target.requestVideoFrameCallback === 'function') target.requestVideoFrameCallback(() => dispatch({ type: 'FRAME' }));
    else if (el.readyState >= 2) dispatch({ type: 'FRAME' });
  };

  const control = heroControl(state);
  const onControl = () => {
    if (control === 'pause') {
      dispatch({ type: 'USER_PAUSE' });
      return;
    }
    dispatch({ type: 'USER_PLAY' });
    // O play() acontece DENTRO do gesto do usuário quando o vídeo já está montado (caso `blocked`/pausado); no `manual` o vídeo monta e o efeito toca.
    const el = videoRef.current;
    if (el && stateRef.current.phase !== 'manual') {
      el.muted = true;
      void el.play().catch((error: unknown) => dispatch({ type: 'PLAY_REJECTED', name: error instanceof DOMException ? error.name : 'Error' }));
    }
  };

  const fitStyle: CSSProperties & Record<'--hero-pos-d' | '--hero-pos-m', string> = { '--hero-pos-d': position.desktop, '--hero-pos-m': position.mobile };
  const sources = video ? heroVideoSources(video, isMobile) : [];

  return (
    <>
      <Image
        ref={imageRef}
        src={image.src}
        alt={image.alt}
        fill
        priority
        sizes="(max-width: 760px) 100vw, 58vw"
        className="campaign-image hero-fit"
        style={fitStyle}
      />
      {video && mounted ? (
        <video
          // Recria o elemento se o conjunto de fontes mudar (celular ↔ desktop), para o navegador reavaliar as <source>.
          key={sources.map((s) => s.src).join('|')}
          ref={attachVideo}
          className="campaign-image hero-fit hero-video"
          style={fitStyle}
          data-shown={state.shown ? 'true' : 'false'}
          data-phase={state.phase}
          muted
          loop
          playsInline
          autoPlay
          preload="auto"
          // Sem `poster` por padrão: a imagem do hero já está por baixo, e um poster bruto vira candidato a LCP quando o vídeo aparece (mediu-se LCP 1,1 s → 4,6 s em 4G).
          poster={video.poster}
          aria-hidden="true"
          tabIndex={-1}
          disablePictureInPicture
          disableRemotePlayback
          onPlaying={(event) => onPlaying(event.currentTarget)}
          onWaiting={() => {
            if (stateRef.current.phase !== 'playing' || stallTimer.current !== undefined) return;
            stallTimer.current = window.setTimeout(() => {
              stallTimer.current = undefined;
              dispatch({ type: 'STALL' });
            }, stallMs);
          }}
          onError={(event) => {
            // O `error` de uma <source> sobe até aqui (React), mas só é terminal na ÚLTIMA fonte: nas anteriores o navegador ainda tenta a próxima (WebM → MP4).
            const target = event.target;
            if (target instanceof HTMLSourceElement && target.nextElementSibling !== null) return;
            dispatch({ type: 'ERROR' });
          }}
        >
          {sources.map((source) => (
            // Se esta fonte falhar (404/decodificação/formato), o navegador tenta a próxima; o `onError` do <video> só trata como terminal a falha da última.
            <source key={source.src} src={source.src} type={source.type} />
          ))}
        </video>
      ) : null}
      {control !== 'none' ? (
        <button
          type="button"
          className="hero-video-control"
          onClick={onControl}
          aria-label={control === 'pause' ? 'Pausar vídeo de fundo' : 'Reproduzir vídeo de fundo'}
          data-control={control}
        >
          {control === 'pause' ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
        </button>
      ) : null}
    </>
  );
}
