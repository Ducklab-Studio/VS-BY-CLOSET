import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import type { RentalRuleConfig } from '../rental-rules/rental-rule-config';
import { type CivilDate, addDays, civilDateFromISO, civilDateFromPgDate, civilDateToISO, isBefore, isSunday } from '../rental-rules/civil-date';
import {
  blockedRangesOverlap,
  calculateBlockedRange,
  calculateReturnDate,
  countRentalPieces,
  durationForPieces,
  isOnlineReservationAllowed,
  today as engineToday,
  validateMaxPieces,
  validateMinimumAdvance,
} from '../rental-rules/rental-engine';
import { OCCUPYING_RESERVATION_STATUSES } from '../reservation-status';
import { ensureStoreConfig, resolveStoreConfig } from '../holds/store-config';
import { canTransition, type ReservationStatusValue } from '../webhooks/reservation-state-machine';
import { isRangeBlockedStoreWide, loadActiveStoreWideBlocks, loadActiveUnitBlocks, lockOperationalBlocks } from '../admin/operational-blocks';
import { ManualReservationBlockedError, ManualReservationInvalidUnitError, ManualReservationUnitConflictError } from './manual-reservation.errors';
import type { CreateManualReservationDto } from './dto/create-manual-reservation.dto';
import type { CancelManualReservationDto } from './dto/cancel-manual-reservation.dto';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ALLOCATION_ATTEMPTS = 2;

export interface ManualReservationItemResponse {
  readonly rentalUnitId: string;
  readonly code: string;
}

export interface ManualReservationResponse {
  readonly reservationId: string;
  readonly status: string;
  readonly source: string;
  readonly pickupDate: string;
  readonly returnDate: string;
  readonly items: readonly ManualReservationItemResponse[];
  readonly overridesApplied: readonly string[];
}

export interface ReservationListFilters {
  readonly status?: string;
  readonly source?: string;
  readonly from?: string;
  readonly to?: string;
  readonly customer?: string;
  readonly phone?: string;
  readonly unitCode?: string;
}

export interface ReservationListItem {
  readonly id: string;
  readonly status: string;
  readonly source: string;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly customerEmail: string | null;
  readonly pickupDate: string | null;
  readonly returnDate: string | null;
  readonly shopifyOrderId: string | null;
  readonly itemCount: number;
}

/** Fase 10 — versão enxuta usada só pelos relatórios PDF (item 2): sem
 *  `customerEmail`/`itemCount`, com `unitCodes` agregado no lugar. */
export interface ReservationReportItem {
  readonly id: string;
  readonly status: string;
  readonly source: string;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly pickupDate: string | null;
  readonly returnDate: string | null;
  readonly shopifyOrderId: string | null;
  readonly unitCodes: readonly string[];
}

export interface ReservationDetailResponse extends Omit<ReservationListItem, 'itemCount'> {
  readonly shopifyOrderGid: string | null;
  readonly checkoutState: string;
  readonly internalNote: string | null;
  readonly confirmedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly items: readonly { rentalUnitId: string; code: string; status: string; blockedFrom: string; blockedUntilExclusive: string }[];
  readonly events: readonly { type: string; detail: unknown; createdAt: string }[];
}

export interface ManualReservationCancelResponse {
  readonly reservationId: string;
  readonly status: string;
}

interface AttemptContext {
  readonly dto: CreateManualReservationDto;
  readonly storeId: string;
  readonly shopifyDomain: string;
  readonly currency: string;
  readonly pickupDate: CivilDate;
  readonly today: CivilDate;
  readonly config: RentalRuleConfig;
  readonly idempotencyKey: string | undefined;
  readonly requestHash: string | null;
}

