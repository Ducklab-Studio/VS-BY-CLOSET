/**
 * Neve ambiente — camada decorativa de "inverno mágico" sobre o site inteiro.
 *
 * Os valores de cada floco são fixos, escolhidos à mão (não Math.random()).
 * Já vimos nesse projeto que aleatoriedade calculada em runtime é uma causa
 * clássica de erro de hidratação — servidor e cliente sorteiam valores
 * diferentes. Aqui não tem sorteio nenhum: é uma lista estática, então o
 * HTML do servidor e o do cliente são idênticos, sempre.
 *
 * Server Component puro — não precisa de 'use client' nem de useEffect.
 */

interface Flake {
  left: number; // % da largura da tela
  size: number; // px
  duration: number; // s, tempo pra atravessar a tela
  delay: number; // s, negativo = já entra em movimento no load
  drift: number; // px, quanto balança de um lado a outro
  opacity: number;
}

// 28 flocos com parâmetros variados à mão — dá sensação orgânica sem sorteio.
const FLAKES: Flake[] = [
  { left: 2, size: 4, duration: 16, delay: -3, drift: 24, opacity: 0.55 },
  { left: 7, size: 3, duration: 21, delay: -14, drift: -18, opacity: 0.4 },
  { left: 12, size: 5, duration: 14, delay: -8, drift: 30, opacity: 0.6 },
  { left: 17, size: 2, duration: 24, delay: -2, drift: -12, opacity: 0.35 },
  { left: 22, size: 4, duration: 18, delay: -11, drift: 20, opacity: 0.5 },
  { left: 27, size: 3, duration: 20, delay: -6, drift: -26, opacity: 0.45 },
  { left: 32, size: 6, duration: 13, delay: -19, drift: 16, opacity: 0.65 },
  { left: 37, size: 2, duration: 26, delay: -1, drift: -20, opacity: 0.3 },
  { left: 42, size: 4, duration: 17, delay: -9, drift: 28, opacity: 0.55 },
  { left: 47, size: 3, duration: 22, delay: -15, drift: -14, opacity: 0.4 },
  { left: 52, size: 5, duration: 15, delay: -4, drift: 22, opacity: 0.6 },
  { left: 57, size: 2, duration: 25, delay: -12, drift: -24, opacity: 0.35 },
  { left: 62, size: 4, duration: 19, delay: -7, drift: 18, opacity: 0.5 },
  { left: 67, size: 3, duration: 23, delay: -17, drift: -16, opacity: 0.42 },
  { left: 72, size: 6, duration: 14, delay: -5, drift: 26, opacity: 0.62 },
  { left: 77, size: 2, duration: 27, delay: -20, drift: -22, opacity: 0.3 },
  { left: 4, size: 3, duration: 20, delay: -10, drift: 20, opacity: 0.45 },
  { left: 84, size: 4, duration: 16, delay: -13, drift: -18, opacity: 0.55 },
  { left: 89, size: 5, duration: 18, delay: -3, drift: 24, opacity: 0.6 },
  { left: 94, size: 2, duration: 24, delay: -16, drift: -20, opacity: 0.35 },
  { left: 14, size: 3, duration: 21, delay: -6, drift: 16, opacity: 0.4 },
  { left: 29, size: 4, duration: 17, delay: -18, drift: -28, opacity: 0.52 },
  { left: 44, size: 2, duration: 25, delay: -9, drift: 18, opacity: 0.32 },
  { left: 59, size: 5, duration: 15, delay: -1, drift: -22, opacity: 0.58 },
  { left: 74, size: 3, duration: 22, delay: -14, drift: 26, opacity: 0.4 },
  { left: 91, size: 4, duration: 19, delay: -8, drift: -16, opacity: 0.5 },
  { left: 97, size: 2, duration: 26, delay: -4, drift: 20, opacity: 0.3 },
  { left: 65, size: 6, duration: 13, delay: -21, drift: -24, opacity: 0.65 },
];

export function Snowfall() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-40 overflow-hidden motion-reduce:hidden"
    >
      {FLAKES.map((f, i) => (
        <span
          key={i}
          className="absolute top-[-10%] rounded-full bg-frost animate-snow-fall"
          style={
            {
              left: `${f.left}%`,
              width: `${f.size}px`,
              height: `${f.size}px`,
              opacity: f.opacity,
              animationDuration: `${f.duration}s`,
              animationDelay: `${f.delay}s`,
              '--drift': `${f.drift}px`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}
