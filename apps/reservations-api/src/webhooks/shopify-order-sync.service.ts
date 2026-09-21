import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ARCHIVABLE_TERMINAL_STATUSES, OCCUPYING_RESERVATION_STATUSES } from '../reservation-status';
import { canTransition, type ReservationStatusValue } from './reservation-state-machine';

export type SyncOrigin = 'shopify_webhook' | 'shopify_reconciliation';

/** Estado comercial de um pedido Shopify, já normalizado. Webhook e Admin API
 *  viram o MESMO snapshot, então há uma única regra de negócio para os dois. */
export interface OrderSnapshot {
  readonly orderId: string;
  readonly updatedAt: Date | null;
  readonly cancelledAt: string | null;
  readonly closedAt: string | null;
  /** Minúsculo: paid, pending, voided, expired, refunded... */
  readonly financialStatus: string | null;
  readonly deleted?: boolean;
}

export interface SyncContext {
  readonly origin: SyncOrigin;
  readonly topic?: string;
  /** Só a reconciliação manual tem ator; vem SEMPRE da sessão validada. */
  readonly actor?: { readonly id: string; readonly name: string };
}

export interface SyncEvent {
  readonly type: string;
  readonly reservationId?: string;
  readonly detail?: Record<string, unknown>;
}

export interface SyncableReservation {
  readonly id: string;
  readonly status: string;
}

/** Peças que ainda não entraram no ciclo de devolução. */
const PRE_CYCLE_ITEM_STATUSES = new Set(['hold', 'pending_payment', 'confirmed']);
const isOccupying = (status: string) => (OCCUPYING_RESERVATION_STATUSES as readonly string[]).includes(status);
const isArchivable = (status: string) => (ARCHIVABLE_TERMINAL_STATUSES as readonly string[]).includes(status);

/**
 * Regras de sincronização Shopify → reserva, sempre dentro de uma
 * transação já aberta pelo chamador (que também toma o lock do pedido).
 *
 * Nunca apaga linha, nunca toca reserva manual, nunca aceita dado do cliente:
 * o pedido é localizado só pelo `shopifyOrderId` gravado no vínculo.
 */
@Injectable()
export class ShopifyOrderSyncService {
  /** Só reservas ONLINE: reserva manual nunca é alterada por evento Shopify. */
  findOnlineReservation(tx: Prisma.TransactionClient, orderId: string) {
    return tx.reservation.findFirst({ where: { shopifyOrderId: orderId, source: { not: 'manual_admin' } } });
  }

