/**
 * Bandeira em SVG puro — o emoji de bandeira (🇨🇱/🇧🇷) depende de uma
 * fonte de emoji colorida que o Windows não traz por padrão (achado
 * real: renderizava só as letras "CL"/"BR"). SVG inline funciona igual
 * em qualquer SO/navegador, sem depender de fonte instalada.
 */
export function CountryFlag({ code, className = 'h-3.5 w-5' }: { code: string; className?: string }) {
  if (code === '56') {
    return (
      <svg viewBox="0 0 24 16" className={className} aria-hidden="true">
        <rect width="24" height="16" fill="#fff" />
        <rect y="8" width="24" height="8" fill="#D52B1E" />
        <rect width="8" height="8" fill="#0039A6" />
        <path
          fill="#fff"
          transform="translate(4 4) scale(0.16)"
          d="M0,-10 L2.35,-3.09 L9.51,-3.09 L3.58,1.18 L5.88,8.09 L0,3.82 L-5.88,8.09 L-3.58,1.18 L-9.51,-3.09 L-2.35,-3.09 Z"
        />
      </svg>
    );
  }
  if (code === '55') {
    return (
      <svg viewBox="0 0 24 16" className={className} aria-hidden="true">
        <rect width="24" height="16" fill="#009B3A" />
        <polygon points="12,2 22,8 12,14 2,8" fill="#FEDF00" />
        <circle cx="12" cy="8" r="3.4" fill="#002776" />
      </svg>
    );
  }
  return null;
}
