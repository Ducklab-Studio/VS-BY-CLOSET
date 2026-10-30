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

        const lookbook = scope.current?.querySelector('.lookbook');
        if (lookbook) {
          const lookbookElements = gsap.utils.toArray<HTMLElement>([
            '.lookbook-heading .eyebrow',
            '.lookbook-heading h2',
            '.lookbook-lead',
            '.lookbook-intro .editorial-link',
            '.lookbook-figure',
          ]);

          gsap.from(lookbookElements, {
            y: 18,
            opacity: 0,
            duration: 0.72,
            stagger: 0.09,
            ease: 'power2.out',
            clearProps: 'all',
            scrollTrigger: {
              trigger: lookbook,
              start: 'top 78%',
              once: true,
            },
          });
        }

        // Revelação coreografada dos textos da seção winter-story
        const winterElements = gsap.utils.toArray<HTMLElement>([
          '.winter-content .eyebrow',
          '.winter-content h2',
          '.winter-description',
          '.winter-content .editorial-button',
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

        // Parallax cinemático da foto com as montanhas e a neve.
        // O excesso da escala em cada lado, (scale - 1) / 2 em %, precisa cobrir sempre o deslocamento (yPercent): 1.16 → 1.12 deixa 8% → 6% de folga
        // para um deslocamento de ±5%, então nunca aparece faixa vazia no topo ou no rodapé do quadro.
        gsap.fromTo(
          '.winter-rental-photo',
          {
            yPercent: -5,
            scale: 1.16,
          },
          {
            yPercent: 5,
            scale: 1.12,
            ease: 'none',
            scrollTrigger: {
              trigger: '.winter-story',
              start: 'top bottom',
              end: 'bottom top',
              scrub: 1.2,
            },
          },
        );
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