/**
 * Fase 8 — criação/cancelamento de reserva manual pela equipe. Reaproveita
 * deliberadamente o que a Fase 5 já provou funcionar sob concorrência real
 * (mesmo arquivo, mesma técnica, não uma cópia): lock por ID em ordem fixa
 * (não UM `FOR UPDATE ... ORDER BY`, que não garante ordem de trava —
 * achado real da Fase 6, documentado em holds.service.ts), EXCLUDE
 * constraint como backstop final, Idempotency-Key via
 * `pg_advisory_xact_lock` — tabela PRÓPRIA (`manual_reservation_idempotency_keys`),
 * nunca a de HOLD, pra não misturar o espaço de chaves entre canais.
 *
 * A duração NUNCA é aceita como "o que a equipe mandou" sem checagem: por
 * padrão o RentalPlanEngine calcula a devolução exatamente como calcularia
 * pro HOLD público (mesmas funções exportadas de rental-engine.ts —
 * `durationForPieces`, `calculateReturnDate`, `isOnlineReservationAllowed`,
 * `validateMinimumAdvance`, `validateMaxPieces`, `isSunday` — nenhuma regra
 * reimplementada aqui). `returnDate`/`durationDays` explícitos só passam
 * batendo com o que o motor calcularia OU com `overrides.customDuration`
 * + `overrideReason`. A janela de temporada continua bloqueando por padrão;
 * `overrides.outsideOnlineSeason` abre uma exceção somente para esta reserva
 * manual, exige motivo e é autorizada exclusivamente para usuário ADMIN,
 * revalidado no banco no momento da ação. O canal público não é alterado.
 *
 * A única regra que o canal manual dispensa de verdade é `reservableOnline`
 * (item 8: "manual ≠ online" — esse flag é do canal público, irrelevante
 * aqui); por isso os itens passam pro motor sempre com `reservableOnline:
 * true` sintético — `countsTowardRentalDuration` de cada peça continua sendo
 * o REAL, lido do banco, nunca o que o corpo da requisição mandaria (o DTO
 * nem declara esse campo).
 *
 * Diferença deliberada do HOLD público: aqui a equipe escolhe as peças
 * físicas EXATAS (`rentalUnitId`), nunca "uma variante, o sistema escolhe
 * qual unidade" — por isso não usa `allocateFreeUnits`. E a reserva nasce
 * direto em `confirmed` (nunca `hold`/`pending_payment`/checkout
 * Shopify) — ver o comentário da migration sobre por que não existe um
 * status `manual_confirmed` separado.
 */
@Injectable()
export class AdminReservationsService {
  private readonly logger = new Logger(AdminReservationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rentalRuleConfig: RentalRuleConfigService,
  ) {}

  async createManual(dto: CreateManualReservationDto, idempotencyKey?: string): Promise<ManualReservationResponse> {
    if (idempotencyKey !== undefined) validateIdempotencyKeyFormat(idempotencyKey);

    const overrides = dto.overrides ?? {};
    const hasAnyOverride =
      overrides.minLeadTime === true ||
      overrides.customDuration === true ||
      overrides.outsideOnlineSeason === true;
    if (hasAnyOverride && !dto.overrideReason) {
      throw new BadRequestException('overrideReason é obrigatório quando algum override é usado.');
    }

    if (overrides.outsideOnlineSeason === true) {
      await this.assertAdminCanOverrideSeason(dto.adminUserId);
    }

    const unitIds = normalizeUnitIds(dto.items.map((i) => i.rentalUnitId));
    if (unitIds.length !== dto.items.length) {
      throw new BadRequestException('items não pode conter rentalUnitId duplicado.');
    }

    let config: RentalRuleConfig;
    try {
      config = await this.rentalRuleConfig.load();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`Falha inesperada ao carregar rental_rule_config: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível criar a reserva no momento.');
    }

    const store = resolveStoreConfig();
    const today = engineToday(config);
    const pickupDate = civilDateFromISO(dto.pickupDate);
    const requestHash = idempotencyKey ? hashRequestPayload(dto) : null;

    const ctx: AttemptContext = { dto, storeId: store.id, shopifyDomain: store.shopifyDomain, currency: store.currency, pickupDate, today, config, idempotencyKey, requestHash };

    for (let attempt = 1; attempt <= MAX_ALLOCATION_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.$transaction((tx) => this.attemptCreateManual(tx, ctx, unitIds), { timeout: 10_000, maxWait: 5_000 });
      } catch (err) {
        if (err instanceof HttpException) throw err;

        if (err instanceof ManualReservationInvalidUnitError) {
          throw new UnprocessableEntityException({ message: 'Uma ou mais peças não existem ou estão inativas.', invalidUnitIds: err.invalidUnitIds });
        }
        if (err instanceof ManualReservationUnitConflictError) {
          // Nunca contornável por override (item 6) — 409 sempre.
          throw new ConflictException({ message: 'Uma ou mais peças já estão ocupadas no período solicitado.', conflictingUnitIds: err.conflictingUnitIds });
        }
        if (err instanceof ManualReservationBlockedError) {
          // Fase 9, item 13 — mesmo princípio de double booking: nunca
          // contornável por override.
          throw new ConflictException({ message: 'Bloqueio operacional ativo para este período.', reason: err.reason, rentalUnitId: err.rentalUnitId ?? null });
        }
        if (isExcludeViolation(err)) {
          // Diferente do HOLD público: aqui não existe "tenta outra
          // unidade" (já foram escolhidas explicitamente). Uma segunda
          // tentativa só ajuda no caso residual de corrida genuína entre
          // o SELECT de ocupação e o INSERT.
          if (attempt < MAX_ALLOCATION_ATTEMPTS) continue;
          throw new ConflictException('Conflito de disponibilidade — tente novamente.');
        }
        if (isIdempotencyKeyConflict(err) && idempotencyKey) {
          const existing = await this.findIdempotencyKeyRow(idempotencyKey);
          if (existing) {
            if (existing.requestHash !== requestHash) {
              throw new ConflictException('Idempotency-Key já foi usada com um payload diferente.');
            }
            return this.buildResponseFromReservationId(existing.reservationId);
          }
          this.logger.error('Corrida de idempotência perdida, mas nenhuma linha vencedora encontrada.');
          throw new ServiceUnavailableException('Não foi possível criar a reserva no momento.');
        }

        this.logger.error(`Falha inesperada ao criar reserva manual: ${errorCode(err)}`);
        throw new ServiceUnavailableException('Não foi possível criar a reserva no momento.');
      }
    }

    throw new ServiceUnavailableException('Não foi possível criar a reserva no momento.');
  }

  /** A exceção de temporada é mais sensível que os outros overrides: o
   *  frontend não decide a role. Reconsulta `admin_users` aqui e só permite
   *  ADMIN ativo. Falha de banco vira 503 (fail closed), nunca autorização
   *  presumida. */
  private async assertAdminCanOverrideSeason(adminUserId: string | undefined): Promise<void> {
    if (!adminUserId) {
      throw new ForbiddenException('Exceção de temporada exige usuário ADMIN autenticado.');
    }

    let adminUser: { active: boolean; role: 'ADMIN' | 'STAFF' } | null;
    try {
      adminUser = await this.prisma.adminUser.findUnique({
        where: { id: adminUserId },
        select: { active: true, role: true },
      });
    } catch (err) {
      this.logger.error(`Falha ao validar role para override de temporada: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível validar a autorização do override no momento.');
    }

    if (!adminUser || !adminUser.active || adminUser.role !== 'ADMIN') {
      throw new ForbiddenException('Exceção de temporada é exclusiva de usuário ADMIN.');
    }
  }

