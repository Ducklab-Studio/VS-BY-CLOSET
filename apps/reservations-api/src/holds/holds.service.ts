import { BadRequestException, ConflictException, HttpException, Injectable, Logger, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import type { RentalRuleConfig } from '../rental-rules/rental-rule-config';
import {
  type RentalCartItem,
  calculateBlockedRange,
  calculateRentalPlan,
  resolveEffectiveReturnDate,
  today as engineToday,
} from '../rental-rules/rental-engine';
import { type CivilDate, civilDateFromISO, civilDateFromPgDate, civilDateToISO, diffDays } from '../rental-rules/civil-date';
import { OCCUPYING_RESERVATION_STATUSES } from '../reservation-status';
import { ensureStoreConfig, type StoreConfig, resolveStoreConfig } from './store-config';
import { currentTermsVersion } from './terms';
import { generateHoldToken, hashHoldToken } from './hold-token';
import { IdempotencyRaceLostError, InsufficientCapacityError } from './holds.errors';
import { allocateFreeUnits } from './allocate-free-units';
import type { CreateHoldDto } from './dto/create-hold.dto';
import { isRangeBlockedStoreWide, loadActiveStoreWideBlocks, loadActiveUnitBlocks, lockOperationalBlocks } from '../admin/operational-blocks';
import { blockedRangesOverlap } from '../rental-rules/rental-engine';
import { TECHNICAL_MAX_PIECES } from '../rental-rules/rental-limits';

const MAX_ALLOCATION_ATTEMPTS = 3;

interface NormalizedItem {
  readonly shopifyVariantId: string;
  readonly quantity: number;
}

export interface HoldResponse {
  readonly reservationId: string;
  /** Estado no momento em que esta resposta foi montada — 'hold' sempre
   *  na criação; num replay de Idempotency-Key pode já ter mudado (ex.:
   *  expirado enquanto isso), e é isso que é devolvido, não um 'hold'
   *  fabricado. */
  readonly status: string;
  /**
   * Item 1 da Fase 6 — só vem preenchido na criação DE VERDADE (a
   * tentativa que efetivamente fez o INSERT). Num replay de
   * Idempotency-Key é `null` por construção, não por omissão: só o HASH
   * é gravado no banco (`hold_token_hash`), o texto puro nunca é
   * persistido em lugar nenhum — não tem como devolvê-lo de novo depois,
   * mesmo que quiséssemos. O cliente precisa guardar este valor no
   * momento em que chega.
   */
  readonly holdToken: string | null;
  readonly expiresAt: string;
  readonly pickupDate: string;
  readonly calculatedReturnDate: string;
  readonly effectiveReturnDate: string;
  readonly durationDays: number;
  readonly items: readonly NormalizedItem[];
}

/** Reservation/HoldIdempotencyKey precisam ser lidos tanto de dentro de
 *  uma transação (tx) quanto fora dela (this.prisma) — as duas formas
 *  compartilham a mesma interface de leitura, então os métodos que só
 *  leem aceitam qualquer uma das duas. */
type DbReader = Pick<PrismaService | Prisma.TransactionClient, 'reservation' | '$queryRaw'>;

/** Exportado só pra holds.retry.test.ts conseguir montar um contexto de
 *  teste tipado ao chamar attemptCreateHold diretamente (ver o porquê
 *  naquele arquivo — é fault injection, não um teste de banco real). */
export interface AttemptContext {
  readonly normalizedItems: readonly NormalizedItem[];
  readonly pickupDate: CivilDate;
  readonly sundayReturnOption: 'saturday' | 'mondayMorning' | null;
  readonly config: RentalRuleConfig;
  readonly today: CivilDate;
  readonly store: StoreConfig;
  readonly termsVersion: string;
  readonly idempotencyKey: string | undefined;
  readonly requestHash: string | null;
  /** Texto puro — só usado pra devolver na resposta da criação FRESCA.
   *  Nunca gravado; `holdTokenHash` (abaixo) é o que vai pro banco. */
  readonly holdToken: string;
  readonly holdTokenHash: string;
}

/**
 * Criação de HOLD — a peça central da Fase 5. Ver a íntegra do desenho
 * (por que FOR UPDATE, por que retry, por que idempotência é resolvida
 * por PK e não por lock de aplicação) no relatório final da fase.
 * Resumo rápido pra quem está lendo o código:
 *
 *  1. FOR UPDATE nas rental_units candidatas serializa qualquer outra
 *     tentativa concorrente para a MESMA variante — é isso que evita a
 *     corrida na prática, não o retry.
 *  2. A EXCLUDE constraint (reservation_items_no_overlap_per_unit) é a
 *     garantia de ÚLTIMA instância — mesmo se o passo 1 falhar por algum
 *     motivo não prÊvisto, o Postgres recusa o INSERT sobreposto.
 *  3. O retry (até 3 tentativas) só existe pra esse caso residual — uma
 *     tentativa que esbarrou na EXCLUDE tenta de novo com o estado
 *     atualizado; capacidade genuinamente insuficiente NUNCA é
 *     retentada (não adianta).
 *  4. Idempotency-Key: pg_advisory_xact_lock(hashtext(key)) serializa
 *     toda tentativa concorrente com a MESMA chave ANTES de tocar em
 *     qualquer unidade — quem chega depois, dentro da mesma transação,
 *     só lê o que a vencedora já criou e devolve o mesmo HOLD. A PK de
 *     hold_idempotency_keys é o backstop redundante (colisão de hash),
 *     não o mecanismo principal.
 */
@Injectable()
export class HoldsService {
  private readonly logger = new Logger(HoldsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rentalRuleConfig: RentalRuleConfigService,
  ) {}

  async createHold(dto: CreateHoldDto, idempotencyKey?: string): Promise<HoldResponse> {
    if (idempotencyKey !== undefined) validateIdempotencyKeyFormat(idempotencyKey);

    const normalizedItems = normalizeItems(dto.items);
    if (normalizedItems.reduce((total, item) => total + item.quantity, 0) > TECHNICAL_MAX_PIECES) {
      throw new BadRequestException('Quantidade acima do teto técnico permitido.');
    }
    const sundayReturnOption = dto.sundayReturnOption ?? null;
    const requestHash = idempotencyKey
      ? hashRequestPayload({ items: normalizedItems, pickupDate: dto.pickupDate, sundayReturnOption, termsAccepted: dto.termsAccepted })
      : null;

    let config: RentalRuleConfig;
    try {
      config = await this.rentalRuleConfig.load();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`Falha inesperada ao carregar rental_rule_config: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível criar a reserva no momento.');
    }

    // Sem aceite explícito, não existe HOLD — checado aqui (não só no
    // DTO) porque o formato "é um boolean" já passou no DTO; o que falta
    // validar é o VALOR.
    if (dto.termsAccepted !== true) {
      throw new UnprocessableEntityException('É necessário aceitar os termos para criar a reserva.');
    }

    const store = resolveStoreConfig();
    const termsVersion = currentTermsVersion();
    const today = engineToday(config);
    const pickupDate = civilDateFromISO(dto.pickupDate);
    const holdToken = generateHoldToken();
    const holdTokenHash = hashHoldToken(holdToken);

    const ctx: AttemptContext = {
      normalizedItems,
      pickupDate,
      sundayReturnOption,
      config,
      today,
      store,
      termsVersion,
      idempotencyKey,
      requestHash,
      holdToken,
      holdTokenHash,
    };

    for (let attempt = 1; attempt <= MAX_ALLOCATION_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.$transaction((tx) => this.attemptCreateHold(tx, ctx), { timeout: 10_000, maxWait: 5_000 });
      } catch (err) {
        if (err instanceof IdempotencyRaceLostError) {
          // Só alcançável em teoria (colisão de hashtext() entre duas
          // chaves DIFERENTES) — o pg_advisory_xact_lock em
          // attemptCreateHold já serializa toda tentativa concorrente com
          // a MESMA chave antes de chegar aqui. Mesmo assim, o tratamento
          // é real, não decorativo: fail closed se a linha vencedora não
          // aparecer.
          const existing = await this.findIdempotencyKeyRow(err.key);
          if (existing) {
            if (existing.requestHash !== requestHash) {
              throw new ConflictException('Idempotency-Key já foi usada com um payload diferente.');
            }
            return this.buildResponseFromReservationId(existing.reservationId, this.prisma);
          }
          this.logger.error('Corrida de idempotência perdida, mas nenhuma linha vencedora encontrada.');
          throw new ServiceUnavailableException('Não foi possível criar a reserva no momento.');
        }

        if (err instanceof InsufficientCapacityError) {
          throw new ConflictException('Não há unidades suficientes disponíveis para o período solicitado.');
        }

        if (err instanceof HttpException) throw err;

        if (isExcludeViolation(err)) {
          if (attempt < MAX_ALLOCATION_ATTEMPTS) continue;
          throw new ConflictException('Conflito de disponibilidade — tente novamente.');
        }

        this.logger.error(`Falha inesperada ao criar HOLD: ${errorCode(err)}`);
        throw new ServiceUnavailableException('Não foi possível criar a reserva no momento.');
      }
    }

    // Inalcançável: o loop sempre retorna ou lança antes de chegar aqui.
    throw new ServiceUnavailableException('Não foi possível criar a reserva no momento.');
  }

  private async attemptCreateHold(tx: Prisma.TransactionClient, ctx: AttemptContext): Promise<HoldResponse> {
    await lockOperationalBlocks(tx);
    const { normalizedItems, pickupDate, sundayReturnOption, config, today, store, termsVersion, idempotencyKey, requestHash, holdToken, holdTokenHash } = ctx;
    const variantIds = normalizedItems.map((i) => i.shopifyVariantId);

    if (idempotencyKey) {
      // pg_advisory_xact_lock serializa TODAS as tentativas concorrentes
      // com a MESMA chave — só uma por vez passa daqui pra frente; as
      // outras esperam aqui até a vencedora committar ou dar rollback (o
      // lock é liberado sozinho no fim da transação, sem unlock manual).
      // Sem isto, duas chamadas idênticas em paralelo (double-click) que
      // disputam a ÚLTIMA unidade livre podem terminar uma delas caindo
      // em "capacidade insuficiente" em vez de replicar o HOLD da outra
      // — foi exatamente o que a primeira versão deste serviço fazia
      // (bug real, pego pelo teste de double-click, não por inspeção).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${idempotencyKey}))`;

      const existing = await tx.holdIdempotencyKey.findUnique({ where: { key: idempotencyKey } });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException('Idempotency-Key já foi usada com um payload diferente.');
        }
        return this.buildResponseFromReservationId(existing.reservationId, tx);
      }
    }

    // A loja não tem linha real hoje (confirmado contra o Neon antes de
    // escrever este serviço) — upsert idempotente, nunca um INSERT cru
    // que falharia na segunda chamada.
    await ensureStoreConfig(tx, store);

    // Item 8/9 da Fase 5: expira ANTES de checar ocupação, na mesma
    // transação — sem isso, um HOLD vencido continuaria "ocupando" a
    // unidade pro resto desta tentativa.
    await tx.$executeRaw`UPDATE reservations SET status = 'expired' WHERE status = 'hold' AND expires_at <= now()`;
    // Item 13 da Fase 7: mesmo mecanismo, pra reservas que já passaram
    // do checkout mas venceram a janela de pagamento sem confirmação —
    // sem isso, `pending_payment` (que está em OCCUPYING_RESERVATION_STATUSES)
    // continuaria bloqueando a unidade pra sempre depois de vencida.
    // Nunca deleta a linha (item 13: "nunca delete" — um pagamento
    // tardio ainda precisa achar esta Reservation depois).
    await tx.$executeRaw`UPDATE reservations SET status = 'expired' WHERE status = 'pending_payment' AND payment_expires_at <= now()`;

    // Flags REAIS de cada variante — nunca as que o cliente mandou (o
    // DTO nem declara esses campos). Variante sem nenhuma RentalUnit
    // ativa cai no default {false, false}, que o motor rejeita como
    // 'contains_non_reservable_item' — mesmo tratamento de um acessório.
    const flagRows = await tx.$queryRaw<
      { shopifyVariantId: string; reservableOnline: boolean; countsTowardRentalDuration: boolean; unitCount: number }[]
    >`
      SELECT shopify_variant_id AS "shopifyVariantId",
             bool_and(reservable_online) AS "reservableOnline",
             bool_and(counts_toward_rental_duration) AS "countsTowardRentalDuration",
             count(*)::int AS "unitCount"
      FROM rental_units
      WHERE shopify_variant_id = ANY(${variantIds}::text[]) AND active = true
      GROUP BY shopify_variant_id
    `;
    const variantFlags = new Map(
      flagRows
        .filter((r) => r.unitCount > 0)
        .map((r) => [r.shopifyVariantId, { reservableOnline: r.reservableOnline, countsTowardRentalDuration: r.countsTowardRentalDuration }]),
    );

    const cartItems: RentalCartItem[] = [];
    for (const item of normalizedItems) {
      const flags = variantFlags.get(item.shopifyVariantId) ?? { reservableOnline: false, countsTowardRentalDuration: false };
      for (let i = 0; i < item.quantity; i++) cartItems.push(flags);
    }

    const planResult = calculateRentalPlan({ pickupDate, items: cartItems }, config, today);
    if (!planResult.ok) {
      throw new UnprocessableEntityException({ message: 'Não foi possível criar a reserva.', violations: planResult.violations });
    }
    const plan = planResult.plan;

    if (sundayReturnOption && !plan.hasSundayReturnException) {
      throw new UnprocessableEntityException(
        'Esta retirada não tem exceção de devolução no domingo — sundayReturnOption não se aplica aqui.',
      );
    }
    const effectiveReturnDate = resolveEffectiveReturnDate(plan, sundayReturnOption ?? undefined);
    if (!effectiveReturnDate) {
      // returnOptions vai junto — o frontend (carrinho) não tem como
      // recalcular essas datas sozinho sem duplicar o motor; é só
      // informação de exibição, a escolha em si (sundayReturnOption)
      // continua sendo validada contra o motor real na próxima tentativa.
      throw new UnprocessableEntityException({
        message: 'A devolução calculada cai num domingo — escolha "saturday" ou "mondayMorning".',
        violations: ['pickup_is_sunday_return'],
        returnOptions: plan.returnOptions.map((o) => ({ type: o.type, date: civilDateToISO(o.date), window: o.window })),
      });
    }

    const blockedRange = calculateBlockedRange(pickupDate, effectiveReturnDate, config);

    // IDs are immutable; all allocation paths acquire unit locks in ascending ID order.
    const candidates = await tx.$queryRaw<{ id: string; shopifyVariantId: string }[]>`
        SELECT id, shopify_variant_id AS "shopifyVariantId"
        FROM rental_units
        WHERE shopify_variant_id = ANY(${variantIds}::text[]) AND active = true AND reservable_online = true
        ORDER BY id
        FOR UPDATE
      `;

    const candidateIds = candidates.map((c) => c.id);
    const occupiedRows = candidateIds.length
      ? await tx.$queryRaw<{ rentalUnitId: string }[]>`
          SELECT DISTINCT rental_unit_id AS "rentalUnitId"
          FROM reservation_items
          WHERE rental_unit_id = ANY(${candidateIds}::uuid[])
            AND status = ANY(${OCCUPYING_RESERVATION_STATUSES}::"reservation_status"[])
            AND (
              blocked_range && daterange(${civilDateToISO(blockedRange.blockedFrom)}::date, ${civilDateToISO(blockedRange.blockedUntilExclusive)}::date, '[)')
              OR (status IN ('returned', 'cleaning') AND lower(blocked_range) <= ${civilDateToISO(blockedRange.blockedUntilExclusive)}::date)
            )
        `
      : [];
    const occupiedIds = new Set(occupiedRows.map((r) => r.rentalUnitId));
    const storeBlocks = await loadActiveStoreWideBlocks(tx, blockedRange.blockedFrom, blockedRange.blockedUntilExclusive);
    if (isRangeBlockedStoreWide(blockedRange, storeBlocks) !== null) {
      throw new ConflictException('Não há disponibilidade para o período solicitado.');
    }
    const unitBlocks = await loadActiveUnitBlocks(tx, candidateIds);
    for (const block of unitBlocks) {
      if (blockedRangesOverlap(block.range, blockedRange)) occupiedIds.add(block.unitId);
    }

    const needed = new Map(normalizedItems.map((i) => [i.shopifyVariantId, i.quantity]));
    const allocationResult = allocateFreeUnits(candidates, occupiedIds, needed);
    if (!allocationResult.ok) {
      // Lançado ANTES de qualquer INSERT — nada pra desfazer. Item 1 da
      // Fase 5 (ALL OR NOTHING): basta não escrever nada.
      throw new InsufficientCapacityError(allocationResult.shortfall);
    }

    const [{ id: reservationId, expiresAt }] = await tx.$queryRaw<{ id: string; expiresAt: Date }[]>`
      INSERT INTO reservations (id, status, origin_store_id, pickup_date, return_date, calculated_return_date, rental_duration_days, expires_at, terms_accepted_at, terms_version, hold_token_hash)
      VALUES (
        gen_random_uuid(), 'hold', ${store.id},
        ${civilDateToISO(pickupDate)}::date, ${civilDateToISO(effectiveReturnDate)}::date,
        ${civilDateToISO(plan.calculatedReturnDate)}::date, ${plan.durationDays},
        now() + interval '30 minutes', now(), ${termsVersion}, ${holdTokenHash}
      )
      RETURNING id, expires_at AS "expiresAt"
    `;

    for (const unitIds of allocationResult.allocation.values()) {
      for (const unitId of unitIds) {
        await tx.$executeRaw`
          INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
          VALUES (
            gen_random_uuid(), ${reservationId}::uuid, ${unitId}::uuid, 'hold',
            daterange(${civilDateToISO(blockedRange.blockedFrom)}::date, ${civilDateToISO(blockedRange.blockedUntilExclusive)}::date, '[)')
          )
        `;
      }
    }

    if (idempotencyKey && requestHash) {
      try {
        await tx.$executeRaw`
          INSERT INTO hold_idempotency_keys ("key", request_hash, reservation_id)
          VALUES (${idempotencyKey}, ${requestHash}, ${reservationId}::uuid)
        `;
      } catch (err) {
        if (isIdempotencyKeyConflict(err)) throw new IdempotencyRaceLostError(idempotencyKey);
        throw err;
      }
    }

    return {
      reservationId,
      status: 'hold',
      holdToken,
      expiresAt: expiresAt.toISOString(),
      pickupDate: civilDateToISO(pickupDate),
      calculatedReturnDate: civilDateToISO(plan.calculatedReturnDate),
      effectiveReturnDate: civilDateToISO(effectiveReturnDate),
      durationDays: plan.durationDays,
      items: normalizedItems,
    };
  }

  private async findIdempotencyKeyRow(key: string) {
    try {
      return await this.prisma.holdIdempotencyKey.findUnique({ where: { key } });
    } catch (err) {
      this.logger.error(`Falha ao consultar hold_idempotency_keys: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível criar a reserva no momento.');
    }
  }

  /**
   * Replay uses the accepted snapshot, never today's rental rules.
   * Legacy rows without a snapshot retain their recorded effective dates.
   */
  private async buildResponseFromReservationId(reservationId: string, client: DbReader): Promise<HoldResponse> {
    let reservation;
    let rows;
    try {
      reservation = await client.reservation.findUnique({ where: { id: reservationId } });
      rows = await client.$queryRaw<{ shopifyVariantId: string | null; countsTowardRentalDuration: boolean }[]>`
        SELECT ru.shopify_variant_id AS "shopifyVariantId", ru.counts_toward_rental_duration AS "countsTowardRentalDuration"
        FROM reservation_items ri
        JOIN rental_units ru ON ru.id = ri.rental_unit_id
        WHERE ri.reservation_id = ${reservationId}::uuid
      `;
    } catch (err) {
      this.logger.error(`Falha ao recuperar reserva para replay de idempotência: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível criar a reserva no momento.');
    }

    if (!reservation || !reservation.pickupDate || !reservation.returnDate || !reservation.expiresAt) {
      this.logger.error('Idempotency-Key aponta para reserva inexistente ou incompleta.');
      throw new ServiceUnavailableException('Não foi possível criar a reserva no momento.');
    }

    const grouped = new Map<string, number>();
    for (const row of rows) {
      if (!row.shopifyVariantId) continue;
      grouped.set(row.shopifyVariantId, (grouped.get(row.shopifyVariantId) ?? 0) + 1);
    }

    const pickupDate = civilDateFromPgDate(reservation.pickupDate);
    const effectiveReturnDate = civilDateFromPgDate(reservation.returnDate);
    const calculatedReturnDate = reservation.calculatedReturnDate ? civilDateFromPgDate(reservation.calculatedReturnDate) : effectiveReturnDate;
    const durationDays = reservation.rentalDurationDays ?? diffDays(calculatedReturnDate, pickupDate);

    return {
      reservationId,
      status: reservation.status,
      holdToken: null,
      expiresAt: reservation.expiresAt.toISOString(),
      pickupDate: civilDateToISO(pickupDate),
      calculatedReturnDate: civilDateToISO(calculatedReturnDate),
      effectiveReturnDate: civilDateToISO(effectiveReturnDate),
      durationDays,
      items: Array.from(grouped.entries()).map(([shopifyVariantId, quantity]) => ({ shopifyVariantId, quantity })),
    };
  }
}

