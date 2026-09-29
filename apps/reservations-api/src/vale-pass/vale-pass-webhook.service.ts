import { Injectable, Logger } from '@nestjs/common';
import type { Prisma, ValePass, ValePassOrder } from '@prisma/client';
import { generateValePassCode } from './vale-pass-code';
import { KNOWN_VALE_PASS_VARIANT_ID, valePassUnits } from './vale-pass-order-status';
import { ValePassOrderRegistry, type ValePassOrderSnapshot } from './vale-pass-order-registry';
import {
  extractCustomerEmail,
  extractCustomerName,
  extractCustomerPhone,
  extractOrderLineVariants,
  type ShopifyOrderPayload,
  type ShopifyRefundPayload,
} from '../webhooks/shopify-order-payload';

interface EventInput {
  readonly type: string;
  readonly detail?: Record<string, unknown>;
}

/**
 * Achado real de produção (pedido #1002, pago, 15/09): a variante REAL
 * do Valle Pass já estava comprável na Shopify dois dias antes de
 * qualquer `ValePassCampaign` existir no banco — o pedido pago caiu no
 * "sem campanha = no-op silencioso" de
 * baixo, indistinguível de 100% dos pedidos de aluguel normais (que
 * também não têm nenhuma linha batendo com nenhuma campanha). O
 * pagamento ficou sem NENHUM rastro para revisão manual.
 *
 * Mesmo ID hardcoded como default no frontend
 * (apps/marketing/src/lib/vale-pass-product.ts) — é o MESMO produto
 * real, só configurável por variável de ambiente (VALE_PASS_VARIANT_ID).
 * Resolvido em vale-pass-order-status.ts; reexportado aqui para
 * scripts/backfill-vale-pass-voucher.ts continuar usando a MESMA resolução.
 */
export { KNOWN_VALE_PASS_VARIANT_ID };

/**
 * Valle Pass é um produto TOTALMENTE separado do fluxo de aluguel —
 * este service nunca lê/grava RentalUnit, Reservation, disponibilidade
 * ou HOLD, e é chamado pelo WebhooksService como um passo ADICIONAL
 * (nunca substitui `handleOrderPaidOrCreated`; o fluxo de reserva
 * continua rodando exatamente igual, orders com Valle Pass mas sem
 * `reservation_id` já caem em `ignored` no branch de reserva como
 * sempre caíram).
 *
 * Correlação por `variant_id` das line items (não por note_attribute):
 * um pedido de Valle Pass puro nunca teria `reservation_id` mesmo. Só
 * gera vale quando o pedido está de fato pago (`orders/paid` +
 * `financial_status === 'paid'`) — nunca em `orders/create`, pra nunca
 * emitir um código resgatável antes do pagamento confirmar.
 *
 * Limitação conhecida e aceita: carrinho MISTO (reserva de aluguel +
 * Valle Pass no mesmo pedido) não é suportado — o endurecimento de
 * correlação de reserva já existente (fingerprint exato das linhas do
 * pedido) rejeitaria como LINE_ITEMS_MISMATCH se houvesse uma linha
 * extra de Valle Pass. Alterar essa lógica está fora do escopo deste
 * pedido ("não alterar o fluxo atual de reservas"); Valle Pass deve
 * ser vendido em checkout separado.
 */
@Injectable()
export class ValePassWebhookService {
  private readonly logger = new Logger(ValePassWebhookService.name);
  readonly orders = new ValePassOrderRegistry();

