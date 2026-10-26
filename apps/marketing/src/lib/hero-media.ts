/**
 * Vídeo do hero da home (puro: sem React, sem rede, sem relógio) — decisão de carregamento, escolha de fontes e máquina de estados da reprodução.
 *
 * `HERO_VIDEO = null` => a home mostra só a imagem (estado atual: o vídeo oficial ainda não foi entregue). Para ativar, ver `docs/HERO-VIDEO.md`
 * (arquivos em `public/editorial/video/` com nome versionado + o objeto abaixo). A imagem do hero continua sempre como fallback.
 */
export interface HeroVideoSet {
  /** Obrigatório: H.264 (High, yuv420p, `+faststart`), sem áudio. É o que o Safari/iOS toca. */
  readonly mp4: string;
  /** Opcional: VP9. Vem antes do mp4 na lista de fontes; o navegador baixa só UMA delas. */
  readonly webm?: string;
}

export interface HeroVideoPosition {
  /** `object-position` no desktop (padrão "67% center", o mesmo da imagem). */
  readonly desktop?: string;
  /** `object-position` no celular (≤ 760 px); padrão = o do desktop. */
  readonly mobile?: string;
}

export interface HeroVideo extends HeroVideoSet {
  /** Versão menor para celular (≤ 760 px). Sem ela, o celular usa o conjunto principal. */
  readonly mobile?: HeroVideoSet;
  /** Poster do <video>. Padrão: nenhum (a imagem do hero fica por baixo). Cuidado: um poster grande vira candidato a LCP quando o vídeo aparece. */
  readonly poster?: string;
  /** Enquadramento do vídeo; a imagem usa o mesmo, para a troca imagem→vídeo não "pular". */
  readonly position?: HeroVideoPosition;
  /** Tempo máximo até o PRIMEIRO frame antes de desistir e ficar na imagem (padrão 8000 ms). */
  readonly timeoutMs?: number;
  /** Quanto tempo parado (buffer) antes de voltar à imagem (padrão 2500 ms). */
  readonly stallMs?: number;
}

export const HERO_VIDEO: HeroVideo | null = null;

export const HERO_VIDEO_DEFAULT_TIMEOUT_MS = 8000;
export const HERO_VIDEO_DEFAULT_STALL_MS = 2500;
export const HERO_MOBILE_QUERY = '(max-width: 760px)';

// ───────────────────────── decisão de carregamento ─────────────────────────

export interface HeroVideoConditions {
  readonly reducedMotion: boolean;
  /** `navigator.connection.saveData` (economia de dados ligada). */
  readonly saveData: boolean;
  /** `navigator.connection.effectiveType` ("4g", "3g", "2g", "slow-2g") quando o navegador informa; `null`/ausente = desconhecido (não bloqueia). */
  readonly effectiveType?: string | null;
}

export type HeroVideoManualReason = 'reduced-motion' | 'save-data' | 'slow-connection';

export interface HeroVideoDecision {
  /** `off` sem vídeo; `auto` carrega e toca sozinho; `manual` não baixa nada até a pessoa pedir. */
  readonly mode: 'off' | 'auto' | 'manual';
  readonly reason: HeroVideoManualReason | null;
}

export function decideHeroVideo(video: HeroVideo | null, c: HeroVideoConditions): HeroVideoDecision {
  if (!video) return { mode: 'off', reason: null };
  if (c.reducedMotion) return { mode: 'manual', reason: 'reduced-motion' };
  if (c.saveData) return { mode: 'manual', reason: 'save-data' };
  const type = c.effectiveType ?? null;
  if (type === 'slow-2g' || type === '2g' || type === '3g') return { mode: 'manual', reason: 'slow-connection' };
  return { mode: 'auto', reason: null };
}

/** Compatibilidade: só o modo automático carrega sozinho. */
export function shouldLoadHeroVideo(c: HeroVideoConditions): boolean {
  return decideHeroVideo({ mp4: '' }, c).mode === 'auto';
}