  private async attemptCreateManual(tx: Prisma.TransactionClient, ctx: AttemptContext, unitIds: readonly string[]): Promise<ManualReservationResponse> {
    await lockOperationalBlocks(tx);
    const { dto, storeId, shopifyDomain, currency, pickupDate, today, config, idempotencyKey, requestHash } = ctx;
    const overrides = dto.overrides ?? {};

    if (idempotencyKey) {
      // Mesma técnica da Fase 5 (ver holds.service.ts) — tabela PRÓPRIA
      // deste canal (manual_reservation_idempotency_keys).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${idempotencyKey}))`;
      const existing = await tx.manualReservationIdempotencyKey.findUnique({ where: { key: idempotencyKey } });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException('Idempotency-Key já foi usada com um payload diferente.');
        }
        return this.buildResponseFromReservationId(existing.reservationId, tx);
      }
    }

    await ensureStoreConfig(tx, { id: storeId, shopifyDomain, currency });

    // Mesmo mecanismo lazy de expiração do HOLD público — reserva manual
    // não cria HOLD, mas pode competir por unidades com HOLDs vencidos de
    // outros clientes.
    await tx.$executeRaw`UPDATE reservations SET status = 'expired' WHERE status = 'hold' AND expires_at <= now()`;
    await tx.$executeRaw`UPDATE reservations SET status = 'expired' WHERE status = 'pending_payment' AND payment_expires_at <= now()`;

    // Lock por ID, em ordem fixa (ascendente) — UM lock por vez, não um
    // único `WHERE id = ANY(...) ORDER BY ... FOR UPDATE` (não garante
    // ordem de trava — mesma pegadinha documentada em holds.service.ts;
    // mesma ordem global entre QUALQUER transação que dispute
    // rental_units, incluindo HOLD e reserva manual competindo pela
    // mesma peça).
    const sortedUnitIds = [...unitIds].sort();
    const rows: { id: string; code: string; active: boolean; countsTowardRentalDuration: boolean }[] = [];
    for (const id of sortedUnitIds) {
      const found = await tx.$queryRaw<{ id: string; code: string; active: boolean; countsTowardRentalDuration: boolean }[]>`
        SELECT id, code, active, counts_toward_rental_duration AS "countsTowardRentalDuration"
        FROM rental_units WHERE id = ${id}::uuid FOR UPDATE
      `;
      rows.push(...found);
    }

    const invalidUnitIds = sortedUnitIds.filter((id) => {
      const row = rows.find((r) => r.id === id);
      return !row || !row.active;
    });
    if (invalidUnitIds.length > 0) {
      // Nada foi inserido ainda — lança antes de qualquer INSERT (item 1:
      // ALL OR NOTHING).
      throw new ManualReservationInvalidUnitError(invalidUnitIds);
    }

    const { effectiveReturnDate, overridesApplied } = resolveManualDuration({ dto, overrides, pickupDate, today, config, rows });

    const blockedRange = calculateBlockedRange(pickupDate, effectiveReturnDate, config);

    // Fase 9, item 6/13: bloqueio operacional (loja fechada, peça fora
    // de operação) nunca tem override, igual double booking. Checado
    // depois do FOR UPDATE (mesma proteção de concorrência das outras
    // checagens desta transação).
    const storeWideBlocks = await loadActiveStoreWideBlocks(tx, blockedRange.blockedFrom, blockedRange.blockedUntilExclusive);
    const storeWideReason = isRangeBlockedStoreWide(blockedRange, storeWideBlocks);
    if (storeWideReason) {
      throw new ManualReservationBlockedError(storeWideReason);
    }
    const unitBlocks = await loadActiveUnitBlocks(tx, sortedUnitIds);
    const blockedUnit = unitBlocks.find((b) => blockedRangesOverlap(b.range, blockedRange));
    if (blockedUnit) {
      throw new ManualReservationBlockedError(blockedUnit.reason, blockedUnit.unitId);
    }

    const occupiedRows = await tx.$queryRaw<{ rentalUnitId: string }[]>`
      SELECT DISTINCT rental_unit_id AS "rentalUnitId"
      FROM reservation_items
      WHERE rental_unit_id = ANY(${sortedUnitIds}::uuid[])
        AND status = ANY(${OCCUPYING_RESERVATION_STATUSES}::"reservation_status"[])
        AND blocked_range && daterange(${civilDateToISO(blockedRange.blockedFrom)}::date, ${civilDateToISO(blockedRange.blockedUntilExclusive)}::date, '[)')
    `;
    if (occupiedRows.length > 0) {
      // Nunca contornável por override (item 6) — a EXCLUDE constraint
      // continua soberana mesmo que esta checagem manual não pegasse.
      throw new ManualReservationUnitConflictError(occupiedRows.map((r) => r.rentalUnitId));
    }

    const [{ id: reservationId }] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO reservations (
        id, status, source, origin_store_id, pickup_date, return_date,
        customer_name, customer_phone, customer_email, internal_note, confirmed_at
      )
      VALUES (
        gen_random_uuid(), 'confirmed', 'manual_admin', ${storeId},
        ${civilDateToISO(pickupDate)}::date, ${civilDateToISO(effectiveReturnDate)}::date,
        ${dto.customerName}, ${dto.customerPhone}, ${dto.customerEmail ?? null}, ${dto.internalNote ?? null}, now()
      )
      RETURNING id
    `;

    for (const id of sortedUnitIds) {
      await tx.$executeRaw`
        INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
        VALUES (
          gen_random_uuid(), ${reservationId}::uuid, ${id}::uuid, 'confirmed',
          daterange(${civilDateToISO(blockedRange.blockedFrom)}::date, ${civilDateToISO(blockedRange.blockedUntilExclusive)}::date, '[)')
        )
      `;
    }

    if (idempotencyKey && requestHash) {
      await tx.$executeRaw`
        INSERT INTO manual_reservation_idempotency_keys ("key", request_hash, reservation_id)
        VALUES (${idempotencyKey}, ${requestHash}, ${reservationId}::uuid)
      `;
    }

    // Auditoria — item 11 da Fase 8. Nunca inclui secret/token; nunca
    // duplica nome/telefone (já estão na própria Reservation) — só o que
    // é específico deste evento de criação.
    await tx.reservationEvent.create({
      data: {
        reservationId,
        type: 'MANUAL_RESERVATION_CREATED',
        detail: {
          source: 'MANUAL_ADMIN',
          adminUserId: dto.adminUserId ?? null,
          adminUserName: dto.adminUserName ?? null,
          itemCount: sortedUnitIds.length,
          pickupDate: civilDateToISO(pickupDate),
          returnDate: civilDateToISO(effectiveReturnDate),
          overridesApplied,
          overrideReason: dto.overrideReason ?? null,
        } as Prisma.InputJsonValue,
      },
    });

    return {
      reservationId,
      status: 'confirmed',
      source: 'manual_admin',
      pickupDate: civilDateToISO(pickupDate),
      returnDate: civilDateToISO(effectiveReturnDate),
      items: rows.map((r) => ({ rentalUnitId: r.id, code: r.code })),
      overridesApplied,
    };
  }

  async cancelManual(reservationId: string, dto: CancelManualReservationDto): Promise<ManualReservationCancelResponse> {
    if (!UUID_RE.test(reservationId)) {
      throw new BadRequestException('reservationId inválido.');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const reservation = await tx.reservation.findUnique({ where: { id: reservationId } });
        if (!reservation) {
          throw new NotFoundException('Reserva não encontrada.');
        }

        // Item 5 do ajuste pedido: este endpoint só cancela reserva que
        // nasceu aqui mesmo. Cancelar reserva ONLINE paga/confirmada
        // envolve Shopify/pedido/pagamento fora de sincronia — fica pra
        // um fluxo próprio, consciente disso, numa fase futura.
        if (reservation.source !== 'manual_admin') {
          throw new ConflictException('Este endpoint só cancela reservas com source=manual_admin. Reserva online precisa de um fluxo próprio (fase futura).');
        }

        // Idempotente: cancelar uma reserva já cancelada não é erro.
        if (reservation.status === 'cancelled') {
          return { reservationId, status: 'cancelled' };
        }

        const from = reservation.status as ReservationStatusValue;
        if (!canTransition(from, 'cancelled')) {
          // Mesma máquina de estados centralizada dos webhooks (Fase 7) —
          // nunca reimplementada aqui.
          throw new ConflictException(`Reserva em status "${from}" não pode ser cancelada por este endpoint.`);
        }

        const updated = await tx.reservation.updateMany({ where: { id: reservationId, status: from }, data: { status: 'cancelled' } });
        if (updated.count !== 1) {
          throw new ConflictException('O status da reserva mudou durante o cancelamento — tente novamente.');
        }

        await tx.reservationEvent.create({
          data: {
            reservationId,
            type: 'MANUAL_RESERVATION_CANCELLED',
            detail: {
              source: 'MANUAL_ADMIN',
              adminUserId: dto.adminUserId ?? null,
              adminUserName: dto.adminUserName ?? null,
              from,
              to: 'cancelled',
              reason: dto.reason ?? null,
            } as Prisma.InputJsonValue,
          },
        });

        return { reservationId, status: 'cancelled' };
      }, { timeout: 10_000, maxWait: 5_000 });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`Falha ao cancelar reserva manual ${reservationId}: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível cancelar a reserva no momento.');
    }
  }

  /** Fase 9 — /closetadmin/reservas. Uma consulta só, filtros compostos
   *  dinamicamente (nunca concatenação de string — `Prisma.sql`/`Prisma.join`
   *  parametrizam tudo, mesma proteção contra injection do resto do
   *  projeto). */
  async listReservations(filters: ReservationListFilters): Promise<ReservationListItem[]> {
    const conditions = this.buildReservationFilterConditions(filters);

    try {
      return await this.prisma.$queryRaw<ReservationListItem[]>(Prisma.sql`
        SELECT
          r.id, r.status, r.source,
          r.customer_name AS "customerName", r.customer_phone AS "customerPhone", r.customer_email AS "customerEmail",
          r.pickup_date::text AS "pickupDate", r.return_date::text AS "returnDate",
          r.shopify_order_id AS "shopifyOrderId",
          (SELECT count(*)::int FROM reservation_items ri WHERE ri.reservation_id = r.id) AS "itemCount"
        FROM reservations r
        WHERE ${Prisma.join(conditions, ' AND ')}
        ORDER BY r.pickup_date DESC NULLS LAST, r.created_at DESC
        LIMIT 300
      `);
    } catch (err) {
      this.logger.error(`Falha ao listar reservas: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível listar as reservas no momento.');
    }
  }

  private buildReservationFilterConditions(filters: ReservationListFilters): Prisma.Sql[] {
    const conditions: Prisma.Sql[] = [Prisma.sql`1=1`];
    if (filters.status) conditions.push(Prisma.sql`r.status = ${filters.status}::"reservation_status"`);
    if (filters.source) conditions.push(Prisma.sql`r.source = ${filters.source}::"reservation_source"`);
    if (filters.from) conditions.push(Prisma.sql`r.pickup_date >= ${filters.from}::date`);
    if (filters.to) conditions.push(Prisma.sql`r.pickup_date <= ${filters.to}::date`);
    if (filters.customer) conditions.push(Prisma.sql`r.customer_name ILIKE ${'%' + filters.customer + '%'}`);
    if (filters.phone) conditions.push(Prisma.sql`r.customer_phone ILIKE ${'%' + filters.phone + '%'}`);
    if (filters.unitCode) {
      conditions.push(
        Prisma.sql`EXISTS (SELECT 1 FROM reservation_items ri2 JOIN rental_units ru2 ON ru2.id = ri2.rental_unit_id WHERE ri2.reservation_id = r.id AND ru2.code ILIKE ${'%' + filters.unitCode + '%'})`,
      );
    }
    return conditions;
  }

  /**
   * Fase 10, item 2 — mesma fonte/filtros de `listReservations`, mas com
   * os códigos das peças agregados numa query só (o relatório PDF
   * precisa deles; a tela de lista, não) — evita N+1 chamando
   * `getReservationDetail` reserva por reserva. `limit` é OBRIGATÓRIO e
   * sempre validado por quem chama (ver PeriodReportPdfService): "não
   * carregar o banco inteiro" é uma trava de contrato, não uma sugestão.
   */
  async listReservationsForReport(filters: ReservationListFilters, limit: number): Promise<ReservationReportItem[]> {
    const conditions = this.buildReservationFilterConditions(filters);

    try {
      return await this.prisma.$queryRaw<ReservationReportItem[]>(Prisma.sql`
        SELECT
          r.id, r.status, r.source,
          r.customer_name AS "customerName", r.customer_phone AS "customerPhone",
          r.pickup_date::text AS "pickupDate", r.return_date::text AS "returnDate",
          r.shopify_order_id AS "shopifyOrderId",
          COALESCE(
            (SELECT array_agg(ru.code ORDER BY ru.code) FROM reservation_items ri JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ri.reservation_id = r.id),
            ARRAY[]::text[]
          ) AS "unitCodes"
        FROM reservations r
        WHERE ${Prisma.join(conditions, ' AND ')}
        ORDER BY r.pickup_date DESC NULLS LAST, r.created_at DESC
        LIMIT ${limit}
      `);
    } catch (err) {
      this.logger.error(`Falha ao listar reservas para relatório: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível gerar o relatório no momento.');
    }
  }

  /** Conta o total real (sem LIMIT) — usado só pra decidir se o
   *  relatório precisa recusar com "intervalo menor" (item 7), nunca
   *  pra buscar as linhas em si. */
  async countReservationsForReport(filters: ReservationListFilters): Promise<number> {
    const conditions = this.buildReservationFilterConditions(filters);
    try {
      const [row] = await this.prisma.$queryRaw<{ count: bigint }[]>(
        Prisma.sql`SELECT count(*)::bigint AS count FROM reservations r WHERE ${Prisma.join(conditions, ' AND ')}`,
      );
      return Number(row.count);
    } catch (err) {
      this.logger.error(`Falha ao contar reservas para relatório: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível gerar o relatório no momento.');
    }
  }

  /** Fase 9 — detalhe da reserva (item 8: RentalUnits, blockedRange,
   *  Shopify order id quando existir, eventos, timestamps). */
  async getReservationDetail(id: string): Promise<ReservationDetailResponse> {
    if (!UUID_RE.test(id)) {
      throw new BadRequestException('reservationId inválido.');
    }

    const reservation = await this.prisma.reservation.findUnique({ where: { id } });
    if (!reservation) {
      throw new NotFoundException('Reserva não encontrada.');
    }

    const items = await this.prisma.$queryRaw<
      { rentalUnitId: string; code: string; status: string; blockedFrom: Date; blockedUntil: Date }[]
    >`
      SELECT ri.rental_unit_id AS "rentalUnitId", ru.code, ri.status,
             lower(ri.blocked_range) AS "blockedFrom", upper(ri.blocked_range) AS "blockedUntil"
      FROM reservation_items ri
      JOIN rental_units ru ON ru.id = ri.rental_unit_id
      WHERE ri.reservation_id = ${id}::uuid
      ORDER BY ru.code
    `;

    const events = await this.prisma.reservationEvent.findMany({
      where: { reservationId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    return {
      id: reservation.id,
      status: reservation.status,
      source: reservation.source,
      customerName: reservation.customerName,
      customerPhone: reservation.customerPhone,
      customerEmail: reservation.customerEmail,
      pickupDate: reservation.pickupDate ? civilDateToISO(civilDateFromPgDate(reservation.pickupDate)) : null,
      returnDate: reservation.returnDate ? civilDateToISO(civilDateFromPgDate(reservation.returnDate)) : null,
      shopifyOrderId: reservation.shopifyOrderId,
      shopifyOrderGid: reservation.shopifyOrderGid,
      checkoutState: reservation.checkoutState,
      internalNote: reservation.internalNote,
      confirmedAt: reservation.confirmedAt?.toISOString() ?? null,
      createdAt: reservation.createdAt.toISOString(),
      updatedAt: reservation.updatedAt.toISOString(),
      items: items.map((i) => ({
        rentalUnitId: i.rentalUnitId,
        code: i.code,
        status: i.status,
        blockedFrom: civilDateToISO(civilDateFromPgDate(i.blockedFrom)),
        blockedUntilExclusive: civilDateToISO(civilDateFromPgDate(i.blockedUntil)),
      })),
      events: events.map((e) => ({ type: e.type, detail: e.detail, createdAt: e.createdAt.toISOString() })),
    };
  }

  private async findIdempotencyKeyRow(key: string) {
    try {
      return await this.prisma.manualReservationIdempotencyKey.findUnique({ where: { key } });
    } catch (err) {
      this.logger.error(`Falha ao consultar manual_reservation_idempotency_keys: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível criar a reserva no momento.');
    }
  }

  private async buildResponseFromReservationId(
    reservationId: string,
    client: Pick<PrismaService | Prisma.TransactionClient, 'reservation' | '$queryRaw'> = this.prisma,
  ): Promise<ManualReservationResponse> {
    const reservation = await client.reservation.findUnique({ where: { id: reservationId } });
    if (!reservation || !reservation.pickupDate || !reservation.returnDate) {
      this.logger.error('Idempotency-Key aponta para reserva manual inexistente ou incompleta.');
      throw new ServiceUnavailableException('Não foi possível criar a reserva no momento.');
    }
    const rows = await client.$queryRaw<{ rentalUnitId: string; code: string }[]>`
      SELECT ru.id AS "rentalUnitId", ru.code AS "code"
      FROM reservation_items ri
      JOIN rental_units ru ON ru.id = ri.rental_unit_id
      WHERE ri.reservation_id = ${reservationId}::uuid
      ORDER BY ru.id
    `;

    return {
      reservationId,
      status: reservation.status,
      source: reservation.source,
      pickupDate: civilDateToISO(civilDateFromPgDate(reservation.pickupDate)),
      returnDate: civilDateToISO(civilDateFromPgDate(reservation.returnDate)),
      items: rows.map((r) => ({ rentalUnitId: r.rentalUnitId, code: r.code })),
      overridesApplied: [],
    };
  }
}

/**
 * Decide a devolução efetiva usando as MESMAS funções exportadas do
 * motor (rental-engine.ts) que o HOLD público usa — nunca uma cópia das
 * regras. Composto manualmente (em vez de chamar `calculateRentalPlan`
 * direto) porque essa função é tudo-ou-nada: se qualquer violação
 * ocorre, ela nem devolve `durationDays`/`calculatedReturnDate` — e o
 * fluxo manual precisa saber "quanto seria a duração correta" MESMO
 * quando uma violação (ex.: lead time) foi resolvida por override. As
 * peças primitivas (`durationForPieces`, `calculateReturnDate`,
 * `validateMinimumAdvance`, `isOnlineReservationAllowed`,
 * `validateMaxPieces`, `isSunday`) são exatamente as mesmas que
 * `calculateRentalPlan` chama por baixo — nenhuma regra reimplementada,
 * só composta na ordem que este fluxo precisa.
 */
function resolveManualDuration(input: {
  dto: CreateManualReservationDto;
  overrides: { minLeadTime?: boolean; customDuration?: boolean; outsideOnlineSeason?: boolean };
  pickupDate: CivilDate;
  today: CivilDate;
  config: RentalRuleConfig;
  rows: readonly { countsTowardRentalDuration: boolean }[];
}): { effectiveReturnDate: CivilDate; overridesApplied: string[] } {
  const { dto, overrides, pickupDate, today, config, rows } = input;

  const isMinAdvanceOk = validateMinimumAdvance(pickupDate, today, config);
  const isSeasonOk = isOnlineReservationAllowed(pickupDate, config);
  const isPickupSunday = isSunday(pickupDate);
  // `reservableOnline: true` sintético — item 8: essa checagem é do canal
  // público, irrelevante pra reserva manual. `countsTowardRentalDuration`
  // é sempre o REAL, lido do banco.
  const { countedPieces } = countRentalPieces(rows.map((r) => ({ reservableOnline: true, countsTowardRentalDuration: r.countsTowardRentalDuration })));
  const hasNoCountableItems = countedPieces === 0;
  const isMaxPiecesOk = hasNoCountableItems || validateMaxPieces(countedPieces, config);

  // Todas as violações são coletadas JUNTAS antes de decidir rejeitar —
  // mesmo padrão de calculateRentalPlan (avalia tudo, depois decide),
  // nunca lança na primeira que encontrar.
  const unresolved: string[] = [];
  const overridesApplied: string[] = [];
  if (isPickupSunday) unresolved.push('pickup_is_sunday');
  if (!isSeasonOk) {
    if (overrides.outsideOnlineSeason === true) {
      overridesApplied.push('outsideOnlineSeason');
    } else {
      unresolved.push('pickup_outside_season');
    }
  }
  if (!isMaxPiecesOk) unresolved.push('max_pieces_exceeded');

  const requestedExplicitDate = dto.returnDate ? civilDateFromISO(dto.returnDate) : dto.durationDays ? addDays(pickupDate, dto.durationDays) : null;

  if (!isMinAdvanceOk) {
    if (overrides.minLeadTime === true) {
      overridesApplied.push('minLeadTime');
    } else {
      unresolved.push('pickup_before_minimum_advance');
    }
  }

  if (unresolved.length > 0) {
    throw new UnprocessableEntityException({ message: 'Não foi possível criar a reserva manual.', violations: unresolved });
  }

  if (hasNoCountableItems) {
    // Sem nenhuma peça contável, o motor não tem como derivar duração
    // (mesma regra de durationForPieces: exige >=1 peça contável) — a
    // equipe PRECISA informar a data/duração diretamente, e isso é
    // sempre tratado como customDuration (não existe "o que o motor
    // calcularia" pra comparar aqui).
    if (!requestedExplicitDate) {
      throw new UnprocessableEntityException({ message: 'Não foi possível criar a reserva manual.', violations: ['no_reservable_items'] });
    }
    if (overrides.customDuration !== true) {
      throw new UnprocessableEntityException({ message: 'Não foi possível criar a reserva manual.', violations: ['no_reservable_items'] });
    }
    if (!isBefore(pickupDate, requestedExplicitDate)) {
      throw new UnprocessableEntityException({ message: 'pickupDate precisa ser antes de returnDate.', violations: ['pickup_not_before_return'] });
    }
    overridesApplied.push('customDuration');
    return { effectiveReturnDate: requestedExplicitDate, overridesApplied };
  }

  const engineDurationDays = durationForPieces(countedPieces, config);
  const engineReturnDate = calculateReturnDate(pickupDate, engineDurationDays);
  const hasSundayException = isSunday(engineReturnDate);
  const validDates = hasSundayException ? [addDays(engineReturnDate, -1), addDays(engineReturnDate, 1)] : [engineReturnDate];

  if (requestedExplicitDate) {
    if (!isBefore(pickupDate, requestedExplicitDate)) {
      throw new UnprocessableEntityException({ message: 'pickupDate precisa ser antes de returnDate.', violations: ['pickup_not_before_return'] });
    }
    const matchesEngine = validDates.some((d) => civilDateToISO(d) === civilDateToISO(requestedExplicitDate));
    if (matchesEngine) {
      return { effectiveReturnDate: requestedExplicitDate, overridesApplied };
    }
    if (overrides.customDuration !== true) {
      throw new UnprocessableEntityException({
        message: 'returnDate/durationDays informados não correspondem ao cálculo do RentalPlanEngine.',
        violations: ['duration_mismatch_with_engine'],
        expectedReturnDates: validDates.map(civilDateToISO),
      });
    }
    overridesApplied.push('customDuration');
    return { effectiveReturnDate: requestedExplicitDate, overridesApplied };
  }

  // Automático — mesmo caminho do HOLD público quando nada é informado.
  if (hasSundayException) {
    if (!dto.sundayReturnOption) {
      throw new UnprocessableEntityException({
        message: 'A devolução calculada cai num domingo — escolha "saturday" ou "mondayMorning".',
        violations: ['pickup_is_sunday_return'],
        returnOptions: validDates.map(civilDateToISO),
      });
    }
    const chosen = dto.sundayReturnOption === 'saturday' ? validDates[0] : validDates[1];
    return { effectiveReturnDate: chosen, overridesApplied };
  }

  return { effectiveReturnDate: engineReturnDate, overridesApplied };
}

function normalizeUnitIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids));
}

function hashRequestPayload(dto: CreateManualReservationDto): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        items: [...dto.items].map((i) => i.rentalUnitId).sort(),
        pickupDate: dto.pickupDate,
        returnDate: dto.returnDate ?? null,
        durationDays: dto.durationDays ?? null,
        sundayReturnOption: dto.sundayReturnOption ?? null,
        customerName: dto.customerName,
        customerPhone: dto.customerPhone,
        overrides: dto.overrides ?? null,
      }),
    )
    .digest('hex');
}

function validateIdempotencyKeyFormat(key: string): void {
  if (key.length < 1 || key.length > 200 || !/^[\x21-\x7E]+$/.test(key)) {
    throw new BadRequestException('Cabeçalho Idempotency-Key inválido.');
  }
}

function isExcludeViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes('reservation_items_no_overlap_per_unit');
}

function isIdempotencyKeyConflict(err: unknown): boolean {
  return err instanceof Error && err.message.includes('manual_reservation_idempotency_keys_pkey');
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
