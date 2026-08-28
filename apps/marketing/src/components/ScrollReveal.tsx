'use client';

import { useRef } from 'react';
import { useGSAP } from '@gsap/react';
import { gsap, ScrollTrigger } from '@/lib/gsap';

/**
 * Revela os filhos diretos (fade + leve subida) conforme entram na viewport
 * ao rolar a página. `once: true` — dispara uma vez, não fica "scrubando"
 * com o scroll; para o que este site precisa (uma entrada suave por seção),
 * scrub seria efeito por efeito, não motivo.
 *
 * Server Components (como FeaturedProducts) continuam renderizando no
 * servidor normalmente — este wrapper só observa os filhos depois de
 * montados, não precisa que o conteúdo em si seja client-side.
 *
 * useGSAP (pacote oficial @gsap/react) em vez de useLayoutEffect cru — ver
 * o comentário em HeroIntro.tsx para o porquê: a versão escrita à mão
 * deixava item preso em opacity:0 sob o Strict Mode do React em dev.
 */
export function ScrollReveal({
  children,
  className,
  stagger = 0.1,
}: {
  children: React.ReactNode;
  className?: string;
  stagger?: number;
}) {
  const scope = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const mm = gsap.matchMedia();

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const items = Array.from(scope.current!.children) as HTMLElement[];
        if (items.length === 0) return;

        // overwrite: true — mesma defesa aplicada em HeroIntro.tsx contra o
        // resíduo do duplo-mount do Strict Mode em dev (ver comentário lá).
        gsap.set(items, { opacity: 0, y: 24, overwrite: true });
        ScrollTrigger.create({
          trigger: scope.current,
          start: 'top 85%',
          once: true,
          onEnter: () =>
            gsap.to(items, {
              opacity: 1,
              y: 0,
              duration: 0.7,
              ease: 'power3.out',
              stagger,
              overwrite: true,
            }),
        });
      });
    },
    { scope, dependencies: [stagger] },
  );

  return (
    <div ref={scope} className={className}>
      {children}
    </div>
  );
}
