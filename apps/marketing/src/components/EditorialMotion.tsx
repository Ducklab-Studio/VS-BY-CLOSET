'use client';
import { useRef } from 'react';
import { useGSAP } from '@gsap/react';
import { gsap } from '@/lib/gsap';

export function EditorialMotion({ children }: { children: React.ReactNode }) {
  const scope = useRef<HTMLDivElement>(null);
  useGSAP(() => {
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      gsap.from('[data-intro]', { y: 32, opacity: 0, stagger: 0.11, duration: 1, ease: 'power3.out', clearProps: 'all' });
      gsap.from('.hero-photo', { clipPath: 'inset(0 0 100% 0)', duration: 1.4, ease: 'power3.inOut', clearProps: 'clipPath' });
      gsap.utils.toArray<HTMLElement>('[data-reveal]').forEach((item) => {
        gsap.from(item, { y: 35, opacity: 0, duration: 0.8, scrollTrigger: { trigger: item, start: 'top 93%', once: true }, clearProps: 'all' });
      });
    });
    mm.add('(min-width: 900px) and (prefers-reduced-motion: no-preference)', () => {
      gsap.to('.hero-photo .campaign-image', { yPercent: 12, ease: 'none', scrollTrigger: { trigger: '.editorial-hero', start: 'top top', end: 'bottom top', scrub: 1 } });
      gsap.fromTo('.story-mark', { scale: 1.05, rotate: -5 }, { scale: 0.8, rotate: 5, ease: 'none', scrollTrigger: { trigger: '.brand-story', start: 'top 65%', end: 'bottom 20%', scrub: 1 } });
      gsap.timeline({ scrollTrigger: { trigger: '.winter-story', start: 'top 110px', end: '+=550', pin: true, scrub: 1 } })
        .fromTo('.winter-image', { scale: 1.15 }, { scale: 1, duration: 1 })
        .fromTo('.winter-content h2', { y: 45 }, { y: -15, duration: 1 }, 0);
    });
    return () => mm.revert();
  }, { scope });
  return <div ref={scope} className="editorial-home">{children}</div>;
}
