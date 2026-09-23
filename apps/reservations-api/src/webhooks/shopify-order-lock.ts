import type { Prisma } from '@prisma/client';

/** Serializa, até o fim da transação, tudo que mexe no mesmo pedido Shopify:
 *  webhooks, reconciliação e as ações de painel do Valle Pass. A chave precisa
 *  ser idêntica em todos eles, por isso existe só aqui. */
export async function lockShopifyOrder(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'shopify-order:' + orderId}))`;
}
