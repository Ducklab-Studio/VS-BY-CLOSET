import type { Prisma, ValePassOrder } from '@prisma/client';
import { canReplaceValePassOrderStatus, compareFreshness, deriveValePassOrderStatus } from './vale-pass-order-status';

/** Estado de um pedido com Valle Pass, já normalizado — webhook e Admin API
 *  viram o MESMO snapshot, então há uma única regra para os dois. */
export interface ValePassOrderSnapshot {
  readonly orderId: string;
  readonly orderGid: string | null;
  readonly orderName: string | null;
  readonly financialStatus: string | null;
  readonly cancelledAt: string | null;
  readonly cancelReason: string | null;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
  /** Unidades de Valle Pass (> 0 — só pedido de Valle Pass chega aqui). */
  readonly quantity: number;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly customerEmail: string | null;
}

export interface ValePassOrderEventInput {
  readonly type: string;
  readonly detail?: Record<string, unknown>;
}

export interface ValePassOrderApplyResult {
  readonly order: ValePassOrder;
  readonly events: ValePassOrderEventInput[];
  readonly created: boolean;
  readonly statusChanged: boolean;
  readonly stale: boolean;
}

/**
 * Registro dos pedidos com Valle Pass (tabela `vale_pass_orders`). Sempre
 * dentro de uma transação em que o chamador JÁ tomou `lockShopifyOrder` do
 * pedido — webhook e reconciliação usam o mesmo lock, então nunca há duas
 * escritas simultâneas do mesmo pedido; `shopify_order_id` único é o
 * backstop. Nunca apaga linha, nunca toca reserva/HOLD/peça.
 */
export class ValePassOrderRegistry {
  async apply(tx: Prisma.TransactionClient, snapshot: ValePassOrderSnapshot, source: string): Promise<ValePassOrderApplyResult> {
    const target = deriveValePassOrderStatus(snapshot);
    const financialStatus = snapshot.financialStatus?.trim().toLowerCase() || null;
    const cancelReason = snapshot.cancelledAt ? snapshot.cancelReason?.trim().toLowerCase() || null : null;
    const base = { orderId: snapshot.orderId, source };

    const existing = await tx.valePassOrder.findUnique({ where: { shopifyOrderId: snapshot.orderId } });
    if (!existing) {
      const order = await tx.valePassOrder.create({
        data: {
          shopifyOrderId: snapshot.orderId,
          shopifyOrderGid: snapshot.orderGid,
          shopifyOrderName: snapshot.orderName,
          status: target,
          financialStatus,
          cancelReason,
          quantity: snapshot.quantity,
          customerName: snapshot.customerName,
          customerPhone: snapshot.customerPhone,
          customerEmail: snapshot.customerEmail,
          orderCreatedAt: snapshot.createdAt,
          shopifyUpdatedAt: snapshot.updatedAt,
          lastSyncSource: source,
        },
      });
      await this.log(tx, order.id, 'REGISTERED', { ...base, status: target, financialStatus });
      return { order, created: true, statusChanged: false, stale: false, events: [{ type: 'VALE_PASS_ORDER_REGISTERED', detail: { ...base, status: target } }] };
    }

    const freshness = compareFreshness(existing.shopifyUpdatedAt, snapshot.updatedAt);
    if (freshness === 'older') {
      // Webhook atrasado/fora de ordem: nada que já foi aplicado é desfeito.
      return {
        order: existing,
        created: false,
        statusChanged: false,
        stale: true,
        events: [{ type: 'VALE_PASS_ORDER_SYNC_STALE', detail: { ...base, status: existing.status, ignoredStatus: target } }],
      };
    }

    const statusChanged = canReplaceValePassOrderStatus(existing.status, target, freshness);
    const sameState = statusChanged || (target === existing.status && freshness !== 'same');
    const data: Prisma.ValePassOrderUpdateInput = {};
    if (statusChanged) {
      data.status = target;
      data.statusChangedAt = new Date();
    }
    if (sameState && financialStatus !== existing.financialStatus) data.financialStatus = financialStatus;
    if (sameState && cancelReason !== existing.cancelReason) data.cancelReason = cancelReason;
    if (!existing.shopifyOrderGid && snapshot.orderGid) data.shopifyOrderGid = snapshot.orderGid;
    if (!existing.shopifyOrderName && snapshot.orderName) data.shopifyOrderName = snapshot.orderName;
    if (!existing.orderCreatedAt && snapshot.createdAt) data.orderCreatedAt = snapshot.createdAt;
    if (snapshot.quantity > 0 && snapshot.quantity !== existing.quantity) data.quantity = snapshot.quantity;
    // Cliente: a Shopify é a fonte; valor novo e não vazio substitui, vazio nunca apaga.
    if (snapshot.customerName && snapshot.customerName !== existing.customerName) data.customerName = snapshot.customerName;
    if (snapshot.customerPhone && snapshot.customerPhone !== existing.customerPhone) data.customerPhone = snapshot.customerPhone;
    if (snapshot.customerEmail && snapshot.customerEmail !== existing.customerEmail) data.customerEmail = snapshot.customerEmail;
    if (snapshot.updatedAt && freshness !== 'same') data.shopifyUpdatedAt = snapshot.updatedAt;

    if (Object.keys(data).length === 0) {
      return { order: existing, created: false, statusChanged: false, stale: false, events: [{ type: 'VALE_PASS_ORDER_SYNCED', detail: { ...base, status: existing.status, changed: false } }] };
    }
    data.lastSyncSource = source;
    const order = await tx.valePassOrder.update({ where: { id: existing.id }, data });
    if (!statusChanged) {
      return { order, created: false, statusChanged: false, stale: false, events: [{ type: 'VALE_PASS_ORDER_SYNCED', detail: { ...base, status: order.status, changed: true } }] };
    }
    const detail = { ...base, from: existing.status, to: target, financialStatus };
    await this.log(tx, order.id, 'STATUS_CHANGED', detail);
    return { order, created: false, statusChanged: true, stale: false, events: [{ type: 'VALE_PASS_ORDER_STATUS_CHANGED', detail }] };
  }