  /**
   * Registro do PEDIDO de Valle Pass (tabela `vale_pass_orders`), para todos
   * os tópicos de pedido — é o que faz um pedido pendente, expirado,
   * cancelado ou recusado aparecer no ClosetAdmin, e não só o pago. Mesma
   * transação e mesmo lock de pedido do WebhooksService. Pedido sem linha de
   * Valle Pass (aluguel, outros produtos) devolve `[]` e nada é gravado.
   *
   * O vale continua nascendo só com pagamento confirmado: `orders/paid` pago
   * (regra de sempre) ou, se esse webhook se perdeu, o `orders/updated` que
   * mostra o pedido pago. `orders/create` nunca emite vale.
   */
  async handleOrderWebhook(tx: Prisma.TransactionClient, topic: string, payload: unknown): Promise<EventInput[]> {
    const source = `webhook:${topic}`;
    switch (topic) {
      case 'refunds/create':
        return this.orders.markRefunded(tx, String((payload as ShopifyRefundPayload).order_id), source);
      case 'orders/delete':
        return this.orders.markDeleted(tx, String((payload as { id: number | string }).id), source);
      case 'orders/create':
      case 'orders/paid':
      case 'orders/updated':
      case 'orders/cancelled':
        break;
      default:
        return [];
    }

    const order = payload as ShopifyOrderPayload;
    const quantity = await this.valePassQuantity(tx, order);
    if (quantity === 0) return [];
    const result = await this.orders.apply(tx, snapshotFromPayload(order, quantity), source);
    const events: EventInput[] = [...result.events];

    if (topic === 'orders/paid' && order.financial_status === 'paid' && (result.order.status === 'EXPIRED' || result.order.status === 'DECLINED')) {
      // `orders/paid` mais antigo que a expiração/recusa já aplicada (webhook
      // atrasado): pedido expirado não fica confirmado nem ganha vale ativo.
      events.push({ type: 'VALE_PASS_PAYMENT_NOT_APPLIED', detail: { orderId: result.order.shopifyOrderId, status: result.order.status, reason: 'estado mais recente do pedido é expirado/recusado' } });
    } else if (topic === 'orders/paid' && order.financial_status === 'paid') {
      const issued = await this.handleOrderPaid(tx, order);
      events.push(...issued);
      await this.orders.markVouchersProcessed(tx, result.order.id, source, issued);
    } else if (topic === 'orders/updated') {
      events.push(...(await this.issueForConfirmedOrder(tx, result.order, order, source)));
    }
    return events;
  }

  /** Pedido CONFIRMADO cujo pagamento ainda não passou pela emissão (o
   *  `orders/paid` se perdeu ou ainda não chegou). Idempotente: `handleOrderPaid`
   *  não emite de novo para um pedido que já tem vale. */
  async issueForConfirmedOrder(tx: Prisma.TransactionClient, order: ValePassOrder, payload: ShopifyOrderPayload, source: string): Promise<EventInput[]> {
    if (order.status !== 'CONFIRMED' || order.vouchersProcessedAt) return [];
    const issued = await this.handleOrderPaid(tx, payload);
    await this.orders.markVouchersProcessed(tx, order.id, source, issued);
    return [
      { type: 'VALE_PASS_PAYMENT_RECOVERED', detail: { orderId: order.shopifyOrderId, source, note: 'pagamento confirmado processado fora do orders/paid (webhook perdido ou fora de ordem)' } },
      ...issued,
    ];
  }

  /** Unidades de Valle Pass no pedido (produto/variante conhecidos ou variante de campanha). */
  async valePassQuantity(tx: Prisma.TransactionClient, order: Pick<ShopifyOrderPayload, 'line_items'>): Promise<number> {
    const lines = (order.line_items ?? []).map((line) => ({
      variantId: line.variant_id,
      productId: line.product_id,
      quantity: typeof line.quantity === 'number' ? line.quantity : 0,
    }));
    if (lines.length === 0) return 0;
    const campaigns = await tx.valePassCampaign.findMany({ select: { shopifyVariantId: true } });
    return valePassUnits(lines, campaigns.map((c) => c.shopifyVariantId));
  }

