/**
 * Contador do Valle Pass no menu do ClosetAdmin — texto do badge e o ciclo de
 * atualização. Arquivo puro (sem imports) para ser testado direto por
 * test/valle-pass-attention.test.mjs.
 *
 * A contagem é do servidor (GET /admin/vale-pass/orders/attention): pedidos
 * de Valle Pass pendentes de pagamento ou pagos que ninguém da equipe viu
 * neste status. Aqui só se decide COMO mostrar e QUANDO perguntar de novo.
 */
export const VALLE_PASS_ATTENTION_POLL_MS = 30_000;
/** Mesma aba: a tela do Valle Pass avisa o menu depois de marcar como visto. */
export const VALLE_PASS_ATTENTION_EVENT = 'closetadmin:valle-pass-attention';
/** Outras abas do mesmo navegador (BroadcastChannel). */
export const VALLE_PASS_ATTENTION_CHANNEL = 'closetadmin-valle-pass-attention';

/** Segundo contador do menu do Valle Pass: pagamentos confirmados SEM benefício / prazo de 72 h (GET /admin/vale-pass/flow/alerts). */
export const VALLE_PASS_FINANCIAL_EVENT = 'closetadmin:valle-pass-financial';
export const VALLE_PASS_FINANCIAL_CHANNEL = 'closetadmin-valle-pass-financial';

/** Texto para leitor de tela do contador financeiro. */
export function financialLabel(count: number | null, critical?: number): string {
  if (!count || count <= 0) return 'nenhum pagamento sem benefício';
  const base = count === 1 ? '1 pagamento confirmado sem benefício' : `${count > 99 ? 'mais de 99' : count} pagamentos confirmados sem benefício`;
  return critical && critical > 0 ? `${base}, ${critical} crítico(s)` : base;
}

/** `null` = sem badge (zero, ainda não carregado ou sem permissão). */
export function attentionBadgeText(count: number | null): string | null {
  if (count === null || !Number.isFinite(count) || count <= 0) return null;
  return count > 99 ? '99+' : String(Math.floor(count));
}

/** Texto para leitor de tela, anexado ao nome do link "Valle Pass". */
export function attentionLabel(count: number | null): string {
  if (!count || count <= 0) return 'nenhum pedido novo';
  return count === 1 ? '1 pedido para ver' : `${count > 99 ? 'mais de 99' : count} pedidos para ver`;
}

/** `alerts` (opcional) = parte de `count` que são pagamentos a tratar (só o menu de Reservas usa). */
export type AttentionFetchResult = { readonly count: number; readonly alerts?: number } | { readonly forbidden: true } | { readonly error: true };

export interface AttentionState {
  /** Último valor conhecido; `null` enquanto nada carregou. */
  readonly count: number | null;
  /** Parte de `count` que são pagamentos a tratar (ausente = nenhuma ou contador que não usa isto). */
  readonly alerts?: number;
  /** A última tentativa falhou: mostra o último valor conhecido, esmaecido. */
  readonly stale: boolean;
  /** Sem permissão ou sessão encerrada: parou de perguntar. */
  readonly stopped: boolean;
}

export const INITIAL_ATTENTION_STATE: AttentionState = { count: null, stale: false, stopped: false };

export interface AttentionPollerDeps {
  fetchCount(): Promise<AttentionFetchResult>;
  /** Aba visível? Em segundo plano não pergunta (volta a perguntar ao ficar visível). */
  isVisible(): boolean;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  onChange(state: AttentionState): void;
}

export interface AttentionPoller {
  /** Pergunta agora (abertura, aba visível de novo, pedido marcado como visto). */
  refresh(): Promise<void>;
  stop(): void;
}

/**
 * Uma pergunta na abertura e a cada VALLE_PASS_ATTENTION_POLL_MS enquanto a
 * aba estiver visível. Nunca duas perguntas ao mesmo tempo. Falha: mantém o
 * último valor (esmaecido) e tenta de novo no próximo ciclo. Sem permissão
 * ou sem sessão: esconde o badge e para de vez.
 *
 * `refresh()` pedido DURANTE uma pergunta já enviada não é descartado: aquela
 * pergunta pode ter lido o servidor antes da mudança que motivou o pedido (o
 * contador ficaria velho até o ciclo seguinte). Ao terminar, é feita UMA nova
 * pergunta — vários pedidos durante a mesma pergunta viram uma só — e o
 * `refresh()` só resolve depois dela. Pedidos do mesmo instante em que a
 * pergunta começa já são cobertos por ela. O ciclo de 30 s não enfileira nada.
 */
export function startAttentionPoller(deps: AttentionPollerDeps): AttentionPoller {
  let state = INITIAL_ATTENTION_STATE;
  let inFlight: Promise<void> | null = null;
  /** A pergunta em andamento já foi enviada ao servidor. */
  let sent = false;
  /** Chegou um pedido depois do envio: falta uma nova pergunta. */
  let again = false;
  let stopped = false;

  const publish = (next: AttentionState) => {
    if (next.count === state.count && next.alerts === state.alerts && next.stale === state.stale && next.stopped === state.stopped) return;
    state = next;
    deps.onChange(state);
  };

  async function ask(): Promise<void> {
    let result: AttentionFetchResult;
    try {
      result = await deps.fetchCount();
    } catch {
      result = { error: true };
    }
    if (stopped) return;
    if ('count' in result) publish({ count: result.count, ...(result.alerts !== undefined ? { alerts: result.alerts } : {}), stale: false, stopped: false });
    else if ('forbidden' in result) {
      stop();
      publish({ count: null, stale: false, stopped: true });
    } else publish({ ...state, stale: true });
  }

  /** Perguntas em sequência enquanto houver pedido novo depois do envio; no máximo uma extra por pergunta, e nenhuma depois do `stop()`. */
  async function drain(): Promise<void> {
    try {
      await Promise.resolve(); // pedidos do mesmo instante entram nesta mesma pergunta
      do {
        if (stopped) return;
        again = false;
        sent = true;
        await ask();
      } while (again && !stopped);
    } finally {
      inFlight = null;
      sent = false;
      again = false;
    }
  }

  function request(queueIfBusy: boolean): Promise<void> {
    if (stopped) return Promise.resolve();
    if (inFlight) {
      if (queueIfBusy && sent) again = true;
      return inFlight;
    }
    inFlight = drain();
    return inFlight;
  }

  function refresh(): Promise<void> {
    return request(true);
  }

  const timer = deps.setInterval(() => {
    if (deps.isVisible()) void request(false);
  }, VALLE_PASS_ATTENTION_POLL_MS);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    deps.clearInterval(timer);
  }

  void refresh();
  return { refresh, stop };
}