  /** Cancelamento vindo da Shopify. Peça ainda não recebida → `cancelled`;
   *  qualquer peça já no ciclo físico (ou reserva retirada) → `problem`, para
   *  revisão manual, sem liberar nada. `extra` entra no detalhe do evento de
   *  status; `auditExtra` (origem/tópico/pedido) no evento de auditoria. */
  async cancelForOrder(
    tx: Prisma.TransactionClient,
    reservation: SyncableReservation,
    events: SyncEvent[],
    extra: Record<string, unknown> = {},
    auditExtra: Record<string, unknown> = extra,
  ): Promise<void> {
    const from = reservation.status as ReservationStatusValue;
    if (from === 'cancelled' || !isOccupying(from)) return;

    const items = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM reservation_items WHERE reservation_id = ${reservation.id}::uuid FOR UPDATE
    `;
    const cycleStarted = items.some((item) => !PRE_CYCLE_ITEM_STATUSES.has(item.status));
    const to: ReservationStatusValue = !cycleStarted && canTransition(from, 'cancelled') ? 'cancelled' : canTransition(from, 'problem') ? 'problem' : from;
    if (to === from) return;

    const updated = await tx.reservation.updateMany({ where: { id: reservation.id, status: from }, data: { status: to } });
    if (updated.count !== 1) return;
    events.push({
      type: 'RESERVATION_STATUS_CHANGED',
      reservationId: reservation.id,
      detail: { from, to, ...(to === 'problem' ? { note: 'cancelamento chegou após a retirada — revisão manual' } : {}), ...extra },
    });
    events.push(auditEvent(reservation.id, to === 'cancelled' ? 'cancelled' : 'flagged_for_review', from, to, auditExtra));
  }

  /** Aplica o estado de um pedido a uma reserva ONLINE já vinculada. */
  async applySnapshot(tx: Prisma.TransactionClient, linked: SyncableReservation, snapshot: OrderSnapshot, ctx: SyncContext): Promise<SyncEvent[]> {
    const events: SyncEvent[] = [];
    const base: Record<string, unknown> = {
      origin: ctx.origin,
      orderId: snapshot.orderId,
      ...(ctx.topic ? { topic: ctx.topic } : {}),
      ...(ctx.actor ? { adminUserId: ctx.actor.id, adminUserName: ctx.actor.name } : {}),
    };

    await tx.$queryRaw`SELECT id FROM reservations WHERE id = ${linked.id}::uuid FOR UPDATE`;
    const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: linked.id } });

    if (reservation.source === 'manual_admin' || reservation.shopifyOrderId !== snapshot.orderId) {
      events.push({ type: 'ORDER_SYNC_SKIPPED', reservationId: reservation.id, detail: { ...base, reason: 'reserva não é online ou não pertence a este pedido' } });
      return events;
    }
    if (snapshot.updatedAt && reservation.shopifyOrderUpdatedAt && snapshot.updatedAt < reservation.shopifyOrderUpdatedAt) {
      events.push({ type: 'ORDER_SYNC_STALE', reservationId: reservation.id, detail: { ...base, reason: 'estado do pedido mais antigo que o já aplicado' } });
      return events;
    }

    if (snapshot.deleted || snapshot.cancelledAt) {
      events.push({
        type: snapshot.deleted ? 'ORDER_DELETED' : 'ORDER_CANCELLED',
        reservationId: reservation.id,
        detail: { ...base, ...(snapshot.deleted ? {} : { cancelledAt: snapshot.cancelledAt }) },
      });
      await this.cancelForOrder(tx, reservation, events, base);
    } else if (snapshot.financialStatus === 'voided' || snapshot.financialStatus === 'expired') {
      await this.handleFailedPayment(tx, reservation, snapshot.financialStatus, events, base);
    }

    if (snapshot.deleted || snapshot.closedAt) {
      await this.archiveIfTerminal(tx, reservation.id, snapshot.deleted ? 'Shopify: pedido excluído' : 'Shopify: pedido arquivado', events, base);
    }

    if (snapshot.updatedAt && (!reservation.shopifyOrderUpdatedAt || snapshot.updatedAt > reservation.shopifyOrderUpdatedAt)) {
      await tx.reservation.update({ where: { id: reservation.id }, data: { shopifyOrderUpdatedAt: snapshot.updatedAt } });
    }
    return events;
  }

  /** Pagamento falho/expirado: reserva aguardando pagamento → `expired`
   *  (libera a peça). Já confirmada → `problem`, nunca libera sozinha. */
  private async handleFailedPayment(
    tx: Prisma.TransactionClient,
    reservation: SyncableReservation,
    financialStatus: string,
    events: SyncEvent[],
    base: Record<string, unknown>,
  ): Promise<void> {
    const from = reservation.status as ReservationStatusValue;
    const to: ReservationStatusValue | null =
      from === 'pending_payment' ? 'expired' : from === 'confirmed' ? 'problem' : null;
    if (!to || !canTransition(from, to)) return;

    const updated = await tx.reservation.updateMany({ where: { id: reservation.id, status: from }, data: { status: to } });
    if (updated.count !== 1) return;
    const detail = { ...base, financialStatus, from, to };
    events.push({ type: 'RESERVATION_STATUS_CHANGED', reservationId: reservation.id, detail: { ...detail, note: 'pagamento falhou ou expirou na Shopify' } });
    events.push(auditEvent(reservation.id, to === 'expired' ? 'expired' : 'flagged_for_review', from, to, base));
  }

  /** Arquiva (nunca apaga) — só reserva terminal. Reserva ainda ativa fica
   *  como está e ganha um evento, para a reconciliação/equipe tratarem. */
  async archiveIfTerminal(tx: Prisma.TransactionClient, reservationId: string, reason: string, events: SyncEvent[], base: Record<string, unknown>): Promise<void> {
    const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: reservationId }, select: { status: true, archivedAt: true } });
    if (reservation.archivedAt) return;

    if (!isArchivable(reservation.status)) {
      events.push({ type: 'ORDER_ARCHIVE_SKIPPED', reservationId, detail: { ...base, reason: 'reserva ainda ativa ou em revisão', status: reservation.status } });
      return;
    }
    const restored = await tx.reservationEvent.count({ where: { reservationId, type: 'RESERVATION_RESTORED' } });
    if (restored > 0) {
      events.push({ type: 'ORDER_ARCHIVE_SKIPPED', reservationId, detail: { ...base, reason: 'reserva restaurada manualmente; arquivamento automático não repetido' } });
      return;
    }

    const updated = await tx.$executeRaw`
      UPDATE reservations SET archived_at = now(), archived_by = NULL, archive_reason = ${reason}
      WHERE id = ${reservationId}::uuid AND archived_at IS NULL
    `;
    if (updated !== 1) return;
    events.push({ type: 'RESERVATION_ARCHIVED', reservationId, detail: { ...base, reason, status: reservation.status } });
    events.push(auditEvent(reservationId, 'archived', reservation.status, reservation.status, base));
  }
}

/** Evento visível na tela de auditoria (tipo crítico, origem Shopify). */
function auditEvent(reservationId: string, action: string, from: string, to: string, base: Record<string, unknown>): SyncEvent {
  return { type: 'SHOPIFY_ORDER_SYNC', reservationId, detail: { source: 'SHOPIFY', ...base, action, from, to } };
}