/** Junta itens com a mesma variante (soma quantidade) em vez de rejeitar
 *  — decisão explícita do item 14 da Fase 5 ("normalize/agrupe... ou
 *  rejeite"); agrupar é mais tolerante a um carrinho que naturalmente
 *  tem duas linhas da mesma peça. Ordenado por variantId pra hash de
 *  idempotência ser determinístico independente da ordem de chegada. */
function normalizeItems(items: readonly { shopifyVariantId: string; quantity: number }[]): NormalizedItem[] {
  const byVariant = new Map<string, number>();
  for (const item of items) {
    byVariant.set(item.shopifyVariantId, (byVariant.get(item.shopifyVariantId) ?? 0) + item.quantity);
  }
  return Array.from(byVariant.entries())
    .map(([shopifyVariantId, quantity]) => ({ shopifyVariantId, quantity }))
    .sort((a, b) => a.shopifyVariantId.localeCompare(b.shopifyVariantId));
}

function hashRequestPayload(input: {
  items: readonly NormalizedItem[];
  pickupDate: string;
  sundayReturnOption: 'saturday' | 'mondayMorning' | null;
  termsAccepted: boolean;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

function validateIdempotencyKeyFormat(key: string): void {
  if (key.length < 1 || key.length > 200 || !/^[\x21-\x7E]+$/.test(key)) {
    throw new BadRequestException('Cabeçalho Idempotency-Key inválido.');
  }
}

/** Mesmo padrão empírico já usado em test/concurrency.manual.ts: a forma
 *  mais confiável de identificar QUAL constraint disparou, testada de
 *  verdade contra o Neon (não assumida a partir da forma do erro do
 *  Prisma, que varia por versão). */
function isExcludeViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes('reservation_items_no_overlap_per_unit');
}

function isIdempotencyKeyConflict(err: unknown): boolean {
  return err instanceof Error && err.message.includes('hold_idempotency_keys_pkey');
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
