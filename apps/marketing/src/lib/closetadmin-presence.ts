/**
 * Presença online/offline do ClosetAdmin — constantes e formatação. Arquivo
 * puro (sem imports) pra ser testado direto por scripts/closetadmin-presence.test.mjs.
 *
 * A API considera a aba viva por 90 s depois do último heartbeat
 * (PRESENCE_TTL_SECONDS no reservations-api); 25 s entre heartbeats tolera
 * perder dois seguidos e o ~1 timer/min que o navegador impõe a abas em
 * segundo plano. Aba minimizada continua Online; o que a tira é ficar
 * PRESENCE_IDLE_MS sem nenhuma interação, fechar, sair ou perder conexão.
 */
export const PRESENCE_HEARTBEAT_MS = 25_000;
export const PRESENCE_IDLE_MS = 10 * 60_000;
/** Atualização da lista de Funcionários para quem está olhando. */
export const PRESENCE_POLL_MS = 15_000;

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
