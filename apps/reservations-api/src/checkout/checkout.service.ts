import { ConflictException, ForbiddenException, GoneException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { civilDateFromPgDate, civilDateToISO, diffDays } from '../rental-rules/civil-date';
import { verifyHoldToken } from '../holds/hold-token';
import { paymentWindowMinutes, resolveReservationBindingSecret } from './checkout.config';
import { type CartLineInput, ShopifyCartClient } from './shopify-storefront-cart.client';
import type { CreateCheckoutDto } from './dto/create-checkout.dto';
import { canonicalItemsFingerprint, computeReservationSignature, generateReservationBindingId } from '../reservation-binding';

/** Um `checkout_state = 'creating'` mais velho que isto é tratado como
 *  processo que caiu no meio (item 8 da Fase 6: "Shopify cria cart,
 *  processo cai antes de gravar cartId") — retentável. Mais novo que
 *  isto, outra requisição provavelmente ainda está em voo: 409, peça pro
 *  cliente tentar de novo em instantes, sem lock nenhum de aplicação. */
const STALE_CREATING_MS = 30_000;

export interface CheckoutResponse {
  readonly reservationId: string;
  readonly status: string;
  readonly checkoutUrl: string;
  readonly expiresAt: string;
}

type ReservationWithItems = Awaited<ReturnType<CheckoutService['loadReservationForCheckout']>>;

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rentalRuleConfig: RentalRuleConfigService,
    private readonly cartClient: ShopifyCartClient,
  ) {}

  async createCheckout(dto: CreateCheckoutDto): Promise<CheckoutResponse> {
    const reservation = await this.loadReservationForCheckout(dto.reservationId);
    if (!reservation) {
      throw new NotFoundException('Reserva não encontrada.');
    }

    // Prova de posse — item 1 da Fase 6. reservationId sozinho nunca é
    // suficiente; comparação em tempo constante (ver hold-token.ts).
    if (!verifyHoldToken(dto.holdToken, reservation.holdTokenHash)) {
      throw new ForbiddenException('holdToken inválido.');
    }

    if (reservation.status === 'expired') {
      throw new GoneException('Esta reserva expirou. Inicie uma nova reserva.');
    }

    // Expira com o MESMO mecanismo oficial do HoldsService (UPDATE
    // guardado por status+expires_at) — nunca cria carrinho pra um HOLD
    // vencido, mesmo que o status ainda esteja "hold" no banco (a
    // expiração é lazy, não por cron). O Postgres é a ÚNICA fonte de
    // verdade sobre "isso já venceu?" — nunca comparamos reservation.expiresAt
    // contra Date.now() (relógio do processo Node): os dois relógios podem
    // divergir, e essa comparação já causou um falso-negativo real (achado
    // rodando a suíte completa, não suposto — ver expireHoldIfDue).
    if (reservation.status === 'hold' && (await this.expireHoldIfDue(reservation.id))) {
      throw new GoneException('Este HOLD expirou.');
    }

    if (reservation.status !== 'hold') {
      if (reservation.status === 'pending_payment' && await this.expirePaymentIfDue(reservation.id)) {
        throw new GoneException('A janela de pagamento expirou.');
      }
      // Replay seguro: checkout já pronto pra esta reserva (item 7 —
      // "retornar o checkout existente quando seguro").
      if (reservation.status === 'pending_payment' && reservation.checkoutState === 'ready' && reservation.checkoutUrl && reservation.paymentExpiresAt) {
        return {
          reservationId: reservation.id,
          status: reservation.status,
          checkoutUrl: reservation.checkoutUrl,
          expiresAt: reservation.paymentExpiresAt.toISOString(),
        };
      }
      throw new ConflictException(`Reserva não está em estado de HOLD (status atual: ${reservation.status}).`);
    }

    if (!reservation.termsAcceptedAt) {
      throw new UnprocessableEntityException('Termos não aceitos para esta reserva.');
    }
    if (reservation.items.length === 0) {
      throw new UnprocessableEntityException('Reserva sem itens.');
    }
    if (reservation.items.some((item) => !item.rentalUnit.active)) {
      throw new ConflictException('Uma das peças desta reserva não está mais disponível.');
    }

    const lines = buildCartLines(reservation.items);

    // Idempotência (item 7) — o guard É a query, não um lock em memória:
    // só uma chamada por vez consegue mover none/failed → creating; quem
    // perde a corrida lê o estado atual e reage (replay se já ready,
    // 409 se genuinamente em voo).
    const attemptId = generateReservationBindingId();
    const claim = await this.claimCreatingState(reservation.id, attemptId);
    if (!claim.claimed) {
      if (claim.state === 'ready' && claim.checkoutUrl && claim.paymentExpiresAt) {
        return { reservationId: reservation.id, status: 'pending_payment', checkoutUrl: claim.checkoutUrl, expiresAt: claim.paymentExpiresAt.toISOString() };
      }
      throw new ConflictException('O checkout desta reserva já está sendo criado — tente novamente em instantes.');
    }

    const durationDays = reservation.rentalDurationDays ?? (reservation.pickupDate && reservation.returnDate
      ? diffDays(civilDateFromPgDate(reservation.returnDate), civilDateFromPgDate(reservation.pickupDate)) : 0);
    const pickupDateIso = reservation.pickupDate ? civilDateToISO(civilDateFromPgDate(reservation.pickupDate)) : '';
    const effectiveReturnDateIso = reservation.returnDate ? civilDateToISO(civilDateFromPgDate(reservation.returnDate)) : '';

    // Binding assinado Order↔Reservation — endurecimento pedido antes de
    // continuar a Fase 7: reservation_id sozinho como atributo de cart
    // não é prova suficiente (atributos de cart são alteráveis via
    // Storefront API — cartAttributesUpdate — enquanto o cart existe).
    // A assinatura cobre reservationId + um nonce único desta tentativa
    // + o fingerprint REAL das peças + as datas; sem o segredo (nunca
    // exposto ao navegador), não dá pra forjar uma assinatura válida
    // pra outra reserva. Ver src/reservation-binding.ts.
    let reservationBindingId: string;
    let reservationSignature: string;
    try {
      const bindingSecret = resolveReservationBindingSecret();
      reservationBindingId = attemptId;
      const itemsFingerprint = canonicalItemsFingerprint(
        reservation.items.map((item) => ({ variantId: item.rentalUnit.shopifyVariantId ?? '', quantity: 1 })),
      );
      reservationSignature = computeReservationSignature(bindingSecret, {
        reservationId: reservation.id,
        reservationBindingId,
        itemsFingerprint,
        pickupDate: pickupDateIso,
        effectiveReturnDate: effectiveReturnDateIso,
      });
    } catch (err) {
      await this.markFailed(reservation.id, attemptId);
      this.logger.error(`Falha ao gerar o binding assinado do checkout: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível criar o checkout no momento.');
    }

    const attributes = [
      { key: 'reservation_id', value: reservation.id },
      { key: 'reservation_binding_id', value: reservationBindingId },
      { key: 'reservation_signature', value: reservationSignature },
      { key: 'pickup_date', value: pickupDateIso },
      { key: 'effective_return_date', value: effectiveReturnDateIso },
      { key: 'rental_duration_days', value: String(durationDays) },
      { key: 'terms_version', value: reservation.termsVersion ?? '' },
    ];

    let result;
    try {
      result = await this.cartClient.cartCreate(lines, attributes);
    } catch (err) {
      await this.markFailed(reservation.id, attemptId);
      this.logger.error(`Falha ao chamar Storefront API (cartCreate): ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível criar o checkout no momento.');
    }

    if (!result.ok) {
      await this.markFailed(reservation.id, attemptId);
      this.logger.error(`Storefront API recusou o cart: ${result.userErrors.map((e) => e.message).join('; ')}`);
      throw new UnprocessableEntityException('Não foi possível criar o checkout — um item não está disponível na Shopify.');
    }

    const minutes = paymentWindowMinutes();
    let persisted: { paymentExpiresAt: Date }[];
    try {
      persisted = await this.prisma.$queryRaw<{ paymentExpiresAt: Date }[]>`
        UPDATE reservations
        SET checkout_state = 'ready', shopify_cart_id = ${result.cartId}, checkout_url = ${result.checkoutUrl},
            checkout_created_at = now(), payment_expires_at = now() + ${minutes} * interval '1 minute',
            status = 'pending_payment', updated_at = now()
        WHERE id = ${reservation.id}::uuid AND status = 'hold' AND expires_at > now()
          AND checkout_state = 'creating' AND reservation_binding_id = ${reservationBindingId}
        RETURNING payment_expires_at AS "paymentExpiresAt"
      `;
    } catch (err) {
      await this.markFailed(reservation.id, attemptId);
      this.logger.error(`Falha ao persistir checkout: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível concluir o checkout no momento.');
    }

    if (persisted.length !== 1) {
      // O cart foi criado na Shopify, mas não conseguimos gravar o
      // vínculo (perdemos a guarda 'creating' de algum jeito inesperado,
      // ou o banco falhou bem neste instante). Item 8 da Fase 6: um cart
      // órfão na Shopify é aceitável; uma Reservation inconsistente não
      // — por isso NÃO tentamos "corrigir" escrevendo por cima, só
      // falhamos fechado e deixamos o estado como está pra investigação/
      // nova tentativa.
      this.logger.error(`cartCreate teve sucesso mas não foi possível persistir o vínculo com a reserva ${reservation.id}.`);
      throw new ServiceUnavailableException('Não foi possível concluir o checkout no momento.');
    }

    return {
      reservationId: reservation.id,
      status: 'pending_payment',
      checkoutUrl: result.checkoutUrl,
      expiresAt: persisted[0].paymentExpiresAt.toISOString(),
    };
  }

  private async loadReservationForCheckout(reservationId: string) {
    try {
      return await this.prisma.reservation.findUnique({
        where: { id: reservationId },
        include: { items: { include: { rentalUnit: true } } },
      });
    } catch (err) {
      this.logger.error(`Falha ao consultar reserva para checkout: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível processar o checkout no momento.');
    }
  }

  /** "Esse HOLD venceu?" é decidido só pelo Postgres — o UPDATE abaixo só
   *  afeta uma linha se `status='hold' AND expires_at <= now()` for
   *  verdade NA HORA que o próprio banco avalia, nunca por uma comparação
   *  feita no relógio do processo Node. `$executeRaw` devolve a contagem
   *  de linhas afetadas — 1 linha = estava vencido, 0 linhas = não estava
   *  (ou já não estava mais em 'hold' por outro motivo). O WHERE guardado
   *  por status também é a proteção de concorrência: se duas chamadas
   *  corressem ao mesmo tempo pra este mesmo reservationId, só uma
   *  encontraria a linha ainda em 'hold' pra atualizar. */
  private async expireHoldIfDue(reservationId: string): Promise<boolean> {
    try {
      const updated = await this.prisma.$executeRaw`
        UPDATE reservations SET status = 'expired'
        WHERE id = ${reservationId}::uuid AND status = 'hold' AND expires_at <= now()
      `;
      return updated > 0;
    } catch (err) {
      this.logger.error(`Falha ao expirar reserva ${reservationId}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível processar o checkout no momento.');
    }
  }

  private async expirePaymentIfDue(reservationId: string): Promise<boolean> {
    const updated = await this.prisma.$executeRaw`
      UPDATE reservations SET status = 'expired'
      WHERE id = ${reservationId}::uuid AND status = 'pending_payment' AND payment_expires_at <= now()
    `;
    return updated > 0;
  }

  private async markFailed(reservationId: string, attemptId: string): Promise<void> {
    try {
      await this.prisma.reservation.updateMany({ where: { id: reservationId, checkoutState: 'creating', reservationBindingId: attemptId }, data: { checkoutState: 'failed' } });
    } catch (err) {
      // Não relança — já estamos no meio do tratamento de outra falha;
      // deixar em 'creating' (retentável depois de STALE_CREATING_MS) é
      // mais seguro do que mascarar o erro original com um novo.
      this.logger.error(`Falha ao marcar checkout como failed para ${reservationId}: ${errorCode(err)}`);
    }
  }

  private async claimCreatingState(
    reservationId: string,
    attemptId: string,
  ): Promise<{ claimed: true } | { claimed: false; state?: string; checkoutUrl?: string | null; paymentExpiresAt?: Date | null }> {
    try {
      const fromIdle = await this.prisma.reservation.updateMany({
        where: { id: reservationId, status: 'hold', checkoutState: { in: ['none', 'failed'] } },
        data: { checkoutState: 'creating', reservationBindingId: attemptId },
      });
      if (fromIdle.count === 1) return { claimed: true };

      const staleBefore = new Date(Date.now() - STALE_CREATING_MS);
      const fromStale = await this.prisma.reservation.updateMany({
        where: { id: reservationId, status: 'hold', checkoutState: 'creating', updatedAt: { lt: staleBefore } },
        data: { checkoutState: 'creating', reservationBindingId: attemptId },
      });
      if (fromStale.count === 1) return { claimed: true };

      const current = await this.prisma.reservation.findUnique({
        where: { id: reservationId },
        select: { status: true, checkoutState: true, checkoutUrl: true, paymentExpiresAt: true },
      });
      if (current?.status !== 'pending_payment' || await this.expirePaymentIfDue(reservationId)) return { claimed: false };
      return { claimed: false, state: current.checkoutState, checkoutUrl: current.checkoutUrl, paymentExpiresAt: current.paymentExpiresAt };
    } catch (err) {
      this.logger.error(`Falha ao tentar reivindicar criação de checkout para ${reservationId}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível criar o checkout no momento.');
    }
  }
}

function buildCartLines(items: NonNullable<ReservationWithItems>['items']): CartLineInput[] {
  const byVariant = new Map<string, number>();
  for (const item of items) {
    const variantId = item.rentalUnit.shopifyVariantId;
    if (!variantId) {
      throw new ConflictException('Uma das peças desta reserva não tem variante Shopify associada.');
    }
    byVariant.set(variantId, (byVariant.get(variantId) ?? 0) + 1);
  }
  return Array.from(byVariant.entries()).map(([variantId, quantity]) => ({
    merchandiseId: variantId.startsWith('gid://') ? variantId : `gid://shopify/ProductVariant/${variantId}`,
    quantity,
  }));
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
