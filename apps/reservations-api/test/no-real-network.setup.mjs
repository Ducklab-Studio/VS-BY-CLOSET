import { afterAll } from 'vitest';
import { installNoRealNetworkGuard, takeBlockedRequests } from '../../../scripts/no-real-network.mjs';

/**
 * Todo arquivo de teste da API roda com a rede real bloqueada (Shopify, Meta,
 * Resend, Vercel, Railway...): só host local passa. Quem precisa de uma Shopify
 * usa um cliente falso. Se algum código tentar sair — mesmo engolindo o erro —,
 * o arquivo falha aqui. O Postgres do Prisma não passa por `fetch`/`http`.
 */
installNoRealNetworkGuard();

afterAll(() => {
  const blocked = takeBlockedRequests();
  if (blocked.length > 0) {
    throw new Error(`Chamada de rede real durante o teste (bloqueada): ${[...new Set(blocked)].join(', ')}`);
  }
});
