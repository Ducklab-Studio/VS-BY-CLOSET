/**
 * Emissão retroativa MANUAL de um voucher Valle Pass para um pedido que
 * foi pago ANTES de existir uma `ValePassCampaign` para sua variante —
 * ver `VALE_PASS_ORDER_WITHOUT_CAMPAIGN` em vale-pass-webhook.service.ts
 * (PR #32). O `WebhooksService` nunca reprocessa esse pedido sozinho
 * (idempotência por `shopifyWebhookId`), então este é o único caminho
 * pra fechar o caso — sempre disparado manualmente, nunca automático.
 *
 * Escopo travado num ÚNICO pedido por execução (`--order-id`
 * obrigatório): nunca varre a tabela inteira. Só lê o payload já
 * armazenado em `webhook_events` (nunca chama a Shopify de novo) —
 * mesma fonte seguraque webhooks.service.ts usa. Roda inteiro dentro de
 * uma única `$transaction`: ou emite exatamente um voucher, ou nada
 * muda.
 *
 * Dry-run por padrão (só mostra o que faria); passe --execute pra
 * gravar de verdade.
 *
 * Uso:
 *   pnpm --filter @valle/reservations-api exec tsx scripts/backfill-vale-pass-voucher.ts --order-id=6447185494116
 *   pnpm --filter @valle/reservations-api exec tsx scripts/backfill-vale-pass-voucher.ts --order-id=6447185494116 --execute
 */
import { PrismaClient } from '@prisma/client';
import { generateValePassCode } from '../src/vale-pass/vale-pass-code';
import { KNOWN_VALE_PASS_VARIANT_ID } from '../src/vale-pass/vale-pass-webhook.service';
import {
  extractCustomerEmail,
  extractCustomerName,
  extractCustomerPhone,
  extractOrderLineVariants,
  type ShopifyOrderPayload,
} from '../src/webhooks/shopify-order-payload';

const prisma = new PrismaClient();
const EXECUTE = process.argv.includes('--execute');

