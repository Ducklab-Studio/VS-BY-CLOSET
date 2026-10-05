'use client';

import { useRef } from 'react';
import { useGSAP } from '@gsap/react';
import { gsap } from '@/lib/gsap';
import { usePathname } from 'next/navigation';

export function GlobalScrollReveal() {
  const scope = useRef<HTMLDivElement>(null);
  const pathname = usePathname(); // Re-trigger animations on route change

  useGSAP(
    () => {
      const mm = gsap.matchMedia();

      mm.add('(prefers-reduced-motion: no-preference)', () => {
        // Select all sections, product cards, and major blocks that don't already have specific animations
        const elements = gsap.utils.toArray<HTMLElement>(
          'section:not(.editorial-hero):not(.winter-story):not(.rental-calendar):not(.product-gallery), .product-editorial, .guide-cta, .contact-primary, .contact-secondary, .cart-page',
        );

        elements.forEach((item) => {
          gsap.from(item, {
            y: 40,
            opacity: 0,
            duration: 0.8,
            ease: 'power3.out',
            scrollTrigger: {
              trigger: item,
              start: 'top 90%', // Trigger when the top of the element hits 90% down the viewport
              once: true,
            },
            clearProps: 'all',
          });
        });
      });

      return () => {
        mm.revert();
      };
    },
    { dependencies: [pathname] },
  );

  return <div ref={scope} style={{ display: 'none' }} />;
}
