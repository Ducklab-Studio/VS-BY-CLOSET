'use client';

import Image from 'next/image';
import { useEffect, useRef, useState } from 'react';

/**
 * Selo "Desenvolvido por: Overframe" do rodapé. A animação é toda em CSS
 * (globals.css, `.footer-credit`); aqui só entra a entrada ao aparecer na
 * tela, uma única vez. Sem JS, com movimento reduzido ou se o selo já estiver
 * visível ao carregar, ele simplesmente aparece — nunca fica escondido.
 */
export function FooterCredit() {
  const ref = useRef<HTMLAnchorElement>(null);
  const [reveal, setReveal] = useState<'idle' | 'pending' | 'shown'>('idle');

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) return; // já visível: sem entrada

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setReveal('shown');
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    // Escondido só depois de montado e fora da tela: nenhum flash visível.
    const frame = requestAnimationFrame(() => {
      setReveal('pending');
      observer.observe(el);
    });
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return (
    <a
      ref={ref}
      href="https://www.overframe.com.br"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Desenvolvido pela Overframe (abre em nova aba)"
      className="footer-credit"
      data-reveal={reveal}
    >
      <span className="footer-credit-label">Desenvolvido por:</span>
      <span className="footer-credit-mark">
        <Image src="/overframe/logo-horizontal.png" alt="Overframe" width={1509} height={379} className="footer-credit-logo" />
      </span>
    </a>
  );
}
