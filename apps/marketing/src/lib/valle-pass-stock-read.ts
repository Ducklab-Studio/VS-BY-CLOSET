import type { WebStockEvidence } from './valle-pass-launch-readiness';

/**
 * Leitura do estoque da Shopify para o painel "Pronta para vender?" — SOMENTE LEITURA e à prova de falha. Toda saída que não seja uma resposta clara e bem
 * formada da Shopify vira `{ status: 'unknown' }`, que NUNCA aprova o item (ele fica pendente). Cobre: erro de rede, exceção síncrona, resposta malformada,
 * timeout (o temporizador é sempre limpo) e valores inválidos (quantidade negativa, fracionária ou texto).
 */
export const STOCK_READ_TIMEOUT_MS = 3_000;
const UNKNOWN: WebStockEvidence = { status: 'unknown' };

/** Aceita só o que `shopify-stock.ts` pode produzir; qualquer outra coisa é desconhecida. */
export function normalizeStock(value: unknown): WebStockEvidence {
  if (!value || typeof value !== 'object') return UNKNOWN;
  const raw = value as { status?: unknown; quantity?: unknown };
  if (raw.status === 'sold_out') return { status: 'sold_out' };
  if (raw.status === 'available') {
    if (raw.quantity === null || raw.quantity === undefined) return { status: 'available', quantity: null };
    if (typeof raw.quantity === 'number' && Number.isInteger(raw.quantity) && raw.quantity >= 0) return { status: 'available', quantity: raw.quantity };
    return UNKNOWN;
  }
  return UNKNOWN;
}

export async function readStockEvidence(read: () => Promise<unknown>, timeoutMs: number = STOCK_READ_TIMEOUT_MS): Promise<WebStockEvidence> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<WebStockEvidence>((resolve) => {
    timer = setTimeout(() => resolve(UNKNOWN), timeoutMs);
  });
  const attempt = (async () => {
    try {
      return normalizeStock(await read());
    } catch {
      return UNKNOWN;
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
