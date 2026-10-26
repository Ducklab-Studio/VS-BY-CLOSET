'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { shouldLoadHeroVideo, type HeroVideo } from '@/lib/hero-media';

interface HeroMediaProps {
  readonly image: { readonly src: string; readonly alt: string };
  /** `null` (padrão do projeto hoje) = só a imagem. */
  readonly video: HeroVideo | null;
}

interface NetworkInformationLike {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
}

/**
 * Mídia do hero: a imagem é SEMPRE renderizada (prioridade, sem layout shift) e serve de fallback/poster. O vídeo, quando existir, só é montado depois do
 * carregamento da página, em segundo plano e sem áudio; não toca com "reduzir movimento", economia de dados ou conexão lenta, pausa fora da tela/aba
 * oculta e, se der erro, a imagem continua ali. Com `video = null` nenhum `<video>` entra na página.
 */
export function HeroMedia({ image, video }: HeroMediaProps) {
  const [enabled, setEnabled] = useState(false);
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    if (!video) return;
    const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
    const allowed = shouldLoadHeroVideo({
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      saveData: connection?.saveData === true,
      effectiveType: connection?.effectiveType ?? null,
    });
    if (!allowed) return;
    let cancelled = false;
    let timer: number | undefined;
    const start = () => {
      timer = window.setTimeout(() => {
        if (!cancelled) setEnabled(true);
      }, 300);
    };
    if (document.readyState === 'complete') start();
    else window.addEventListener('load', start, { once: true });
    return () => {
      cancelled = true;
      window.removeEventListener('load', start);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [video]);

  useEffect(() => {
    const element = videoRef.current;
    if (!enabled || !element) return;
    let visible = true;
    const sync = () => {
      if (visible && !document.hidden) void element.play().catch(() => undefined);
      else element.pause();
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      sync();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', sync);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', sync);
    };
  }, [enabled]);

  return (
    <>
      <Image src={image.src} alt={image.alt} fill priority sizes="(max-width: 760px) 100vw, 58vw" className="campaign-image" />
      {video && enabled ? (
        <video
          ref={videoRef}
          className={`campaign-image hero-video${playing ? ' is-playing' : ''}`}
          muted
          loop
          playsInline
          preload="metadata"
          poster={video.poster ?? image.src}
          aria-hidden="true"
          tabIndex={-1}
          onPlaying={() => setPlaying(true)}
          onError={() => {
            setPlaying(false);
            setEnabled(false);
          }}
        >
          {video.webm ? <source src={video.webm} type="video/webm" /> : null}
          <source src={video.mp4} type="video/mp4" />
        </video>
      ) : null}
    </>
  );
}
