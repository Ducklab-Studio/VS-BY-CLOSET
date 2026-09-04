import { ConflictException, ForbiddenException, GoneException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { durationForPieces } from '../rental-rules/rental-engine';
import { civilDateFromPgDate, civilDateToISO } from '../rental-rules/civil-date';
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

    // Expira com o MESMO mecanismo oficial do HoldsService (UPDATE
    // guardado por status+expires_at) — nunca cria carrinho pra um HOLD
    // vencido, mesmo que o status ainda esteja "hold" no banco (a
    // expiração é lazy, não por cron).
    if (reservation.status === 'hold' && reservation.expiresAt && reservation.expiresAt.getTime() <= Date.now()) {
      await this.expireThisReservation(reservation.id);
      throw new GoneException('Este HOLD expirou.');
    }

    if (reservation.status !== 'hold') {
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
    const claim = await this.claimCreatingState(reservation.id);
    if (!claim.claimed) {
      if (claim.state === 'ready' && claim.checkoutUrl && claim.paymentExpiresAt) {
        return { reservationId: reservation.id, status: 'pending_payment', checkoutUrl: claim.checkoutUrl, expiresAt: claim.paymentExpiresAt.toISOString() };
      }
      throw new ConflictException('O checkout desta reserva já está sendo criado — tente novamente em instantes.');
    }

    let config;
    try {
      config = await this.rentalRuleConfig.load();
    } catch (err) {
      await this.markFailed(reservation.id);
      this.logger.error(`Falha ao carregar rental_rule_config pro checkout: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível criar o checkout no momento.');
    }

    const countedPieces = reservation.items.filter((item) => item.rentalUnit.countsTowardRentalDuration).length;
    const durationDays = countedPieces > 0 ? durationForPieces(countedPieces, config) : 0;
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
      reservationBindingId = generateReservationBindingId();
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
      await this.markFailed(reservation.id);
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
      await this.markFailed(reservation.id);
      this.logger.error(`Falha ao chamar Storefront API (cartCreate): ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível criar o checkout no momento.');
    }

    if (!result.ok) {
      await this.markFailed(reservation.id);
      this.logger.error(`Storefront API recusou o cart: ${result.userErrors.map((e) => e.message).join('; ')}`);
      throw new UnprocessableEntityException('Não foi possível criar o checkout — um item não está disponível na Shopify.');
    }

    const paymentExpiresAt = new Date(Date.now() + paymentWindowMinutes() * 60_000);
    const persisted = await this.prisma.reservation.updateMany({
      where: { id: reservation.id, checkoutState: 'creating' },
      data: {
        checkoutState: 'ready',
        shopifyCartId: result.cartId,
        reservationBindingId,
        checkoutUrl: result.checkoutUrl,
        checkoutCreatedAt: new Date(),
        paymentExpiresAt,
        status: 'pending_payment',
      },
    });

    if (persisted.count !== 1) {
      // O cart foi criado na Shopify, mas não conseguimos gravar o
      // vínculo (perdemos a guarda 'creating' de algum jeito inesperado,
      // ou o banco falhou bem neste instante). Item 8 da Fase 6: um cart
      // órfão na Shopify é aceitável; uma Reservation inconsistente não
      // — por isso NÃO tentamos "corrigir" escrevendo por cima, só
      // falhamos fechado e deixamos o estado como está pra investigação/
      // nova tentativa.
      this.logger.error(`cartCreate teve sucesso (cart ${result.cartId}) mas não foi possível persistir o vínculo com a reserva ${reservation.id}.`);
      throw new ServiceUnavailableException('Não foi possível concluir o checkout no momento.');
    }

    return {
      reservationId: reservation.id,
      status: 'pending_payment',
      checkoutUrl: result.checkoutUrl,
      expiresAt: paymentExpiresAt.toISOString(),
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

  private async expireThisReservation(reservationId: string): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE reservations SET status = 'expired'
        WHERE id = ${reservationId}::uuid AND status = 'hold' AND expires_at <= now()
      `;
    } catch (err) {
      this.logger.error(`Falha ao expirar reserva ${reservationId}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível processar o checkout no momento.');
    }
  }

  private async markFailed(reservationId: string): Promise<void> {
    try {
      await this.prisma.reservation.updateMany({ where: { id: reservationId, checkoutState: 'creating' }, data: { checkoutState: 'failed' } });
    } catch (err) {
      // Não relança — já estamos no meio do tratamento de outra falha;
      // deixar em 'creating' (retentável depois de STALE_CREATING_MS) é
      // mais seguro do que mascarar o erro original com um novo.
      this.logger.error(`Falha ao marcar checkout como failed para ${reservationId}: ${errorCode(err)}`);
    }
  }

  private async claimCreatingState(
    reservationId: string,
  ): Promise<{ claimed: true } | { claimed: false; state?: string; checkoutUrl?: string | null; paymentExpiresAt?: Date | null }> {
    try {
      const fromIdle = await this.prisma.reservation.updateMany({
        where: { id: reservationId, checkoutState: { in: ['none', 'failed'] } },
        data: { checkoutState: 'creating' },
      });
      if (fromIdle.count === 1) return { claimed: true };

      const staleBefore = new Date(Date.now() - STALE_CREATING_MS);
      const fromStale = await this.prisma.reservation.updateMany({
        where: { id: reservationId, checkoutState: 'creating', updatedAt: { lt: staleBefore } },
        data: { checkoutState: 'creating' }, // bump updatedAt (@updatedAt) — reclama a tentativa
      });
      if (fromStale.count === 1) return { claimed: true };

      const current = await this.prisma.reservation.findUnique({
        where: { id: reservationId },
        select: { checkoutState: true, checkoutUrl: true, paymentExpiresAt: true },
      });
      return { claimed: false, state: current?.checkoutState, checkoutUrl: current?.checkoutUrl, paymentExpiresAt: current?.paymentExpiresAt };
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
