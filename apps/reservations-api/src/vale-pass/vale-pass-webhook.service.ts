import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { generateValePassCode } from './vale-pass-code';
import {
  extractCustomerEmail,
  extractCustomerName,
  extractCustomerPhone,
  extractOrderLineVariants,
  type ShopifyOrderPayload,
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
 * real, só configurável por variável de ambiente aqui também, pelo
 * mesmo motivo (pode mudar sem precisar de rebuild).
 */
function resolveKnownValePassVariantId(): string {
  const raw = process.env.VALE_PASS_VARIANT_ID?.trim() || '49174518595684';
  const match = raw.match(/(\d+)\s*$/);
  return match ? match[1] : raw;
}
const KNOWN_VALE_PASS_VARIANT_ID = resolveKnownValePassVariantId();

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
      }
    }

    return events;
  }

  /** Cancela (nunca apaga) qualquer vale ATIVO vinculado a este pedido
   *  — chamado tanto de `orders/cancelled` quanto de `refunds/create`.
   *  Vale já USADO nunca é revertido por aqui (o crédito já foi
   *  consumido); vale já CANCELLED é idempotente (nada a fazer). */
  async handleOrderCancelledOrRefunded(tx: Prisma.TransactionClient, orderId: string, reason: string): Promise<EventInput[]> {
    const active = await tx.valePass.findMany({ where: { shopifyOrderId: orderId, status: 'ACTIVE' } });
    if (active.length === 0) return [];

    const events: EventInput[] = [];
    for (const pass of active) {
      await tx.valePass.update({ where: { id: pass.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason } });
      await tx.valePassEvent.create({ data: { valePassId: pass.id, type: 'CANCELLED', detail: { orderId, reason } } });
      events.push({ type: 'VALE_PASS_CANCELLED', detail: { valePassId: pass.id, code: pass.code, orderId, reason } });
    }
    return events;
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