  /** Chamado de dentro da MESMA transação/lock do webhook (mesmo `tx`
   *  do WebhooksService) — nunca abre transação própria. Devolve `[]`
   *  (no-op silencioso) quando o pedido não contém nenhuma linha de
   *  Valle Pass, que é o caso normal pra 100% dos pedidos de aluguel. */
  async handleOrderPaid(tx: Prisma.TransactionClient, order: ShopifyOrderPayload): Promise<EventInput[]> {
    const lines = extractOrderLineVariants(order);
    if (lines.length === 0) return [];

    const variantIds = [...new Set(lines.map((l) => l.variantId))];
    const campaigns = await tx.valePassCampaign.findMany({ where: { shopifyVariantId: { in: variantIds } } });
    const orderId = String(order.id);

    if (campaigns.length === 0) {
      // Pedido PAGO cuja variante bate com o Valle Pass conhecido, mas
      // nenhuma campanha existe pra ela agora — sinaliza pra revisão
      // manual em vez de desaparecer sem rastro (ver comentário de
      // KNOWN_VALE_PASS_VARIANT_ID acima). Nunca cria vale aqui: só
      // torna o caso visível, quem decide é uma pessoa.
      if (variantIds.includes(KNOWN_VALE_PASS_VARIANT_ID)) {
        this.logger.error(`Pedido ${orderId} pago com a variante conhecida do Valle Pass (${KNOWN_VALE_PASS_VARIANT_ID}), mas nenhuma ValePassCampaign existe para ela — nenhum vale foi emitido.`);
        return [{
          type: 'VALE_PASS_ORDER_WITHOUT_CAMPAIGN',
          detail: { orderId, variantId: KNOWN_VALE_PASS_VARIANT_ID, reason: 'pedido pago da variante do Valle Pass sem nenhuma campanha cadastrada — revisão manual necessária, nenhum vale foi criado automaticamente' },
        }];
      }
      return [];
    }

    // Idempotência (defesa em profundidade — o lock por orderId do
    // WebhooksService já serializa reentregas, mas nunca custa checar):
    // se este pedido já emitiu algum vale, não emite de novo.
    const already = await tx.valePass.findFirst({ where: { shopifyOrderId: orderId } });
    if (already) return [{ type: 'VALE_PASS_ALREADY_ISSUED', detail: { orderId } }];

    // `orders/paid` reentregue DEPOIS do cancelamento/reembolso: o vale é
    // emitido e cancelado na mesma transação — mesmo estado final da ordem
    // normal (emitido, depois cancelado pela Shopify), nunca um crédito ativo.
    const priorCancellation = await tx.valePassOrderCancellation.findUnique({ where: { shopifyOrderId: orderId } });

    const orderGid = order.admin_graphql_api_id;
    const orderName = order.name ?? null;
    const customerName = extractCustomerName(order);
    const customerPhone = extractCustomerPhone(order);
    const customerEmail = extractCustomerEmail(order);

    const events: EventInput[] = [];
    for (const line of lines) {
      const campaign = campaigns.find((c) => c.shopifyVariantId === line.variantId);
      if (!campaign) continue;

      for (let i = 0; i < line.quantity; i++) {
        if (campaign.quantityLimit != null) {
          const issuedSoFar = await tx.valePass.count({ where: { campaignId: campaign.id } });
          if (issuedSoFar >= campaign.quantityLimit) {
            this.logger.error(`Campanha ${campaign.id} atingiu o limite de quantidade — pedido ${orderId} recebeu menos vales do que comprou`);
            events.push({ type: 'VALE_PASS_QUANTITY_LIMIT_REACHED', detail: { campaignId: campaign.id, orderId } });
            continue;
          }
        }

        const code = await this.generateUniqueCode(tx);
        const purchasedAt = new Date();
        const expiresAt = new Date(purchasedAt.getTime() + campaign.validityDays * 24 * 60 * 60 * 1000);

        const created = await tx.valePass.create({
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
          data: { valePassId: created.id, type: 'CREATED', detail: { orderId, campaignId: campaign.id } },
        });
        events.push({ type: 'VALE_PASS_CREATED', detail: { valePassId: created.id, code: created.code, campaignId: campaign.id, orderId } });

        if (priorCancellation) {
          const cancelled = await this.cancelByShopify(tx, created, orderId, priorCancellation.topic, 'pedido já confirmado como cancelado/reembolsado antes da emissão');
          if (cancelled) events.push(cancelled);
        }
      }
    }

    return events;
  }

