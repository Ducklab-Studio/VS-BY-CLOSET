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

/**
 * Só para testes: vincula um administrador de TESTE às duas empresas (a política de produção exige vínculo para ADMIN e STAFF resgatarem). Os vínculos somem junto com
 * o usuário (ON DELETE CASCADE). Testes que provam a falta de vínculo NÃO chamam esta função.
 */
export async function grantAllCompaniesForTest(
  db: { valePassOperatorScope: { createMany(args: { data: { adminUserId: string; company: 'VALLE_SHOWROOM' | 'VS_BY_CLOSET'; grantedByName: string }[] }): Promise<unknown> } },
  adminUserId: string,
): Promise<void> {
  await db.valePassOperatorScope.createMany({
    data: (['VALLE_SHOWROOM', 'VS_BY_CLOSET'] as const).map((company) => ({ adminUserId, company, grantedByName: 'teste (vínculo automático)' })),
  });
}
