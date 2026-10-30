'use client';
import { useRef } from 'react';
import { useGSAP } from '@gsap/react';
import { gsap } from '@/lib/gsap';

export function EditorialMotion({ children }: { children: React.ReactNode }) {
  const scope = useRef<HTMLDivElement>(null);
  useGSAP(
    () => {
      const mm = gsap.matchMedia();
      let introTween: gsap.core.Tween | undefined;
      let heroPhotoTween: gsap.core.Tween | undefined;
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        introTween = gsap.from('[data-intro]', {
          y: 32,
          opacity: 0,
          stagger: 0.11,
          duration: 1,
          ease: 'power3.out',
          clearProps: 'all',
        });
        heroPhotoTween = gsap.from('.hero-photo', {
          clipPath: 'inset(0 0 100% 0)',
          duration: 1.4,
          ease: 'power3.inOut',
          clearProps: 'clipPath',
        });
        gsap.utils.toArray<HTMLElement>('[data-reveal]').forEach((item) => {
          gsap.from(item, {
            y: 35,
            opacity: 0,
            duration: 0.8,
            scrollTrigger: { trigger: item, start: 'top 93%', once: true },
            clearProps: 'all',
          });
        });

        // Revelação coreografada dos textos da seção winter-story
        const winterElements = gsap.utils.toArray<HTMLElement>([
          '.winter-content .eyebrow',
          '.winter-content h2',
          '.winter-description',
          '.winter-feature-item',
          '.winter-cta-row',
          '.winter-carousel-stage',
        ]);

        gsap.from(winterElements, {
          y: 32,
          opacity: 0,
          duration: 0.9,
          stagger: 0.12,
          ease: 'power3.out',
          scrollTrigger: {
            trigger: '.winter-story',
            start: 'top 82%',
            once: true,
          },
          clearProps: 'all',
        });

      });
      mm.add('(min-width: 900px) and (prefers-reduced-motion: no-preference)', () => {
        gsap.to('.hero-photo .campaign-image', {
          yPercent: 12,
          ease: 'none',
          scrollTrigger: {
            trigger: '.editorial-hero',
            start: 'top top',
            end: 'bottom top',
            scrub: 1,
          },
        });
      });

      /**
       * Rede de segurança: se a aba perder foco/visibilidade durante a
       * entrada (o navegador pode pausar o ticker do GSAP nesse caso), as
       * tweens acima ficam presas num estado intermediário — texto do hero
       * quase invisível, foto cortada por clip-path. Nunca pode ficar assim
       * permanentemente. `kill()` primeiro: sem isso, se o ticker retomar
       * mais tarde a tween original continua viva e volta a escrever por
       * cima do estado final que o `clearProps` acabou de forçar. Se as
       * tweens já tiverem terminado sozinhas, tudo isto é um no-op.
       */
      const safety = window.setTimeout(() => {
        introTween?.kill();
        heroPhotoTween?.kill();
        gsap.set('[data-intro], .hero-photo', { clearProps: 'all' });
      }, 2200);

      return () => {
        window.clearTimeout(safety);
        mm.revert();
      };
    },
    { scope },
  );
  return (
    <div ref={scope} className="editorial-home">
      {children}
    </div>
  );
}