  /**
   * Chamado de `orders/cancelled`, `orders/updated` (com `cancelled_at`) e
   * `refunds/create`, dentro da transação/lock do pedido do WebhooksService.
   *
   * 1. Registra o cancelamento/reembolso do PEDIDO, independente do status
   *    dos vales — é isso que bloqueia restauração mesmo quando um admin já
   *    tinha cancelado o vale antes do webhook chegar.
   * 2. Vale ACTIVE → CANCELLED (origem Shopify, `cancelledBy` nulo).
   * 3. Vale já CANCELLED/USED/EXPIRED: status e campos de cancelamento
   *    intactos (o cancelamento manual continua sendo o que foi); só ganha
   *    um evento SHOPIFY_ORDER_CANCELLED no histórico, uma vez por pedido.
   *
   * Idempotente: reentrega ou segundo tópico do mesmo pedido não duplica
   * registro nem eventos.
   */
  async handleOrderCancelledOrRefunded(tx: Prisma.TransactionClient, orderId: string, topic: string): Promise<EventInput[]> {
    const recorded = await tx.valePassOrderCancellation.createMany({ data: [{ shopifyOrderId: orderId, topic }], skipDuplicates: true });
    const firstConfirmation = recorded.count === 1;

    const passes = await tx.valePass.findMany({ where: { shopifyOrderId: orderId }, orderBy: { createdAt: 'asc' } });
    const events: EventInput[] = [];
    for (const pass of passes) {
      if (pass.status === 'ACTIVE') {
        const cancelled = await this.cancelByShopify(tx, pass, orderId, topic);
        if (cancelled) events.push(cancelled);
      } else if (firstConfirmation) {
        await tx.valePassEvent.create({
          data: { valePassId: pass.id, type: 'SHOPIFY_ORDER_CANCELLED', detail: { orderId, topic, source: 'shopify', statusAtConfirmation: pass.status } },
        });
        events.push({ type: 'VALE_PASS_SHOPIFY_ORDER_CANCELLED', detail: { valePassId: pass.id, code: pass.code, orderId, topic, status: pass.status } });
      }
    }
    return events;
  }

  private async cancelByShopify(tx: Prisma.TransactionClient, pass: ValePass, orderId: string, topic: string, note?: string): Promise<EventInput | null> {
    const changed = await tx.valePass.updateMany({
      where: { id: pass.id, status: 'ACTIVE' },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: null, cancelReason: topic },
    });
    if (changed.count !== 1) return null;
    await tx.valePassEvent.create({ data: { valePassId: pass.id, type: 'CANCELLED', detail: { orderId, reason: topic, source: 'shopify', ...(note ? { note } : {}) } } });
    return { type: 'VALE_PASS_CANCELLED', detail: { valePassId: pass.id, code: pass.code, orderId, reason: topic } };
  }

  private async generateUniqueCode(tx: Prisma.TransactionClient): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateValePassCode();
      const existing = await tx.valePass.findUnique({ where: { code }, select: { id: true } });
      if (!existing) return code;
    }
    throw new Error('Não foi possível gerar um código único para o Valle Pass após 5 tentativas.');
  }
}

function parseDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Payload REST do webhook → snapshot do registro de pedidos. */
export function snapshotFromPayload(order: ShopifyOrderPayload, quantity: number): ValePassOrderSnapshot {
  return {
    orderId: String(order.id),
    orderGid: order.admin_graphql_api_id ?? null,
    orderName: order.name ?? null,
    financialStatus: order.financial_status ?? null,
    cancelledAt: order.cancelled_at ?? null,
    cancelReason: order.cancel_reason ?? null,
    createdAt: parseDate(order.created_at),
    updatedAt: parseDate(order.updated_at),
    quantity,
    customerName: extractCustomerName(order),
    customerPhone: extractCustomerPhone(order),
    customerEmail: extractCustomerEmail(order),
  };
}
