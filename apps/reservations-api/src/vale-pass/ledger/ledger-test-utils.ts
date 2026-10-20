import type { Prisma } from '@prisma/client';

/**
 * Só para testes: apaga lançamentos do livro-razão (que em produção é imutável) para que a limpeza de vouchers de teste não esbarre na FK.
 * Exige `session_replication_role = replica` na transação (como as demais limpezas de trilhas imutáveis dos testes).
 */
export async function purgeLedgerForTest(tx: Prisma.TransactionClient, where: { voucherIds?: readonly string[]; campaignIds?: readonly string[]; orderIds?: readonly string[] }): Promise<void> {
  await tx.$executeRawUnsafe('SET LOCAL session_replication_role = replica');
  const voucherIds = where.voucherIds ?? [];
  const campaignIds = where.campaignIds ?? [];
  const orderIds = where.orderIds ?? [];
  await tx.$executeRaw`DELETE FROM vale_pass_block_events WHERE vale_pass_id IN (
    SELECT id FROM vale_passes WHERE id = ANY(${voucherIds as string[]}::uuid[]) OR campaign_id = ANY(${campaignIds as string[]}::uuid[]) OR shopify_order_id = ANY(${orderIds as string[]}::text[]))`;
  await tx.$executeRaw`DELETE FROM vale_pass_ledger_entries WHERE vale_pass_id IN (
    SELECT id FROM vale_passes WHERE id = ANY(${voucherIds as string[]}::uuid[]) OR campaign_id = ANY(${campaignIds as string[]}::uuid[]) OR shopify_order_id = ANY(${orderIds as string[]}::text[]))`;
}
