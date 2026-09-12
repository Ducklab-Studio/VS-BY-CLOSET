import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * A loja Shopify que toda reserva pertence. Hoje não existe nenhuma linha
 * em `stores` no banco de produção (confirmado consultando o Neon real
 * antes de escrever este arquivo — a tabela existe desde a Fase 1 mas
 * nunca foi populada com dado real, só fixtures de teste). Em vez de
 * inventar/gravar um domínio Shopify real numa migration (isso seria
 * fabricar dado de negócio, o oposto do fail-closed pedido), a loja vem
 * de variável de ambiente e a linha em `stores` é criada de forma
 * idempotente (upsert) dentro da própria transação de criação do HOLD —
 * ver HoldsService. Sem as duas variáveis configuradas, HOLD nenhum é
 * criado.
 */
export interface StoreConfig {
  readonly id: string;
  readonly shopifyDomain: string;
  readonly currency: string;
}

export function resolveStoreConfig(): StoreConfig {
  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN;
  const currency = process.env.SHOPIFY_STORE_CURRENCY;

  if (!shopifyDomain || !currency) {
    // Mesmo padrão de allowedOrigins()/currentTermsVersion(): fail closed
    // de verdade só em produção. Em dev/teste, sem as variáveis, cai num
    // valor prevísivel — isto não escreve nada na Shopify real, é só a
    // linha interna em `stores` que toda Reservation precisa referenciar.
    if (process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException('Loja não configurada — não é possível criar reserva no momento.');
    }
    // BRL — moeda definitiva do checkout (cliente brasileiro, paga em
    // BRL; a retirada em loja no Chile é só logística, não define a
    // moeda). Ver mercadopago.service.ts.
    return { id: 'dev-store', shopifyDomain: 'dev-store.myshopify.com', currency: 'BRL' };
  }

  // O próprio domínio como id: é único por natureza, e evita inventar um
  // identificador arbitrário separado pra algo que já É um identificador.
  return { id: shopifyDomain, shopifyDomain, currency };
}

/** Handles concurrent first use across HOLD, manual and webhook transactions. */
export async function ensureStoreConfig(tx: Prisma.TransactionClient, store: StoreConfig): Promise<void> {
  await tx.store.createMany({
    skipDuplicates: true,
    data: [{ id: store.id, shopifyDomain: store.shopifyDomain, currency: store.currency }],
  });
  const persisted = await tx.store.findUnique({ where: { id: store.id } });
  if (!persisted) throw new ServiceUnavailableException('Configuração da loja ausente no banco.');
  if (persisted.shopifyDomain !== store.shopifyDomain) throw new ServiceUnavailableException('Domínio da loja diverge do banco.');
  if (persisted.currency !== store.currency) throw new ServiceUnavailableException('Moeda da loja diverge do banco.');
}