  /** `refunds/create` só traz o id do pedido: pedido confirmado passa a
   *  REFUNDED; em qualquer outro status só registra (o `orders/updated` que
   *  acompanha o reembolso traz o estado completo). */
  async markRefunded(tx: Prisma.TransactionClient, orderId: string, source: string): Promise<ValePassOrderEventInput[]> {
    const existing = await tx.valePassOrder.findUnique({ where: { shopifyOrderId: orderId } });
    if (!existing) return [];
    if (existing.status !== 'CONFIRMED') return [{ type: 'VALE_PASS_ORDER_SYNCED', detail: { orderId, source, status: existing.status, changed: false } }];
    await tx.valePassOrder.update({ where: { id: existing.id }, data: { status: 'REFUNDED', statusChangedAt: new Date(), lastSyncSource: source } });
    const detail = { orderId, source, from: existing.status, to: 'REFUNDED' };
    await this.log(tx, existing.id, 'STATUS_CHANGED', detail);
    return [{ type: 'VALE_PASS_ORDER_STATUS_CHANGED', detail }];
  }

  /** Pedido excluído na Shopify: a linha e o histórico ficam. Pendente vira
   *  CANCELLED (não há mais o que pagar); pago/final mantém o status. */
  async markDeleted(tx: Prisma.TransactionClient, orderId: string, source: string): Promise<ValePassOrderEventInput[]> {
    const existing = await tx.valePassOrder.findUnique({ where: { shopifyOrderId: orderId } });
    if (!existing || existing.deletedInShopifyAt) return [];
    const toCancel = existing.status === 'PENDING';
    await tx.valePassOrder.update({
      where: { id: existing.id },
      data: {
        deletedInShopifyAt: new Date(),
        lastSyncSource: source,
        ...(toCancel ? { status: 'CANCELLED' as const, cancelReason: 'deleted_in_shopify', statusChangedAt: new Date() } : {}),
      },
    });
    const detail = { orderId, source, status: existing.status, ...(toCancel ? { from: 'PENDING', to: 'CANCELLED' } : {}) };
    await this.log(tx, existing.id, 'DELETED_IN_SHOPIFY', detail);
    return [{ type: 'VALE_PASS_ORDER_DELETED_IN_SHOPIFY', detail }];
  }

  /** Pagamento confirmado passou pela emissão de vales — uma vez só. O
   *  histórico guarda o resultado (tipos de evento), nunca o código do vale. */
  async markVouchersProcessed(tx: Prisma.TransactionClient, id: string, source: string, outcome: readonly ValePassOrderEventInput[]): Promise<void> {
    const updated = await tx.valePassOrder.updateMany({ where: { id, vouchersProcessedAt: null }, data: { vouchersProcessedAt: new Date() } });
    if (updated.count !== 1) return;
    const issued = outcome.filter((event) => event.type === 'VALE_PASS_CREATED').length;
    await this.log(tx, id, 'VOUCHERS_PROCESSED', { source, issued, outcome: [...new Set(outcome.map((event) => event.type))] });
  }

  private async log(tx: Prisma.TransactionClient, valePassOrderId: string, type: string, detail: Record<string, unknown>): Promise<void> {
    await tx.valePassOrderEvent.create({ data: { valePassOrderId, type, detail: detail as Prisma.InputJsonValue } });
  }
}
