import { ConflictException, ForbiddenException, GoneException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, type PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { verifyHoldToken } from '../holds/hold-token';
import { ShopifyCartClient } from '../checkout/shopify-storefront-cart.client';
import { paymentWindowMinutes } from '../checkout/checkout.config';
import { OCCUPYING_RESERVATION_STATUSES } from '../reservation-status';
import { civilDateFromPgDate, civilDateToISO } from '../rental-rules/civil-date';
import { blockedRangesOverlap } from '../rental-rules/rental-engine';
import { isRangeBlockedStoreWide, loadActiveStoreWideBlocks, loadActiveUnitBlocks } from '../admin/operational-blocks';
import { MercadoPagoClient } from './mercadopago.client';
import { verifyMercadoPagoSignature } from './mercadopago-webhook-signature';
import { resolveMercadoPagoWebhookSecret } from './mercadopago.config';
import type { CreateMercadoPagoPreferenceDto } from './dto/create-preference.dto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Espelha o vocabulário do Mercado Pago 1:1 — nenhuma tradução própria
 *  que possa divergir (ver PaymentStatus no schema). */
const MP_STATUS_TO_PAYMENT_STATUS: Record<string, string | undefined> = {
  pending: 'pending',
  in_process: 'in_process',
  approved: 'approved',
  rejected: 'rejected',
  cancelled: 'cancelled',
  refunded: 'refunded',
};

/** Transições permitidas do lado do PAGAMENTO (não da Reservation) —
 *  mesmo princípio de canTransition (webhooks/reservation-state-machine.ts):
 *  qualquer transição não listada é ignorada, nunca aplicada às cegas.
 *  Garante idempotência (duplicata = mesma origem→mesmo destino = já
 *  aplicada, WHERE não bate) e proteção contra fora-de-ordem (ex.: um
 *  "pending" chegando depois de "approved" nunca reverte o pagamento). */
const ALLOWED_PAYMENT_TRANSITIONS: Record<string, readonly string[]> = {
  pending: ['pending', 'in_process', 'approved', 'rejected', 'cancelled'],
  in_process: ['in_process', 'approved', 'rejected', 'cancelled'],
  approved: ['approved', 'refunded'],
  rejected: [],
  cancelled: [],
  refunded: ['refunded'],
};

export interface MercadoPagoPreferenceResponse {
  readonly reservationId: string;
  readonly paymentId: string;
  readonly status: string;
  readonly checkoutUrl: string;
  readonly expiresAt: string;
  readonly amount: string;
  readonly currency: string;
}

export interface WebhookHeaders {
  readonly signature?: string;
  readonly requestId?: string;
  readonly dataIdFromQuery?: string;
}

@Injectable()
export class MercadoPagoService {
  private readonly logger = new Logger(MercadoPagoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mpClient: MercadoPagoClient,
    private readonly shopifyCartClient: ShopifyCartClient,
  ) {}

  // ── criação da preferência (checkout) ───────────────────────────

  async createPreference(dto: CreateMercadoPagoPreferenceDto): Promise<MercadoPagoPreferenceResponse> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: dto.reservationId },
      include: { items: { include: { rentalUnit: true } }, originStore: true },
    });
    if (!reservation) throw new NotFoundException('Reserva não encontrada.');
    if (!verifyHoldToken(dto.holdToken, reservation.holdTokenHash)) {
      throw new ForbiddenException('holdToken inválido.');
    }

    if (reservation.status === 'hold' && (await this.expireHoldIfDue(reservation.id))) {
      throw new GoneException('Este HOLD expirou.');
    }

    if (reservation.status !== 'hold') {
      if (reservation.status === 'pending_payment') {
        const existing = await this.findReplayablePayment(reservation.id);
        if (existing) return existing;
      }
      throw new ConflictException(`Reserva não está em estado de HOLD (status atual: ${reservation.status}).`);
    }

    if (!reservation.termsAcceptedAt) throw new UnprocessableEntityException('Termos não aceitos para esta reserva.');
    if (reservation.items.length === 0) throw new UnprocessableEntityException('Reserva sem itens.');
    if (reservation.items.some((item) => !item.rentalUnit.active)) {
      throw new ConflictException('Uma das peças desta reserva não está mais disponível.');
    }

    // Valor SEMPRE calculado aqui, nunca aceito do cliente — soma do
    // preço real de cada variante (fonte única: Shopify), na moeda da
    // loja. O checkout Shopify nunca precisou disso (a própria Shopify
    // calcula); o Mercado Pago exige o valor na criação da preferência.
    const variantIds = [...new Set(reservation.items.map((i) => i.rentalUnit.shopifyVariantId).filter((id): id is string => !!id))];
    let prices;
    try {
      prices = await this.shopifyCartClient.fetchVariantPrices(variantIds);
    } catch (err) {
      this.logger.error(`Falha ao consultar preços na Storefront API: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível calcular o valor da reserva no momento.');
    }
    if (prices.length !== variantIds.length) {
      throw new ServiceUnavailableException('Não foi possível obter o preço de todas as peças no momento.');
    }
    const currency = reservation.originStore.currency;
    if (prices.some((p) => p.currencyCode !== currency)) {
      this.logger.error(`Divergência de moeda entre Storefront (${prices.map((p) => p.currencyCode).join(',')}) e a loja (${currency}).`);
      throw new ServiceUnavailableException('Não foi possível calcular o valor da reserva no momento.');
    }

    const priceByVariant = new Map(prices.map((p) => [p.variantId, p.amount]));
    const amount = reservation.items.reduce((sum, item) => {
      const price = item.rentalUnit.shopifyVariantId ? priceByVariant.get(item.rentalUnit.shopifyVariantId) : undefined;
      return sum + (price ?? 0);
    }, 0);
    if (amount <= 0) throw new UnprocessableEntityException('Não foi possível determinar um valor válido para a reserva.');

    // Idempotência por chave escolhida pelo cliente — se já existe um
    // Payment com esta chave, é replay (mesma reserva) ou uso indevido
    // da chave (reserva diferente) — nunca cria dois pagamentos pra uma
    // tentativa.
    const existingByKey = await this.prisma.payment.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
    if (existingByKey) {
      if (existingByKey.reservationId !== reservation.id) {
        throw new ConflictException('Idempotency-Key já foi usada para outra reserva.');
      }
      return this.toPreferenceResponse(existingByKey, reservation.paymentExpiresAt);
    }

    // Claim atômico — MESMA técnica do checkout Shopify (item 7): só uma
    // chamada por vez consegue mover hold → pending_payment; quem perde
    // a corrida reage ao estado atual (replay ou 409), nunca cria dois
    // pagamentos concorrentes pra mesma reserva.
    const minutes = paymentWindowMinutes();
    const claimed = await this.prisma.$queryRaw<{ paymentExpiresAt: Date }[]>`
      UPDATE reservations
      SET status = 'pending_payment', payment_expires_at = now() + ${minutes} * interval '1 minute', updated_at = now()
      WHERE id = ${reservation.id}::uuid AND status = 'hold' AND expires_at > now()
      RETURNING payment_expires_at AS "paymentExpiresAt"
    `;
    if (claimed.length !== 1) {
      const existing = await this.findReplayablePayment(reservation.id);
      if (existing) return existing;
      throw new ConflictException('O checkout desta reserva já está sendo criado — tente novamente em instantes.');
    }
    const paymentExpiresAt = claimed[0].paymentExpiresAt;

    let payment;
    try {
      payment = await this.prisma.payment.create({
        data: {
          provider: 'mercadopago',
          reservationId: reservation.id,
          status: 'pending',
          amount,
          currency,
          idempotencyKey: dto.idempotencyKey,
        },
      });
    } catch (err) {
      this.logger.error(`Falha ao gravar Payment: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível criar o checkout no momento.');
    }

    return this.createPreferenceForPayment(payment.id, reservation.id, amount, currency, paymentExpiresAt);
  }

  /** Retentável — se uma tentativa anterior falhou depois do claim mas
   *  antes de a Shopify... digo, o Mercado Pago responder, o Payment
   *  fica com `preferenceId = null` pra sempre poder tentar de novo sem
   *  criar um segundo Payment (item "retry após falha"). */
  private async createPreferenceForPayment(paymentId: string, reservationId: string, amount: number, currency: string, paymentExpiresAt: Date): Promise<MercadoPagoPreferenceResponse> {
    let result;
    try {
      result = await this.mpClient.createPreference({
        items: [{ title: 'Aluguel VS by Closet', quantity: 1, unitPrice: amount, currencyId: currency }],
        externalReference: paymentId,
        metadata: { reservation_id: reservationId, payment_id: paymentId },
        notificationUrl: process.env.MERCADOPAGO_TEST_WEBHOOK_URL || undefined,
      });
    } catch (err) {
      this.logger.error(`Falha ao criar preferência no Mercado Pago: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível criar o checkout no momento.');
    }

    const updated = await this.prisma.payment.update({
      where: { id: paymentId },
      data: { preferenceId: result.preferenceId, checkoutUrl: result.checkoutUrl },
    });

    await this.prisma.reservationEvent.create({
      data: { reservationId, type: 'MERCADOPAGO_PREFERENCE_CREATED', detail: { paymentId, preferenceId: result.preferenceId, amount: String(amount), currency } },
    });

    return this.toPreferenceResponse(updated, paymentExpiresAt);
  }

  private async findReplayablePayment(reservationId: string): Promise<MercadoPagoPreferenceResponse | null> {
    const reservation = await this.prisma.reservation.findUnique({ where: { id: reservationId } });
    if (!reservation || !reservation.paymentExpiresAt) return null;

    const payment = await this.prisma.payment.findFirst({
      where: { reservationId, provider: 'mercadopago', status: { in: ['pending', 'in_process'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!payment) return null;

    if (!payment.preferenceId || !payment.checkoutUrl) {
      // Tentativa anterior não chegou a falar com o Mercado Pago (ou
      // falhou antes de gravar) — tenta de novo com o MESMO Payment,
      // nunca cria um segundo.
      return this.createPreferenceForPayment(payment.id, reservationId, Number(payment.amount), payment.currency, reservation.paymentExpiresAt);
    }
    return this.toPreferenceResponse(payment, reservation.paymentExpiresAt);
  }

  private toPreferenceResponse(payment: { id: string; reservationId: string; status: string; checkoutUrl: string | null; amount: Prisma.Decimal | number; currency: string }, paymentExpiresAt: Date | null): MercadoPagoPreferenceResponse {
    if (!payment.checkoutUrl || !paymentExpiresAt) {
      throw new ServiceUnavailableException('Não foi possível criar o checkout no momento.');
    }
    return {
      reservationId: payment.reservationId,
      paymentId: payment.id,
      status: payment.status,
      checkoutUrl: payment.checkoutUrl,
      expiresAt: paymentExpiresAt.toISOString(),
      amount: String(payment.amount),
      currency: payment.currency,
    };
  }

  /** Mesmo mecanismo lazy de expiração do checkout Shopify (item 9) — a
   *  fonte de verdade é sempre o Postgres, nunca o relógio do processo. */
  private async expireHoldIfDue(reservationId: string): Promise<boolean> {
    const result = await this.prisma.$executeRaw`
      UPDATE reservations SET status = 'expired' WHERE id = ${reservationId}::uuid AND status = 'hold' AND expires_at <= now()
    `;
    return result > 0;
  }

  // ── webhook ──────────────────────────────────────────────────────

  /**
   * Idempotente e seguro contra fora-de-ordem por construção: NUNCA
   * confia em status/valor/moeda do corpo da notificação — sempre
   * reconsulta o pagamento na API do Mercado Pago, e a transição de
   * status é sempre condicional (`ALLOWED_PAYMENT_TRANSITIONS`), nunca
   * um `SET` incondicional.
   */
  async handleWebhook(dataId: string | undefined, topic: string | undefined, headers: WebhookHeaders): Promise<{ outcome: 'processed' | 'ignored' | 'duplicate' | 'rejected' }> {
    if (!dataId) {
      await this.logWebhookEvent({ externalPaymentId: 'unknown', topic: topic ?? 'unknown', payload: { headers }, status: 'ignored', errorMessage: 'data.id ausente' });
      return { outcome: 'ignored' };
    }

    const secret = resolveMercadoPagoWebhookSecret();
    if (secret) {
      const valid = verifyMercadoPagoSignature({ signatureHeader: headers.signature, requestId: headers.requestId, dataId: headers.dataIdFromQuery ?? dataId, secret });
      if (!valid) {
        await this.logWebhookEvent({ externalPaymentId: dataId, topic: topic ?? 'unknown', payload: {}, status: 'failed', errorMessage: 'assinatura inválida' });
        return { outcome: 'rejected' };
      }
    } else {
      this.logger.warn('MERCADOPAGO_TEST_WEBHOOK_SECRET não configurado — verificação de assinatura DESLIGADA (pendência de homologação). Segurança mantida pela reconsulta server-side do pagamento.');
    }

    let mpPayment;
    try {
      mpPayment = await this.mpClient.getPayment(dataId);
    } catch (err) {
      this.logger.error(`Falha ao consultar pagamento ${dataId} no Mercado Pago: ${errorCode(err)}`);
      await this.logWebhookEvent({ externalPaymentId: dataId, topic: topic ?? 'unknown', payload: {}, status: 'failed', errorMessage: 'falha ao consultar API (retry esperado)' });
      // 5xx implícito pra quem chama (o controller decide o HTTP) — o
      // Mercado Pago reenvia notificações que falham, então uma falha
      // temporária de rede não é o fim do mundo, é só "tenta de novo".
      throw new ServiceUnavailableException('Não foi possível consultar o pagamento no momento.');
    }

    if (!mpPayment) {
      await this.logWebhookEvent({ externalPaymentId: dataId, topic: topic ?? 'unknown', payload: {}, status: 'ignored', errorMessage: 'paymentId inexistente na API do Mercado Pago' });
      return { outcome: 'ignored' };
    }

    if (mpPayment.liveMode) {
      // Fail closed: um webhook de PRODUÇÃO nunca deve conseguir
      // confirmar nada neste ambiente de teste.
      this.logger.error(`Notificação recebida para um pagamento em live_mode=true (produção) — recusada. paymentId=${dataId}`);
      await this.logWebhookEvent({ externalPaymentId: dataId, topic: topic ?? 'unknown', payload: {}, status: 'failed', errorMessage: 'live_mode=true recusado neste ambiente de teste' });
      return { outcome: 'rejected' };
    }

    const ourPaymentId = mpPayment.externalReference;
    if (!ourPaymentId || !UUID_RE.test(ourPaymentId)) {
      await this.logWebhookEvent({ externalPaymentId: dataId, topic: topic ?? 'unknown', payload: {}, status: 'ignored', errorMessage: 'external_reference ausente ou inválida' });
      return { outcome: 'ignored' };
    }

    const payment = await this.prisma.payment.findUnique({ where: { id: ourPaymentId } });
    if (!payment) {
      await this.logWebhookEvent({ externalPaymentId: dataId, topic: topic ?? 'unknown', payload: {}, status: 'ignored', errorMessage: 'Payment interno não encontrado para external_reference' });
      return { outcome: 'ignored' };
    }

    // Valor e moeda — nunca confiados do corpo do webhook, comparados
    // contra o que O SERVIDOR calculou na criação (item explícito).
    const amountMatches = Math.abs(mpPayment.transactionAmount - Number(payment.amount)) < 0.01;
    const currencyMatches = mpPayment.currencyId === payment.currency;
    if (!amountMatches || !currencyMatches) {
      this.logger.error(`Pagamento ${dataId} com valor/moeda divergente do esperado (Payment ${payment.id}).`);
      await this.prisma.payment.updateMany({ where: { id: payment.id, status: { in: ['pending', 'in_process'] } }, data: { status: 'rejected', externalPaymentId: dataId } });
      await this.logWebhookEvent({ externalPaymentId: dataId, topic: topic ?? 'unknown', payload: {}, status: 'failed', errorMessage: 'valor ou moeda divergente', paymentId: payment.id });
      await this.writeAudit(payment.reservationId, 'MERCADOPAGO_AMOUNT_MISMATCH', { paymentId: payment.id, dataId, expected: { amount: String(payment.amount), currency: payment.currency }, received: { amount: mpPayment.transactionAmount, currency: mpPayment.currencyId } });
      return { outcome: 'rejected' };
    }

    const nextStatus = MP_STATUS_TO_PAYMENT_STATUS[mpPayment.status];
    if (!nextStatus) {
      await this.logWebhookEvent({ externalPaymentId: dataId, topic: topic ?? 'unknown', payload: {}, status: 'ignored', errorMessage: `status desconhecido do Mercado Pago: ${mpPayment.status}`, paymentId: payment.id });
      return { outcome: 'ignored' };
    }

    const allowedFrom = Object.entries(ALLOWED_PAYMENT_TRANSITIONS).filter(([, tos]) => tos.includes(nextStatus)).map(([from]) => from);
    const updated = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: { in: allowedFrom as PaymentStatus[] } },
      data: {
        status: nextStatus as PaymentStatus,
        externalPaymentId: dataId,
        paidAt: nextStatus === 'approved' ? new Date() : undefined,
        refundedAt: nextStatus === 'refunded' ? new Date() : undefined,
      },
    });

    const isNoOpDuplicate = updated.count === 0 && payment.status === nextStatus;
    if (updated.count === 0 && !isNoOpDuplicate) {
      // Fora de ordem (ex.: "pending" chegando depois de "approved") ou
      // transição não permitida a partir do estado atual — ignorado com
      // segurança, nunca aplicado.
      await this.logWebhookEvent({ externalPaymentId: dataId, topic: topic ?? 'unknown', payload: {}, status: 'ignored', errorMessage: `transição ${payment.status} → ${nextStatus} bloqueada (fora de ordem ou já resolvida)`, paymentId: payment.id });
      return { outcome: 'ignored' };
    }

    await this.logWebhookEvent({ externalPaymentId: dataId, topic: topic ?? 'unknown', payload: {}, status: 'processed', paymentId: payment.id });

    if (isNoOpDuplicate) {
      return { outcome: 'duplicate' };
    }

    if (nextStatus === 'approved') {
      await this.confirmReservationAfterApproval(payment.reservationId, payment.id, dataId);
    }

    await this.writeAudit(payment.reservationId, 'MERCADOPAGO_PAYMENT_UPDATED', { paymentId: payment.id, dataId, from: payment.status, to: nextStatus });
    return { outcome: 'processed' };
  }

  /**
   * Só após um pagamento genuinamente APROVADO (nunca pelo retorno do
   * frontend) — confirma a reserva ou, se o HOLD já expirou nesse
   * meio-tempo, tenta a mesma recuperação de "pagamento tardio" que o
   * webhook da Shopify já faz (mesmas primitivas reaproveitadas:
   * OCCUPYING_RESERVATION_STATUSES, blocos operacionais — ver
   * WebhooksService.attemptLatePaymentRecovery pro fluxo Shopify
   * equivalente; não compartilhado por código pra não acoplar os dois
   * providers, mas a REGRA é a mesma).
   */
  private async confirmReservationAfterApproval(reservationId: string, paymentId: string, mpPaymentId: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const reservation = await tx.reservation.findUnique({ where: { id: reservationId } });
        if (!reservation) return;

        if (reservation.status === 'confirmed') return; // idempotente

        if (reservation.status === 'pending_payment') {
          const updated = await tx.reservation.updateMany({ where: { id: reservationId, status: 'pending_payment' }, data: { status: 'confirmed', confirmedAt: new Date() } });
          if (updated.count === 1) {
            await tx.reservationEvent.create({ data: { reservationId, type: 'MERCADOPAGO_PAYMENT_APPROVED', detail: { paymentId, mpPaymentId } } });
            await tx.reservationEvent.create({ data: { reservationId, type: 'RESERVATION_STATUS_CHANGED', detail: { from: 'pending_payment', to: 'confirmed' } } });
          }
          return;
        }

        if (reservation.status === 'expired') {
          await this.attemptLatePaymentRecovery(tx, reservationId, paymentId, mpPaymentId);
          return;
        }

        // hold/cancelled/problem/late_payment_conflict recebendo
        // aprovação — combinação inesperada, nunca força a transição.
        await tx.reservationEvent.create({
          data: { reservationId, type: 'MERCADOPAGO_PAYMENT_APPROVED_UNEXPECTED_STATUS', detail: { paymentId, mpPaymentId, status: reservation.status } },
        });
      }, { timeout: 15_000, maxWait: 10_000 });
    } catch (err) {
      this.logger.error(`Falha ao confirmar reserva ${reservationId} após aprovação do pagamento ${paymentId}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível confirmar a reserva no momento.');
    }
  }

  private async attemptLatePaymentRecovery(tx: Prisma.TransactionClient, reservationId: string, paymentId: string, mpPaymentId: string): Promise<void> {
    await tx.reservationEvent.create({ data: { reservationId, type: 'MERCADOPAGO_LATE_PAYMENT_RECEIVED', detail: { paymentId, mpPaymentId } } });

    const items = await tx.$queryRaw<{ rentalUnitId: string; blockedFrom: Date; blockedUntil: Date }[]>`
      SELECT rental_unit_id AS "rentalUnitId", lower(blocked_range) AS "blockedFrom", upper(blocked_range) AS "blockedUntil"
      FROM reservation_items WHERE reservation_id = ${reservationId}::uuid
    `;

    const conflict = async (reason: string) => {
      await tx.reservation.updateMany({ where: { id: reservationId, status: 'expired' }, data: { status: 'late_payment_conflict' } });
      await tx.reservationEvent.create({ data: { reservationId, type: 'MERCADOPAGO_LATE_PAYMENT_CONFLICT', detail: { paymentId, mpPaymentId, reason } } });
    };

    if (items.length === 0) return conflict('reserva sem itens originais');

    const unitIds = [...new Set(items.map((i) => i.rentalUnitId))].sort();
    for (const unitId of unitIds) {
      await tx.$executeRaw`SELECT id FROM rental_units WHERE id = ${unitId}::uuid FOR UPDATE`;
    }

    for (const item of items) {
      const range = { blockedFrom: civilDateFromPgDate(item.blockedFrom), blockedUntilExclusive: civilDateFromPgDate(item.blockedUntil) };
      const unit = await tx.rentalUnit.findUnique({ where: { id: item.rentalUnitId }, select: { active: true } });
      const storeBlocks = await loadActiveStoreWideBlocks(tx, range.blockedFrom, range.blockedUntilExclusive);
      const unitBlocks = await loadActiveUnitBlocks(tx, [item.rentalUnitId]);
      if (!unit?.active || isRangeBlockedStoreWide(range, storeBlocks) !== null || unitBlocks.some((block) => blockedRangesOverlap(block.range, range))) {
        return conflict('unidade inativa ou bloqueio operacional');
      }
      const from = civilDateToISO(civilDateFromPgDate(item.blockedFrom));
      const until = civilDateToISO(civilDateFromPgDate(item.blockedUntil));
      const overlapping = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM reservation_items
        WHERE rental_unit_id = ${item.rentalUnitId}::uuid AND reservation_id != ${reservationId}::uuid
          AND status = ANY(${OCCUPYING_RESERVATION_STATUSES}::"reservation_status"[])
          AND blocked_range && daterange(${from}::date, ${until}::date, '[)')
        LIMIT 1
      `;
      if (overlapping.length > 0) return conflict('unidade original já comprometida por outra reserva');
    }

    await tx.$executeRaw`SAVEPOINT mp_late_payment_attempt`;
    try {
      const updated = await tx.reservation.updateMany({ where: { id: reservationId, status: 'expired' }, data: { status: 'confirmed', confirmedAt: new Date() } });
      if (updated.count !== 1) return conflict('status mudou durante a recuperação');
      await tx.reservationEvent.create({ data: { reservationId, type: 'MERCADOPAGO_PAYMENT_APPROVED', detail: { paymentId, mpPaymentId, recoveredFromExpired: true } } });
    } catch (err) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT mp_late_payment_attempt`;
      await conflict(`conflito detectado pela EXCLUDE constraint no commit (${errorCode(err)})`);
    }
  }

  private async logWebhookEvent(input: { externalPaymentId: string; topic: string; payload: unknown; status: 'processed' | 'failed' | 'ignored'; errorMessage?: string; paymentId?: string }): Promise<void> {
    try {
      await this.prisma.mercadoPagoWebhookEvent.create({
        data: {
          externalPaymentId: input.externalPaymentId,
          topic: input.topic,
          payload: input.payload as Prisma.InputJsonValue,
          status: input.status,
          errorMessage: input.errorMessage ?? null,
          paymentId: input.paymentId ?? null,
        },
      });
    } catch (err) {
      this.logger.error(`Falha ao gravar MercadoPagoWebhookEvent (não bloqueia o processamento): ${errorCode(err)}`);
    }
  }

  private async writeAudit(reservationId: string, action: string, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.prisma.reservationEvent.create({ data: { reservationId, type: action, detail: detail as Prisma.InputJsonValue } });
    } catch (err) {
      this.logger.error(`Falha ao gravar auditoria (${action}): ${errorCode(err)}`);
    }
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