function arg(name: string): string | null {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function maskEmail(email: string | null): string {
  if (!email) return '(nenhum)';
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

async function main() {
  const orderId = arg('order-id');
  if (!orderId) {
    console.error('Uso obrigatório: --order-id=<shopify order id numérico>. Nenhum pedido foi processado.');
    process.exit(1);
  }

  console.log(`${EXECUTE ? '[EXECUTE]' : '[DRY-RUN]'} Backfill de voucher Valle Pass para orderId=${orderId}`);

  // 1) Já existe voucher pra este pedido? Idempotência antes de qualquer
  // outra checagem — nunca emite um segundo.
  const already = await prisma.valePass.findFirst({ where: { shopifyOrderId: orderId } });
  if (already) {
    console.log(`Já existe voucher ${already.code} (status ${already.status}) para o pedido ${orderId}. Nada a fazer — abortando.`);
    return;
  }

  // 2) Payload real do orders/paid armazenado para este pedido (nunca
  // chama a Shopify de novo, nunca aceita dado vindo de fora do banco).
  const paidEvent = await prisma.webhookEvent.findFirst({
    where: { orderId, topic: 'orders/paid' },
    orderBy: { processedAt: 'asc' },
  });
  if (!paidEvent) {
    console.error(`Nenhum webhook_event 'orders/paid' encontrado para orderId=${orderId}. Abortando — não há payload seguro pra basear a emissão.`);
    process.exit(1);
  }

  const order = paidEvent.payload as unknown as ShopifyOrderPayload;
  if (order.financial_status !== 'paid') {
    console.error(`Pedido ${orderId} tem financial_status="${order.financial_status}" (esperado "paid"). Abortando.`);
    process.exit(1);
  }

  // 3) Confirma que é REALMENTE a variante do Valle Pass (não qualquer
  // pedido de aluguel).
  const lines = extractOrderLineVariants(order);
  const matchingLine = lines.find((l) => l.variantId === KNOWN_VALE_PASS_VARIANT_ID);
  if (!matchingLine) {
    console.error(`Pedido ${orderId} não tem nenhuma linha da variante Valle Pass conhecida (${KNOWN_VALE_PASS_VARIANT_ID}). Abortando.`);
    process.exit(1);
  }
  if (matchingLine.quantity !== 1) {
    console.error(`Pedido ${orderId} comprou ${matchingLine.quantity} unidades — este script só emite pra quantidade=1 (o caso confirmado); revise manualmente antes de estender. Abortando.`);
    process.exit(1);
  }

  // 4) Campanha ATIVA atual para essa variante.
  const campaign = await prisma.valePassCampaign.findFirst({
    where: { shopifyVariantId: KNOWN_VALE_PASS_VARIANT_ID, active: true },
  });
  if (!campaign) {
    console.error(`Nenhuma ValePassCampaign ATIVA para a variante ${KNOWN_VALE_PASS_VARIANT_ID}. Abortando — configure a campanha antes de rodar este backfill.`);
    process.exit(1);
  }
  if (campaign.quantityLimit != null) {
    const issuedSoFar = await prisma.valePass.count({ where: { campaignId: campaign.id } });
    if (issuedSoFar >= campaign.quantityLimit) {
      console.error(`Campanha ${campaign.id} já atingiu o limite de ${campaign.quantityLimit} vales. Abortando.`);
      process.exit(1);
    }
  }

  // Preserva os dados ORIGINAIS do pedido — nunca inventa, nunca usa
  // dado de fora do payload armazenado.
  const customerName = extractCustomerName(order);
  const customerPhone = extractCustomerPhone(order);
  const customerEmail = extractCustomerEmail(order);
  const orderGid = order.admin_graphql_api_id;
  const orderName = order.name ?? null;

  // purchasedAt = quando ESTE sistema confirmou o pagamento (mesmo dado
  // que webhooks.service.ts já gravou em processedAt), não "agora" — pra
  // a validade do vale contar a partir da compra real, não do dia do
  // backfill.
  const purchasedAt = paidEvent.processedAt;
  const expiresAt = new Date(purchasedAt.getTime() + campaign.validityDays * 24 * 60 * 60 * 1000);
  const code = generateValePassCode();

  console.log('--- O que será gravado ---');
  console.log({
    orderId,
    orderName,
    campaignId: campaign.id,
    campaignName: campaign.name,
    amountCents: campaign.amountCents,
    code,
    purchasedAt,
    expiresAt,
    customerName,
    customerPhone: customerPhone ? '(presente)' : '(nenhum)',
    customerEmail: maskEmail(customerEmail),
  });

  if (!EXECUTE) {
    console.log('\n[DRY-RUN] Nada foi gravado. Rode de novo com --execute para aplicar.');
    return;
  }

  const created = await prisma.$transaction(async (tx) => {
    // Recheca idempotência DENTRO da transação (defesa contra corrida).
    const race = await tx.valePass.findFirst({ where: { shopifyOrderId: orderId } });
    if (race) throw new Error(`Voucher ${race.code} já foi criado por outra execução concorrente — abortando.`);

    const voucher = await tx.valePass.create({
      data: {
        code,
        campaignId: campaign.id,
        amountCents: campaign.amountCents,
        status: 'ACTIVE',
        purchasedAt,
        expiresAt,
        customerName,
        customerPhone,
        customerEmail,
        shopifyOrderId: orderId,
        shopifyOrderGid: orderGid,
        shopifyOrderName: orderName,
      },
    });

    await tx.valePassEvent.create({
      data: {
        valePassId: voucher.id,
        type: 'CREATED',
        detail: {
          orderId,
          campaignId: campaign.id,
          source: 'manual-backfill-script',
          script: 'scripts/backfill-vale-pass-voucher.ts',
          reason: 'Pedido pago antes de existir ValePassCampaign para a variante — ver VALE_PASS_ORDER_WITHOUT_CAMPAIGN (PR #32)',
          executedAt: new Date().toISOString(),
        },
      },
    });

    return voucher;
  });

  console.log(`\n[EXECUTE] Voucher ${created.code} criado (id=${created.id}, status=${created.status}) para o pedido ${orderId}.`);
}

main()
  .catch((e) => {
    console.error('Erro no backfill de voucher Valle Pass:', e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
