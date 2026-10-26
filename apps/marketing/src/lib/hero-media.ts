/**
 * Vídeo do hero da home (puro: sem React, sem rede).
 *
 * `HERO_VIDEO = null` => a home mostra só a imagem (estado atual: nenhum vídeo foi recebido/aprovado). Quando o vídeo do Orlando chegar:
 *   1. coloque os arquivos em `public/editorial/` (`hero.mp4`, opcional `hero.webm`, opcional `hero-poster.webp`);
 *   2. troque `null` abaixo pelo objeto (exemplo no comentário). Nada mais precisa mudar: a imagem continua como fallback e como poster.
 * Guia de exportação em `docs/HERO-VIDEO.md`.
 */
export interface HeroVideo {
  /** Obrigatório (H.264, sem áudio). */
  readonly mp4: string;
  /** Opcional, carregado antes do mp4 pelos navegadores que o suportam. */
  readonly webm?: string;
  /** Opcional: quadro exibido até o vídeo começar (padrão: a própria imagem do hero). */
  readonly poster?: string;
}

// export const HERO_VIDEO: HeroVideo | null = { mp4: '/editorial/hero.mp4', webm: '/editorial/hero.webm', poster: '/editorial/hero-poster.webp' };
export const HERO_VIDEO: HeroVideo | null = null;

export interface HeroVideoConditions {
  readonly reducedMotion: boolean;
  /** `navigator.connection.saveData` (economia de dados ligada). */
  readonly saveData: boolean;
  /** `navigator.connection.effectiveType` ("4g", "3g", "2g", "slow-2g") quando o navegador informa. */
  readonly effectiveType?: string | null;
}

/** Só carrega o vídeo quando ele não atrapalha: sem "reduzir movimento", sem economia de dados e fora de conexões lentas. Na dúvida, fica a imagem. */
export function shouldLoadHeroVideo(c: HeroVideoConditions): boolean {
  if (c.reducedMotion || c.saveData) return false;
  const type = c.effectiveType ?? null;
  return type !== 'slow-2g' && type !== '2g' && type !== '3g';
}
