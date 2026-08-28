/**
 * Ponto único de registro do GSAP/ScrollTrigger.
 *
 * Registrar o plugin em todo componente que o usa causa registro duplicado
 * (inofensivo, mas gera warning no console e é desleixo). Importar deste
 * arquivo garante que `gsap.registerPlugin` roda uma vez só, e só no
 * navegador — no SSR o ScrollTrigger não tem DOM pra observar.
 */
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

if (typeof window !== 'undefined') {
  gsap.registerPlugin(ScrollTrigger);
}

export { gsap, ScrollTrigger };
