import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveStoreConfig } from '../holds/store-config';
import { resolveReservationBindingSecret } from '../checkout/checkout.config';
import { canonicalItemsFingerprint, verifyReservationSignature } from '../reservation-binding';
import { OCCUPYING_RESERVATION_STATUSES } from '../reservation-status';
import { civilDateFromPgDate, civilDateToISO } from '../rental-rules/civil-date';
import { canTransition, type ReservationStatusValue } from './reservation-state-machine';
import {
  extractNoteAttribute,
  extractOrderLineVariants,
  extractReservationId,
  sumRefundAmount,
  type ShopifyOrderPayload,
  type ShopifyRefundPayload,
} from './shopify-order-payload';

/**
 * Orquestra os 4 tópicos de webhook desta fase. Ver o relatório final
 * pra íntegra do desenho; resumo pra quem está lendo o código:
 *
 *  1. `pg_advisory_xact_lock(hashtext(shopifyWebhookId))` serializa
 *     qualquer entrega concorrente do MESMO evento — nada de duas
 *     tentativas processando o mesmo webhook ao mesmo tempo.
 *  2. Duplicata (mesmo shopifyWebhookId já `processed`/`ignored`) →
 *     devolve sucesso idempotente sem reprocessar. Se estava `failed`,
 *     reprocessa (é exatamente pra isso que o retry da Shopify serve).
 *  3. Toda transição de status passa por `canTransition` — nenhuma
 *     escrita de status fora da máquina de estados centralizada.
 *  4. Se algo lançar no meio, a transação INTEIRA (WebhookEvent,
 *     Reservation, ReservationEvent) dá rollback — nunca fica marcado
 *     como `processed` um evento que na verdade falhou (item 15).
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(private readonly prisma: PrismaService) {}

  async handleIncoming(input: { topic: string; shopifyWebhookId: string; payload: unknown }): Promise<{ outcome: 'processed' | 'ignored' | 'duplicate' }> {
    try {
      return await this.processWebhook(input);
    } catch (err) {
      this.logger.error(`Falha ao processar webhook ${input.topic}: ${errorCode(err)}`);
      await this.bestEffortRecordFailure(input, err);
      // 503, não 200 — a Shopify precisa reentregar (item 16 da Fase 7:
      // "não fingir sucesso caso isso faça a Shopify parar de reenviar").
      throw new ServiceUnavailableException('Não foi possível processar o webhook no momento.');
    }
  }

  private async processWebhook(input: { topic: string; shopifyWebhookId: string; payload: unknown }): Promise<{ outcome: 'processed' | 'ignored' | 'duplicate' }> {
    const store = resolveStoreConfig();

    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.shopifyWebhookId}))`;

        await tx.store.upsert({ where: { id: store.id }, update: {}, create: { id: store.id, shopifyDomain: store.shopifyDomain, currency: store.currency } });

        const existing = await tx.webhookEvent.findUnique({ where: { shopifyWebhookId: input.shopifyWebhookId } });
        if (existing && existing.status !== 'failed') {
          await tx.webhookEvent.update({ where: { id: existing.id }, data: { attemptCount: { increment: 1 } } });
          return { outcome: 'duplicate' as const };
        }

        const result = await this.dispatch(tx, input.topic, input.payload);

        const jsonPayload = input.payload as Prisma.InputJsonValue;
        let webhookEventId: string;
        if (existing) {
          const updated = await tx.webhookEvent.update({
            where: { id: existing.id },
            data: {
              status: result.status,
              payload: jsonPayload,
              reservationId: result.reservationId ?? null,
              orderId: result.orderId ?? null,
              errorMessage: null,
              attemptCount: { increment: 1 },
              processedAt: new Date(),
            },
          });
          webhookEventId = updated.id;
        } else {
          const created = await tx.webhookEvent.create({
            data: {
              shopifyWebhookId: input.shopifyWebhookId,
              storeId: store.id,
              topic: input.topic,
              payload: jsonPayload,
              status: result.status,
              reservationId: result.reservationId ?? null,
              orderId: result.orderId ?? null,
            },
          });
          webhookEventId = created.id;
        }

        for (const ev of result.events) {
          await tx.reservationEvent.create({
            data: {
              reservationId: ev.reservationId ?? null,
              webhookEventId,
              type: ev.type,
              detail: (ev.detail as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
            },
          });
        }

        return { outcome: result.status === 'ignored' ? ('ignored' as const) : ('processed' as const) };
      },
      { timeout: 15_000, maxWait: 5_000 },
    );
  }

  private async dispatch(tx: Prisma.TransactionClient, topic: string, payload: unknown): Promise<DispatchResult> {
    switch (topic) {
      case 'orders/create':
      case 'orders/paid':
        return this.handleOrderPaidOrCreated(tx, payload as ShopifyOrderPayload, topic);
      case 'orders/cancelled':
        return this.handleOrderCancelled(tx, payload as ShopifyOrderPayload);
      case 'refunds/create':
        return this.handleRefundCreated(tx, payload as ShopifyRefundPayload);
      default:
        return { status: 'ignored', events: [{ type: 'WEBHOOK_RECEIVED', detail: { topic, note: 'tópico não tratado por esta fase' } }] };
    }
  }

  // ── orders/create, orders/paid ──────────────────────────────────
  //
  // Endurecimento (pedido antes de continuar a Fase 7): reservation_id
  // sozinho como atributo de cart não é prova suficiente — atributos de
  // cart são alteráveis via Storefront API (cartAttributesUpdate)
  // enquanto o cart existe. A partir do momento em que a Reservation é
  // encontrada, TODA falha de correlação (assinatura, linhas, estado do
  // checkout, pedido duplicado) vira `problem` — nunca `ignored`
  // silencioso: alguém está tentando vincular um pedido real a ESTA
  // reserva e algo não bate, isso merece revisão humana, não um log
  // mudo. `ignored` só continua valendo pros dois casos SEM reserva
  // real identificada (sem correlação nenhuma pra flagar).
  private async handleOrderPaidOrCreated(tx: Prisma.TransactionClient, order: ShopifyOrderPayload, topic: string): Promise<DispatchResult> {
    const orderId = String(order.id);
    const orderGid = order.admin_graphql_api_id;
    const events: EventInput[] = [{ type: 'WEBHOOK_RECEIVED', detail: { topic, orderId } }];

    const reservationId = extractReservationId(order);
    if (!reservationId) {
      events.push({ type: 'WEBHOOK_UNRESOLVED_RESERVATION', detail: { reason: 'reservation_id ausente ou inválido em note_attributes', orderId } });
      return { status: 'ignored', orderId, events };
    }

    const reservation = await tx.reservation.findUnique({ where: { id: reservationId }, include: { items: { include: { rentalUnit: true } } } });
    if (!reservation) {
      // NÃO passa `reservationId` pro evento aqui — esse id veio do
      // atributo do pedido e não corresponde a nenhuma linha real;
      // ReservationEvent.reservationId é FK, gravar um id inexistente
      // quebraria a constraint. O id continua no `detail` (sanitizado,
      // é só um UUID) pra quem for auditar depois.
      events.push({ type: 'WEBHOOK_UNRESOLVED_RESERVATION', detail: { reason: 'reservation não encontrada', requestedReservationId: reservationId, orderId } });
      return { status: 'ignored', orderId, events };
    }

    // Fingerprint e datas REAIS desta reserva — nunca o que o pedido
    // diz que deveria ser, sempre o que está gravado.
    const itemsFingerprint = canonicalItemsFingerprint(
      reservation.items.map((item) => ({ variantId: item.rentalUnit.shopifyVariantId ?? '', quantity: 1 })),
    );
    const pickupDateIso = reservation.pickupDate ? civilDateToISO(civilDateFromPgDate(reservation.pickupDate)) : '';
    const effectiveReturnDateIso = reservation.returnDate ? civilDateToISO(civilDateFromPgDate(reservation.returnDate)) : '';

    const bindingId = extractNoteAttribute(order, 'reservation_binding_id');
    const signature = extractNoteAttribute(order, 'reservation_signature');
    const bindingSecret = resolveReservationBindingSecret(); // config ausente propaga como 503 (não é culpa deste pedido)

    // `bindingId === reservation.reservationBindingId` não é redundante
    // com a assinatura: garante que é o binding da tentativa de checkout
    // MAIS RECENTE desta reserva, não o de uma tentativa antiga
    // (`failed`/abandonada) cuja assinatura continuaria criptograficamente
    // válida (datas/itens não mudam entre tentativas da mesma reserva).
    const signatureValid =
      !!bindingId &&
      !!signature &&
      bindingId === reservation.reservationBindingId &&
      verifyReservationSignature(
        bindingSecret,
        { reservationId: reservation.id, reservationBindingId: bindingId, itemsFingerprint, pickupDate: pickupDateIso, effectiveReturnDate: effectiveReturnDateIso },
        signature,
      );

    if (!signatureValid) {
      return this.markCorrelationProblem(tx, reservation, orderId, events, 'INVALID_BINDING_SIGNATURE', 'assinatura do binding Order↔Reservation ausente ou inválida');
    }

    // Linhas REAIS do pedido == peças REAIS da reserva, exatamente —
    // não confia só na assinatura cobrir isso (defesa em profundidade:
    // se o fingerprint assinado e as linhas do pedido algum dia
    // divergirem por outro motivo, isto pega também).
    const orderLinesFingerprint = canonicalItemsFingerprint(extractOrderLineVariants(order));
    if (orderLinesFingerprint !== itemsFingerprint) {
      return this.markCorrelationProblem(tx, reservation, orderId, events, 'LINE_ITEMS_MISMATCH', 'linhas do pedido não correspondem exatamente às peças da reserva');
    }

    // Confirma que esta reservation de fato completou NOSSO checkout.
    // NÃO tenta casar cart_token/checkout_token do pedido com o
    // shopifyCartId (Storefront Cart GID) — formatos diferentes,
    // cart_token frequentemente vazio pra carts headless, sem
    // comprovação oficial de que os dois correspondem.
    if (reservation.checkoutState !== 'ready' || !reservation.shopifyCartId) {
      return this.markCorrelationProblem(tx, reservation, orderId, events, 'CHECKOUT_NOT_READY', 'reservation sem checkout concluído do nosso lado');
    }

    if (reservation.shopifyOrderId && reservation.shopifyOrderId !== orderId) {
      return this.markCorrelationProblem(tx, reservation, orderId, events, 'DUPLICATE_ORDER', 'reservation já vinculada a outro pedido — tentativa de reuso do mesmo binding assinado');
    }

    if (!reservation.shopifyOrderId) {
      await tx.reservation.update({ where: { id: reservation.id }, data: { shopifyOrderId: orderId, shopifyOrderGid: orderGid } });
      events.push({ type: 'ORDER_LINKED', reservationId: reservation.id, detail: { orderId } });
    }

    if (order.financial_status !== 'paid') {
      events.push({ type: 'WEBHOOK_RECEIVED', reservationId: reservation.id, detail: { note: 'pedido registrado, aguardando pagamento', financialStatus: order.financial_status ?? null, orderId } });
      return { status: 'processed', orderId, reservationId: reservation.id, events };
    }

    return this.confirmPayment(tx, reservation, orderId, events);
  }

  /** Correlação encontrou uma Reservation real, mas algo não bate —
   *  nunca confirma, sempre tenta ir pra `problem` (revisão manual),
   *  respeitando a máquina de estados (se `problem` não for uma
   *  transição válida a partir do status atual, só registra o evento). */
  private async markCorrelationProblem(
    tx: Prisma.TransactionClient,
    reservation: { id: string; status: string },
    orderId: string,
    events: EventInput[],
    eventType: string,
    reason: string,
  ): Promise<DispatchResult> {
    const from = reservation.status as ReservationStatusValue;
    events.push({ type: eventType, reservationId: reservation.id, detail: { orderId, reason } });

    if (canTransition(from, 'problem')) {
      const updated = await tx.reservation.updateMany({ where: { id: reservation.id, status: from }, data: { status: 'problem' } });
      if (updated.count === 1) {
        events.push({ type: 'RESERVATION_STATUS_CHANGED', reservationId: reservation.id, detail: { from, to: 'problem', note: reason } });
      }
    }

    return { status: 'processed', orderId, reservationId: reservation.id, events };
  }

  private async confirmPayment(
    tx: Prisma.TransactionClient,
    reservation: { id: string; status: string },
    orderId: string,
    events: EventInput[],
  ): Promise<DispatchResult> {
    const from = reservation.status as ReservationStatusValue;

    if (from === 'confirmed') {
      events.push({ type: 'PAYMENT_CONFIRMED', reservationId: reservation.id, detail: { orderId, note: 'já confirmada — idempotente' } });
      return { status: 'processed', orderId, reservationId: reservation.id, events };
    }

    if (from === 'pending_payment' && canTransition('pending_payment', 'confirmed')) {
      const updated = await tx.reservation.updateMany({ where: { id: reservation.id, status: 'pending_payment' }, data: { status: 'confirmed', confirmedAt: new Date() } });
      if (updated.count === 1) {
        events.push({ type: 'PAYMENT_CONFIRMED', reservationId: reservation.id, detail: { orderId } });
        events.push({ type: 'RESERVATION_STATUS_CHANGED', reservationId: reservation.id, detail: { from: 'pending_payment', to: 'confirmed' } });
      } else {
        events.push({ type: 'PAYMENT_CONFIRMED', reservationId: reservation.id, detail: { orderId, note: 'status mudou durante o processamento — provavelmente já confirmada por outro evento' } });
      }
      return { status: 'processed', orderId, reservationId: reservation.id, events };
    }

    if (from === 'expired') {
      return this.attemptLatePaymentRecovery(tx, reservation.id, orderId, events);
    }

    // hold/cancelled/problem/operacional recebendo pagamento confirmado
    // — combinação inesperada, nunca força transição fora da máquina de
    // estados. Fail closed: registra, não confirma.
    events.push({
      type: 'RESERVATION_STATUS_CHANGED',
      reservationId: reservation.id,
      detail: { note: `pagamento confirmado chegou com reserva em status inesperado`, from, attemptedTo: 'confirmed' },
    });
    return { status: 'ignored', orderId, reservationId: reservation.id, events };
  }

  // ── late payment (item 8/9 da Fase 7) ───────────────────────────
  private async attemptLatePaymentRecovery(tx: Prisma.TransactionClient, reservationId: string, orderId: string, events: EventInput[]): Promise<DispatchResult> {
    events.push({ type: 'LATE_PAYMENT_RECEIVED', reservationId, detail: { orderId } });

    const items = await tx.$queryRaw<{ rentalUnitId: string; blockedFrom: Date; blockedUntil: Date }[]>`
      SELECT rental_unit_id AS "rentalUnitId", lower(blocked_range) AS "blockedFrom", upper(blocked_range) AS "blockedUntil"
      FROM reservation_items WHERE reservation_id = ${reservationId}::uuid
    `;

    if (items.length === 0) {
      await tx.reservation.updateMany({ where: { id: reservationId, status: 'expired' }, data: { status: 'late_payment_conflict' } });
      events.push({ type: 'LATE_PAYMENT_CONFLICT', reservationId, detail: { orderId, reason: 'reserva sem itens originais' } });
      return { status: 'processed', orderId, reservationId, events };
    }

    // Trava as unidades ORIGINAIS em ordem fixa (id) — mesmo padrão
    // anti-deadlock do HoldsService (Fase 6, preflight).
    const unitIds = [...new Set(items.map((i) => i.rentalUnitId))].sort();
    for (const unitId of unitIds) {
      await tx.$executeRaw`SELECT id FROM rental_units WHERE id = ${unitId}::uuid FOR UPDATE`;
    }

    for (const item of items) {
      const from = civilDateToISO(civilDateFromPgDate(item.blockedFrom));
      const until = civilDateToISO(civilDateFromPgDate(item.blockedUntil));
      const conflict = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM reservation_items
        WHERE rental_unit_id = ${item.rentalUnitId}::uuid
          AND reservation_id != ${reservationId}::uuid
          AND status = ANY(${OCCUPYING_RESERVATION_STATUSES}::"reservation_status"[])
          AND blocked_range && daterange(${from}::date, ${until}::date, '[)')
        LIMIT 1
      `;
      if (conflict.length > 0) {
        await tx.reservation.updateMany({ where: { id: reservationId, status: 'expired' }, data: { status: 'late_payment_conflict' } });
        events.push({ type: 'LATE_PAYMENT_CONFLICT', reservationId, detail: { orderId, reason: 'unidade original já comprometida por outra reserva' } });
        return { status: 'processed', orderId, reservationId, events };
      }
    }

    // Checagem manual não achou conflito — tenta a recuperação atômica.
    // A EXCLUDE constraint (via trigger, ao propagar pra
    // reservation_items) é o backstop final caso exista uma corrida que
    // a checagem acima não pegou. SAVEPOINT é necessário aqui, não só
    // decoração: depois de um statement falhar, o Postgres marca a
    // transação INTEIRA como abortada até um ROLLBACK — sem o savepoint,
    // o UPDATE de recuperação no catch abaixo falharia TAMBÉM (achado
    // real, rodando o teste, não suposto).
    await tx.$executeRaw`SAVEPOINT late_payment_attempt`;
    try {
      const updated = await tx.reservation.updateMany({ where: { id: reservationId, status: 'expired' }, data: { status: 'confirmed', confirmedAt: new Date() } });
      if (updated.count !== 1) {
        events.push({ type: 'LATE_PAYMENT_CONFLICT', reservationId, detail: { orderId, reason: 'status mudou durante a recuperação' } });
        await tx.reservation.updateMany({ where: { id: reservationId, status: 'expired' }, data: { status: 'late_payment_conflict' } });
        return { status: 'processed', orderId, reservationId, events };
      }
    } catch (err) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT late_payment_attempt`;
      await tx.reservation.updateMany({ where: { id: reservationId, status: 'expired' }, data: { status: 'late_payment_conflict' } });
      events.push({ type: 'LATE_PAYMENT_CONFLICT', reservationId, detail: { orderId, reason: 'conflito detectado pela EXCLUDE constraint no commit', code: errorCode(err) } });
      return { status: 'processed', orderId, reservationId, events };
    }

    events.push({ type: 'LATE_PAYMENT_RECOVERED', reservationId, detail: { orderId } });
    events.push({ type: 'RESERVATION_STATUS_CHANGED', reservationId, detail: { from: 'expired', to: 'confirmed' } });
    return { status: 'processed', orderId, reservationId, events };
  }

  // ── orders/cancelled ─────────────────────────────────────────────
  private async handleOrderCancelled(tx: Prisma.TransactionClient, order: ShopifyOrderPayload): Promise<DispatchResult> {
    const orderId = String(order.id);
    const events: EventInput[] = [{ type: 'WEBHOOK_RECEIVED', detail: { topic: 'orders/cancelled', orderId } }];

    const reservation = await tx.reservation.findFirst({ where: { shopifyOrderId: orderId } });
    if (!reservation) {
      events.push({ type: 'WEBHOOK_UNRESOLVED_RESERVATION', detail: { reason: 'nenhuma reservation vinculada a este orderId', orderId } });
      return { status: 'ignored', orderId, events };
    }

    events.push({ type: 'ORDER_CANCELLED', reservationId: reservation.id, detail: { orderId, cancelReason: order.cancel_reason ?? null } });

    const from = reservation.status as ReservationStatusValue;
    if (from === 'cancelled') {
      return { status: 'processed', orderId, reservationId: reservation.id, events };
    }

    // Item 11: só vira `cancelled` de verdade se ainda não foi retirada.
    // picked_up/returned/cleaning → `problem` (revisão manual), nunca
    // cancelled automático.
    const to: ReservationStatusValue = canTransition(from, 'cancelled') ? 'cancelled' : canTransition(from, 'problem') ? 'problem' : from;

    if (to !== from) {
      const updated = await tx.reservation.updateMany({ where: { id: reservation.id, status: from }, data: { status: to } });
      if (updated.count === 1) {
        events.push({
          type: 'RESERVATION_STATUS_CHANGED',
          reservationId: reservation.id,
          detail: to === 'problem' ? { from, to, note: 'cancelamento chegou após a retirada — revisão manual' } : { from, to },
        });
      }
    }

    return { status: 'processed', orderId, reservationId: reservation.id, events };
  }

  // ── refunds/create ───────────────────────────────────────────────
  private async handleRefundCreated(tx: Prisma.TransactionClient, refund: ShopifyRefundPayload): Promise<DispatchResult> {
    const orderId = String(refund.order_id);
    const events: EventInput[] = [{ type: 'WEBHOOK_RECEIVED', detail: { topic: 'refunds/create', orderId } }];

    const reservation = await tx.reservation.findFirst({ where: { shopifyOrderId: orderId } });
    if (!reservation) {
      events.push({ type: 'WEBHOOK_UNRESOLVED_RESERVATION', detail: { reason: 'nenhuma reservation vinculada a este orderId', orderId } });
      return { status: 'ignored', orderId, events };
    }

    // Só o valor, nunca o objeto de transação inteiro (pode carregar
    // detalhe de gateway) — item 14 da Fase 7.
    const amount = sumRefundAmount(refund);
    events.push({ type: 'REFUND_RECEIVED', reservationId: reservation.id, detail: { orderId, amount } });

    // Refund NUNCA libera unidade automaticamente (item 12). A única
    // ação automática permitida é sinalizar revisão manual quando a
    // reserva ainda está numa fase "ativa" (paga ou aguardando
    // pagamento) — em qualquer outro status, só registra.
    const from = reservation.status as ReservationStatusValue;
    if ((from === 'confirmed' || from === 'pending_payment') && canTransition(from, 'problem')) {
      const updated = await tx.reservation.updateMany({ where: { id: reservation.id, status: from }, data: { status: 'problem' } });
      if (updated.count === 1) {
        events.push({
          type: 'RESERVATION_STATUS_CHANGED',
          reservationId: reservation.id,
          detail: { from, to: 'problem', note: 'refund recebido — revisão manual; unidade NÃO liberada automaticamente' },
        });
      }
    }

    return { status: 'processed', orderId, reservationId: reservation.id, events };
  }

  private async bestEffortRecordFailure(input: { topic: string; shopifyWebhookId: string; payload: unknown }, err: unknown): Promise<void> {
    try {
      const store = resolveStoreConfig();
      await this.prisma.webhookEvent.upsert({
        where: { shopifyWebhookId: input.shopifyWebhookId },
        update: { status: 'failed', errorMessage: errorCode(err), attemptCount: { increment: 1 } },
        create: {
          shopifyWebhookId: input.shopifyWebhookId,
          storeId: store.id,
          topic: input.topic,
          payload: input.payload as Prisma.InputJsonValue,
          status: 'failed',
          errorMessage: errorCode(err),
        },
      });
    } catch (writeErr) {
      // Puramente observabilidade — nunca deixa uma falha AQUI mascarar
      // o erro original que já vai virar 503 pro chamador.
      this.logger.error(`Não foi possível registrar falha de webhook para auditoria: ${errorCode(writeErr)}`);
    }
  }
}

interface EventInput {
  readonly type: string;
  readonly reservationId?: string;
  readonly detail?: Record<string, unknown>;
}

interface DispatchResult {
  readonly status: 'processed' | 'ignored';
  readonly reservationId?: string;
  readonly orderId?: string;
  readonly events: EventInput[];
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
