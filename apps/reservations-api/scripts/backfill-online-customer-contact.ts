/**
 * Fase 11 — backfill único de nome/telefone/e-mail para reservas ONLINE
 * que já estão vinculadas a um pedido Shopify (`shopifyOrderId` gravado)
 * mas foram linkadas por uma versão anterior do código, que ainda não
 * capturava esses campos (ver webhooks.service.ts).
 *
 * Nunca chama a Shopify e nunca inventa dado: usa exclusivamente o
 * payload do webhook (`orders/create`/`orders/paid`) que este processo já
 * recebeu e gravou em `webhook_events` para o `shopifyOrderId` de cada
 * reserva — a mesma referência segura que webhooks.service.ts usa para
 * vincular o pedido. Reserva sem nenhum webhook de pedido armazenado é
 * apenas reportada, nunca inventada.
 *
 * Idempotente: só grava um campo que ainda está null; nunca sobrescreve
 * valor já existente. Seguro rodar mais de uma vez.
 *
 * Uso:
 *   pnpm --filter @valle/reservations-api exec tsx scripts/backfill-online-customer-contact.ts
 *   pnpm --filter @valle/reservations-api exec tsx scripts/backfill-online-customer-contact.ts --dry-run
 */
import { PrismaClient } from '@prisma/client';
import { extractCustomerEmail, extractCustomerName, extractCustomerPhone, type ShopifyOrderPayload } from '../src/webhooks/shopify-order-payload';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  const candidates = await prisma.reservation.findMany({
    where: {
      source: 'online',
      shopifyOrderId: { not: null },
      OR: [{ customerName: null }, { customerPhone: null }, { customerEmail: null }],
    },
    select: {
      id: true,
      originStoreId: true,
      shopifyOrderId: true,
      customerName: true,
      customerPhone: true,
      customerEmail: true,
    },
  });

  console.log(`Reservas online com contato incompleto: ${candidates.length}`);

  let updated = 0;
  let skippedNoPayload = 0;
  let skippedNothingToAdd = 0;

  for (const reservation of candidates) {
    const event = await prisma.webhookEvent.findFirst({
      where: {
        storeId: reservation.originStoreId,
        orderId: reservation.shopifyOrderId!,
        topic: { in: ['orders/create', 'orders/paid'] },
      },
      orderBy: { processedAt: 'desc' },
      select: { payload: true },
    });

    if (!event) {
      skippedNoPayload++;
      continue;
    }

    const order = event.payload as unknown as ShopifyOrderPayload;
    const patch: { customerName?: string; customerPhone?: string; customerEmail?: string } = {};

    if (!reservation.customerName) {
      const value = extractCustomerName(order);
      if (value) patch.customerName = value;
    }
    if (!reservation.customerPhone) {
      const value = extractCustomerPhone(order);
      if (value) patch.customerPhone = value;
    }
    if (!reservation.customerEmail) {
      const value = extractCustomerEmail(order);
      if (value) patch.customerEmail = value;
    }

    if (Object.keys(patch).length === 0) {
      skippedNothingToAdd++;
      continue;
    }

    console.log(`Reserva ${reservation.id}: gravando ${Object.keys(patch).join(', ')}`);
    if (!DRY_RUN) {
      await prisma.reservation.update({ where: { id: reservation.id }, data: patch });
    }
    updated++;
  }

  console.log(
    `${DRY_RUN ? '[dry-run] ' : ''}Concluído. Atualizadas: ${updated}. Sem webhook de pedido armazenado: ${skippedNoPayload}. ` +
      `Payload não trouxe nada de novo: ${skippedNothingToAdd}.`,
  );
}

main()
  .catch((e) => {
    console.error('Erro ao rodar o backfill de contato:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
