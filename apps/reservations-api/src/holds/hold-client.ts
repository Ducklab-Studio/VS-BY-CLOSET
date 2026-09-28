import { createHash } from 'node:crypto';

/**
 * Limites de HOLD por quem pede — em três camadas, para travar abuso sem
 * barrar pessoas reais que dividem a mesma rede (casa, escritório, operadora
 * móvel com CGNAT):
 *
 *  - NAVEGADOR (IP confiável + id do navegador): uma pessoa real tem 1 HOLD
 *    ativo, às vezes 2 se refez o carrinho. O id sozinho não é confiável (o
 *    cliente escolhe), por isso ele só SUBDIVIDE o limite da rede, nunca o
 *    substitui;
 *  - REDE (IP confiável): teto bem maior, para várias pessoas no mesmo IP.
 *    Quem troca de id de navegador para burlar o limite esbarra aqui;
 *  - GLOBAL: disjuntor de volume. Muitos IPs juntos (ataque distribuído) não
 *    conseguem criar HOLDs além deste ritmo — muito acima da procura real de
 *    uma loja, e só por alguns minutos.
 *
 * Nada disto vale para o reenvio com a mesma Idempotency-Key (devolve o HOLD
 * existente antes) nem para HOLDs vencidos/pagos (só contam os ativos).
 */
export const HOLD_LIMITS = {
  perBrowser: { holds: 2, piecesFactor: 2 },
  perNetwork: { holds: 8, piecesFactor: 4 },
  global: { holds: 40, windowMinutes: 10 },
} as const;

export const HOLD_CLIENT_LIMIT_MESSAGE =
  'Você já tem reservas em andamento. Conclua o pagamento de uma delas ou aguarde alguns minutos para tentar de novo.';
export const HOLD_BUSY_MESSAGE = 'Estamos com muita procura agora. Tente novamente em alguns minutos.';

/** Teto de peças presas, relativo ao máximo por reserva da regra vigente. */
export function maxHeldPieces(level: 'perBrowser' | 'perNetwork', maxPiecesPerReservation: number): number {
  return HOLD_LIMITS[level].piecesFactor * maxPiecesPerReservation;
}

export interface HoldClient {
  /** Hash do IP confiável (client-ip.ts) — a rede. */
  readonly networkKey: string;
  /** Hash de IP + id do navegador — a pessoa, dentro da rede. */
  readonly browserKey: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `ip` já vem normalizado de `trustedClientIp` ('unknown' quando não há IP
 * confiável). `browserId` é o `X-Client-Id` que o site gera uma vez por
 * navegador; fora do formato, vira "anon" (sem subdivisão). Só hashes são
 * guardados — nunca o IP ou o id crus.
 */
export function holdClient(ip: string, browserId: string | string[] | undefined): HoldClient {
  const raw = Array.isArray(browserId) ? browserId[0] : browserId;
  const browser = raw && UUID_RE.test(raw.trim()) ? raw.trim().toLowerCase() : 'anon';
  const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
  return { networkKey: hash(`hold-network:${ip}`), browserKey: hash(`hold-browser:${ip}:${browser}`) };
}
