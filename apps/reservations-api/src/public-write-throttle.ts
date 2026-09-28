/**
 * Limite próprio das escritas PÚBLICAS que prendem estoque (HOLD) ou abrem
 * checkout. O limite global (100/min por IP) deixava uma única origem criar
 * HOLDs suficientes para travar todas as peças até expirarem. Uma pessoa real
 * cria um ou dois HOLDs por reserva; 10 por minuto sobra para novas tentativas
 * e reenvios com a mesma Idempotency-Key.
 *
 * Por IP real: o navegador chama a API direto e `trust proxy` (main.ts) confia
 * só no proxy da Railway.
 */
export const PUBLIC_WRITE_THROTTLE = { default: { limit: 10, ttl: 60_000 } } as const;
