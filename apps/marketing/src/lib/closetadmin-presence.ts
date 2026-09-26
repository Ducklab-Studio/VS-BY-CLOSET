/**
 * Presença online/offline do ClosetAdmin — constantes e formatação. Arquivo
 * puro (sem imports) pra ser testado direto por scripts/closetadmin-presence.test.mjs.
 *
 * A API considera a aba viva por 90 s depois do último heartbeat
 * (PRESENCE_TTL_SECONDS no reservations-api); 25 s entre heartbeats tolera
 * perder dois seguidos e o ~1 timer/min que o navegador impõe a abas em
 * segundo plano. Presença NÃO depende de mouse/teclado: aba aberta,
 * autenticada e mandando heartbeat (mesmo minimizada) é Online. Só sai por
 * logout, fechar todas as abas, sessão expirada/revogada, conta bloqueada/
 * removida ou ficar sem conexão além do TTL.
 */
export const PRESENCE_HEARTBEAT_MS = 25_000;
/** Atualização da lista de Funcionários para quem está olhando. */
export const PRESENCE_POLL_MS = 15_000;

export interface PresenceHeartbeatDeps {
  readonly clientId: string;
  /** POST do corpo; devolve o status HTTP, ou `null` sem conexão. */
  post(body: string, keepalive: boolean): Promise<number | null>;
  /** `navigator.sendBeacon`; `false` quando não saiu (aí vai por `post` com keepalive). */
  beacon(body: string): boolean;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface PresenceHeartbeat {
  /** Heartbeat agora (também usado ao voltar do cache de navegação ou da rede). */
  beat(): Promise<void>;
  /** Avisa a saída desta aba (fechar/recarregar). */
  leave(): void;
  /** Para de vez e avisa a saída (a aba está sendo desmontada). */
  stop(): void;
  isStopped(): boolean;
}

/**
 * Heartbeat de uma aba: um já na abertura e um a cada PRESENCE_HEARTBEAT_MS,
 * sem condição nenhuma de interação. Para sozinho só quando a API diz que a
 * sessão não vale mais (401 — logout em outra aba, bloqueio, expiração). Sem
 * conexão: continua tentando; o TTL da API resolve o status enquanto isso.
 */
export function startPresenceHeartbeat(deps: PresenceHeartbeatDeps): PresenceHeartbeat {
  let stopped = false;
  const payload = (action: 'heartbeat' | 'leave') => JSON.stringify({ action, clientId: deps.clientId });

  async function beat(): Promise<void> {
    if (stopped) return;
    const status = await deps.post(payload('heartbeat'), false);
    if (status === 401) stopped = true;
  }
  function leave(): void {
    const body = payload('leave');
    if (!deps.beacon(body)) void deps.post(body, true);
  }

  void beat();
  const timer = deps.setInterval(() => void beat(), PRESENCE_HEARTBEAT_MS);

  return {
    beat,
    leave,
    stop() {
      deps.clearInterval(timer);
      if (!stopped) leave();
      stopped = true;
    },
    isStopped: () => stopped,
  };
}

export interface EmployeePresence {
  readonly adminUserId: string;
  readonly online: boolean;
  readonly lastSeenAt: string | null;
}

/** "Visto por último há X" — só faz sentido para quem está Offline e já apareceu alguma vez. */
export function formatLastSeen(lastSeenAt: string | null, nowMs: number): string | null {
  if (!lastSeenAt) return null;
  const seen = Date.parse(lastSeenAt);
  if (Number.isNaN(seen)) return null;
  const minutes = Math.floor(Math.max(0, nowMs - seen) / 60_000);
  if (minutes < 1) return 'Visto por último há menos de 1 min';
  if (minutes < 60) return `Visto por último há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Visto por último há ${hours} h`;
  const days = Math.floor(hours / 24);
  return `Visto por último há ${days} ${days === 1 ? 'dia' : 'dias'}`;
}

/** Corpo aceito pela rota /closetadmin/presence. */
export function parsePresenceRequest(raw: string): { action: 'heartbeat' | 'leave'; clientId: string } | null {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const { action, clientId } = body as { action?: unknown; clientId?: unknown };
  if (action !== 'heartbeat' && action !== 'leave') return null;
  if (typeof clientId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)) return null;
  return { action, clientId };
}

/** A rota só aceita chamada do próprio painel (mesma origem): nada de outro site
 *  disparando heartbeat/saída com o cookie de quem está logado. */
export function isSameOriginRequest(headers: { get(name: string): string | null }): boolean {
  const origin = headers.get('origin');
  const host = headers.get('x-forwarded-host') ?? headers.get('host');
  if (!origin) return headers.get('sec-fetch-site') === 'same-origin';
  try {
    return !!host && new URL(origin).host === host;
  } catch {
    return false;
  }
}
