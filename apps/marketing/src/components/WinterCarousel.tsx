"use client";

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';
import { gsap } from '@/lib/gsap';

const photos = [
  ['lookbook-02-vinicola.webp', 'Casaco branco na vinícola'],
  ['lookbook-01-noite.webp', 'Casaco bege ao entardecer nas montanhas'],
  ['lookbook-03-jardim.webp', 'Casaco preto no jardim'],
  ['lookbook-04-varanda.webp', 'Casaco preto na varanda com taça'],
];

export function WinterCarousel() {
  const root = useRef<HTMLDivElement>(null);
  const paused = useRef(false);
  const reconcile = useRef<() => void>(() => {});
  const [isPaused, setPaused] = useState(false);
  useEffect(() => {
    const node = root.current!;
    const slides = Array.from(node.querySelectorAll<HTMLElement>('.winter-slide'));
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    let visible = false;
    let disposed = false;
    let preparing = false;
    let timeline: gsap.core.Timeline | undefined;
    let context = gsap.context(() => {}, node);
    const sync = () => {
      if (visible && !document.hidden && !paused.current && !media.matches) timeline?.play();
      else timeline?.pause();
    };
    reconcile.current = sync;
    const prepare = async () => {
      if (preparing || timeline || media.matches) return;
      preparing = true;
      try {
        await Promise.all(slides.map(async (slide) => {
          const img = slide.querySelector('img')!;
          img.loading = 'eager';
          await img.decode();
        }));
        if (disposed || media.matches) return;
        context.add(() => {
          timeline = gsap.timeline({ paused: true, repeat: -1 });
          for (let i = 0; i < slides.length; i++) {
            const current = slides[i];
            const next = slides[(i + 1) % slides.length];
            const start = i * 6.1;
            timeline.fromTo(current.querySelector('img'), { scale: 1.04 }, { scale: 1, duration: 6.1, ease: 'none', immediateRender: false }, start);
            timeline.set(slides, { zIndex: 0 }, start + 5);
            timeline.set(current, { zIndex: 1 }, start + 5);
            timeline.set(next, { zIndex: 2 }, start + 5);
            timeline.set(next.querySelector('img'), { scale: 1.04 }, start + 5);
            timeline.fromTo(next, { opacity: 0 }, { opacity: 1, duration: 1.1, ease: 'sine.inOut', immediateRender: false }, start + 5);
            timeline.set(current, { opacity: 0 }, start + 6.1);
          }
        });
        sync();
      } catch {
        // A failed decode leaves the server-rendered first photograph visible.
      } finally { preparing = false; }
    };
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) void prepare();
      sync();
    }, { threshold: 0 });
    observer.observe(node);
    const preference = () => {
      context.revert();
      slides.forEach(slide => {
        slide.style.removeProperty('opacity');
        slide.style.removeProperty('z-index');
        slide.querySelector('img')?.style.removeProperty('transform');
      });
      timeline = undefined;
      context = gsap.context(() => {}, node);
      if (visible) void prepare();
    };
    media.addEventListener('change', preference);
    document.addEventListener('visibilitychange', sync);
    return () => {
      disposed = true;
      observer.disconnect();
      media.removeEventListener('change', preference);
      document.removeEventListener('visibilitychange', sync);
      context.revert();
      reconcile.current = () => {};
    };
  }, []);

  return (
    <div ref={root} className="winter-image winter-carousel" role="region" aria-label="Campanha VS BY CLOSET">
      {photos.map(([file, alt], i) => (
        <div key={file} className="winter-slide" aria-hidden={i !== 0}>
          <Image src={`/editorial/${file}`} alt={i === 0 ? alt : ''} fill sizes="(max-width: 448px) calc(100vw - 48px), (max-width: 900px) 400px, 560px" />
        </div>
      ))}
      <button className="winter-carousel-pause" aria-pressed={isPaused} onClick={() => {
        paused.current = !paused.current;
        setPaused(paused.current);
        reconcile.current();
      }}>{isPaused ? 'Retomar imagens' : 'Pausar imagens'}</button>
    </div>
  );
}