// ───────────────────────── fontes ─────────────────────────

export interface HeroVideoSource {
  readonly src: string;
  readonly type: string;
}

/**
 * Lista ordenada de fontes para UM conjunto (celular ou desktop): WebM/VP9 primeiro, MP4/H.264 depois. O navegador escolhe a primeira que sabe tocar e baixa só
 * ela (sem download duplicado). Quem não toca WebM (Safari/iOS mais antigos) cai no MP4. `media` em `<source>` de vídeo não é respeitado, por isso a escolha
 * celular/desktop é feita aqui, em JavaScript.
 */
export function heroVideoSources(video: HeroVideo, isMobile: boolean): readonly HeroVideoSource[] {
  const set: HeroVideoSet = isMobile && video.mobile ? video.mobile : video;
  const sources: HeroVideoSource[] = [];
  if (set.webm) sources.push({ src: set.webm, type: 'video/webm; codecs="vp9"' });
  sources.push({ src: set.mp4, type: 'video/mp4' });
  return sources;
}

export function heroVideoPosition(video: HeroVideo | null): { readonly desktop: string; readonly mobile: string } {
  const desktop = video?.position?.desktop ?? '67% center';
  return { desktop, mobile: video?.position?.mobile ?? desktop };
}

// ───────────────────────── máquina de estados ─────────────────────────

/**
 * - `off`           sem vídeo configurado.
 * - `manual`        nada é baixado; botão "Reproduzir" (reduzir movimento, economia de dados, conexão lenta).
 * - `waiting-image` automático: espera a imagem (LCP) terminar antes de pedir o vídeo.
 * - `loading`       `<video>` montado, ainda sem frame válido (a imagem continua visível).
 * - `playing`       frame válido apresentado: o vídeo aparece por cima da imagem.
 * - `stalled`       travou (buffer): volta à imagem até recuperar.
 * - `blocked`       o navegador recusou o play() (política de autoplay / Modo Pouca Energia): imagem + botão.
 * - `failed`        erro, arquivo ausente ou timeout: só a imagem, sem botão.
 */
export type HeroPhase = 'off' | 'manual' | 'waiting-image' | 'loading' | 'playing' | 'stalled' | 'blocked' | 'failed';

export interface HeroState {
  readonly phase: HeroPhase;
  /** A pessoa pediu pausa (sobrepõe tudo até ela pedir para tocar). */
  readonly userPaused: boolean;
  /** O hero está na tela (IntersectionObserver). */
  readonly inView: boolean;
  /** A aba está visível. */
  readonly tabVisible: boolean;
  /** O vídeo está por cima da imagem (houve frame válido e não travou). */
  readonly shown: boolean;
}

export type HeroEvent =
  | { readonly type: 'INIT'; readonly decision: HeroVideoDecision }
  | { readonly type: 'PREF_CHANGE'; readonly decision: HeroVideoDecision }
  | { readonly type: 'IMAGE_READY' }
  | { readonly type: 'FRAME' }
  | { readonly type: 'PLAY_REJECTED'; readonly name: string }
  | { readonly type: 'ERROR' }
  | { readonly type: 'TIMEOUT' }
  | { readonly type: 'STALL' }
  | { readonly type: 'USER_PLAY' }
  | { readonly type: 'USER_PAUSE' }
  | { readonly type: 'TAB'; readonly visible: boolean }
  | { readonly type: 'VIEW'; readonly inView: boolean };

export function initialHeroState(): HeroState {
  return { phase: 'off', userPaused: false, inView: true, tabVisible: true, shown: false };
}

const LIVE: readonly HeroPhase[] = ['loading', 'playing', 'stalled'];
const MOUNTED: readonly HeroPhase[] = ['loading', 'playing', 'stalled', 'blocked'];

