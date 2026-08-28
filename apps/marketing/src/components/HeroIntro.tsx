'use client';

import { useRef } from 'react';
import { useGSAP } from '@gsap/react';
import { gsap } from '@/lib/gsap';

/**
 * Entrada orquestrada do hero: eyebrow → título → subtítulo → CTA, em
 * sequência com atraso escalonado (stagger). É o tipo de timeline que o
 * Framer Motion também faria, mas com menos controle fino de easing e
 * offset entre os elementos — por isso GSAP aqui, mantendo Framer Motion
 * pros casos mais simples do resto do site.
 *
 * `useGSAP` (pacote oficial @gsap/react) em vez de useLayoutEffect cru: um
 * useLayoutEffect + gsap.matchMedia() escrito à mão deixava o primeiro item
 * preso em opacity:0 — o Strict Mode do React 19 monta/desmonta o efeito
 * duas vezes em dev, e a limpeza manual não desfazia o immediateRender do
 * `.from()` de forma consistente. useGSAP existe exatamente pra resolver
 * esse gotcha (contexto e revert corretos, testados pelo próprio time do
 * GSAP para Strict Mode) — não vale reinventar essa parte.
 *
 * `gsap.matchMedia` continua sendo a forma idiomática de respeitar
 * prefers-reduced-motion: o timeline de "reduced" só ajusta opacidade,
 * sem nenhum deslocamento.
 *
 * `overwrite: true` nos dois tweens: mesmo com useGSAP, sobrou um resíduo
 * do duplo-mount do Strict Mode — o item de delay zero do stagger ficava
 * preso em opacity:0 só em dev (confirmado limpo em build de produção,
 * onde o Strict Mode não roda). overwrite força matar qualquer tween
 * fantasma da montagem descartada antes de criar o novo, sem efeito
 * nenhum no caso normal (só existe um tween por vez de qualquer forma).
 */
export function HeroIntro({ children }: { children: React.ReactNode }) {
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();

      mm.add('(prefers-reduced-motion: reduce)', () => {
        gsap.from('[data-hero-item]', { opacity: 0, duration: 0.3, overwrite: true });
      });

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        gsap.from('[data-hero-item]', {
          opacity: 0,
          y: 18,
          duration: 0.7,
          stagger: 0.12,
          ease: 'power3.out',
          overwrite: true,
        });
      });
    },
    { scope },
  );

  return <div ref={scope}>{children}</div>;
}
