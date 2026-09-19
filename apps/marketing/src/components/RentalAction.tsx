'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** Moves the existing CTA visually; never duplicates or invokes rental logic. */
export function RentalAction({ children }: { children: ReactNode }) {
  const slot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = slot.current;
    const section = element?.closest('section');
    if (!element || !section) return;
    let frame = 0;
    const measure = () => {
      const panel = section.getBoundingClientRect();
      const placeholder = element.getBoundingClientRect();
      const visible = panel.top < window.innerHeight - 160 && panel.bottom > 160;
      element.dataset.floating = String(visible && placeholder.bottom > window.innerHeight);
      element.style.setProperty('--action-left', `${panel.left}px`);
      element.style.setProperty('--action-width', `${panel.width}px`);
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    const observer = new ResizeObserver(schedule);
    observer.observe(section);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);
  return <div ref={slot} className="rental-action-slot"><div className="rental-action">{children}</div></div>;
}