export function heroReducer(state: HeroState, event: HeroEvent): HeroState {
  switch (event.type) {
    case 'INIT': {
      const { mode } = event.decision;
      return { ...state, phase: mode === 'off' ? 'off' : mode === 'manual' ? 'manual' : 'waiting-image', shown: false };
    }
    case 'PREF_CHANGE': {
      const { mode } = event.decision;
      // Mudou para algo restritivo (reduzir movimento, economia de dados, conexão lenta): para o vídeo e volta à imagem; a pessoa pode pedir manualmente.
      if (mode === 'manual' && (state.phase === 'waiting-image' || MOUNTED.includes(state.phase))) return { ...state, phase: 'manual', shown: false };
      // Voltou ao normal e nada havia começado: segue o modo automático. Quem já escolheu ficar no manual continua nele.
      if (mode === 'auto' && state.phase === 'manual' && !state.userPaused) return { ...state, phase: 'waiting-image' };
      if (mode === 'off') return { ...state, phase: 'off', shown: false };
      return state;
    }
    case 'IMAGE_READY':
      return state.phase === 'waiting-image' ? { ...state, phase: 'loading' } : state;
    case 'FRAME':
      return state.phase === 'loading' || state.phase === 'stalled' || state.phase === 'blocked' ? { ...state, phase: 'playing', shown: true } : state;
    case 'PLAY_REJECTED':
      // NotAllowedError = política do navegador/sistema (inclui Modo Pouca Energia do iOS): sem hacks, a imagem fica e há o botão.
      if (event.name === 'NotAllowedError') return MOUNTED.includes(state.phase) ? { ...state, phase: 'blocked', shown: false } : state;
      // AbortError = o play() foi interrompido por um novo load/pausa nossa: não é falha.
      if (event.name === 'AbortError') return state;
      return MOUNTED.includes(state.phase) ? { ...state, phase: 'failed', shown: false } : state;
    case 'ERROR':
      return MOUNTED.includes(state.phase) || state.phase === 'waiting-image' ? { ...state, phase: 'failed', shown: false } : state;
    case 'TIMEOUT':
      return state.phase === 'loading' ? { ...state, phase: 'failed', shown: false } : state;
    case 'STALL':
      return state.phase === 'playing' ? { ...state, phase: 'stalled', shown: false } : state;
    case 'USER_PLAY':
      if (state.phase === 'manual') return { ...state, phase: 'loading', userPaused: false };
      if (state.phase === 'blocked') return { ...state, phase: 'loading', userPaused: false };
      return { ...state, userPaused: false };
    case 'USER_PAUSE':
      return LIVE.includes(state.phase) ? { ...state, userPaused: true } : state;
    case 'TAB':
      return { ...state, tabVisible: event.visible };
    case 'VIEW':
      return { ...state, inView: event.inView };
  }
}

/** O vídeo deve estar tocando agora? (só quando está montado, ninguém pausou, o hero está na tela e a aba está visível). */
export function heroShouldRun(state: HeroState): boolean {
  return LIVE.includes(state.phase) && !state.userPaused && state.inView && state.tabVisible;
}

/** O `<video>` deve existir no DOM? (em `manual`, `failed`, `off` e `waiting-image` nada é baixado). */
export function heroVideoMounted(state: HeroState): boolean {
  return MOUNTED.includes(state.phase);
}

export type HeroControl = 'none' | 'play' | 'pause';

/** Botão discreto: "Reproduzir" quando o vídeo está parado por escolha, política ou preferência; "Pausar" enquanto toca (acessibilidade: movimento > 5 s). */
export function heroControl(state: HeroState): HeroControl {
  if (state.phase === 'manual' || state.phase === 'blocked') return 'play';
  if (state.phase === 'playing' || state.phase === 'stalled') return state.userPaused ? 'play' : 'pause';
  if (state.phase === 'loading' && state.userPaused) return 'play';
  return 'none';
}
