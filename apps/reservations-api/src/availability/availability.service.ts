import { HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import {
  type BlockedRange,
  type PlanViolation,
  blockedRangesOverlap,
  calculateBlockedRange,
  calculateRentalPlan,
  today as engineToday,
} from '../rental-rules/rental-engine';
import { addDays, civilDate, civilDateFromISO, civilDateFromPgDate, civilDateToISO, compareCivilDates, diffDays } from '../rental-rules/civil-date';
import { OCCUPYING_RESERVATION_STATUSES } from '../reservation-status';
import type { AvailabilityQueryDto } from './dto/availability-query.dto';
import { loadActiveStoreWideBlocks, loadActiveUnitBlocks } from '../admin/operational-blocks';

const MAX_RANGE_DAYS = 180;
const DEFAULT_RANGE_DAYS = 120;

export type DayUnavailableReason = PlanViolation | 'no_units_available';

export interface AvailabilityDay {
  readonly date: string;
  readonly bookable: boolean;
  readonly quantityAvailable: number;
  readonly reason: DayUnavailableReason | null;
  /**
   * Presentes só quando `bookable` — são o mesmo `plan` que
   * `calculateRentalPlan` já calculou pra decidir se o dia é reservável.
   * Expostos aqui de propósito: o frontend NÃO deve ter sua própria
   * cópia da lógica de duração/devolução (existia uma em
   * `apps/marketing/src/lib/rental-rules.ts` antes desta fase) — ele só
   * lê o que o motor real, aqui no servidor, já calculou. Uma fonte de
   * verdade só.
   */
  readonly durationDays?: number;
  readonly calculatedReturnDate?: string;
  readonly hasSundayReturnException?: boolean;
  readonly returnOptions?: readonly { type: 'saturday' | 'mondayMorning'; date: string; window?: string }[];
}

export interface AvailabilityResponse {
  readonly shopifyVariantId: string;
  readonly countedPieces: number;
  readonly unitsTotal: number;
  readonly days: readonly AvailabilityDay[];
}

@Injectable()
export class AvailabilityService {
  private readonly logger = new Logger(AvailabilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rentalRuleConfig: RentalRuleConfigService,
  ) {}

  async getAvailability(query: AvailabilityQueryDto): Promise<AvailabilityResponse> {
    // FAIL CLOSED: qualquer uma das consultas abaixo que falhar propaga
    // como ServiceUnavailableException — nunca cai num catch genérico que
    // devolveria disponibilidade inventada. `RentalRuleConfigService.load()`
    // já se protege sozinho (converte erro de banco em
    // ServiceUnavailableException), mas não confio só nisso: uma segunda
    // camada aqui garante que QUALQUER falha inesperada nessa chamada —
    // não só as que eu previ ao escrever aquele serviço — vira 503 sem
    // vazar mensagem de infraestrutura, em vez de virar um 500 cru com o
    // erro original do driver.
    let config;
    try {
      config = await this.rentalRuleConfig.load();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`Falha inesperada ao carregar rental_rule_config: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível consultar a disponibilidade no momento.');
    }

    const units = await this.loadUnits(query.shopifyVariantId);
    if (units.length === 0) {
      throw new NotFoundException('Nenhuma unidade cadastrada para esta variante.');
    }

    const reservableUnits = units.filter((u) => u.reservableOnline);
    if (reservableUnits.length === 0) {
      // Item 6 da Fase 4: mesmo que o frontend nunca chame isto pra um
      // acessório, se chamar (bug, ou request forjada), rejeita aqui —
      // não devolve uma grade de disponibilidade vazia como se fosse
      // "sem estoque", que esconderia a causa real.
      throw new UnprocessableEntityException('Este item não está disponível para reserva online.');
    }

    const today = engineToday(config);
    const fromDate = query.from ? civilDateFromISO(query.from) : today;
    const toDate = query.to ? civilDateFromISO(query.to) : addDays(today, DEFAULT_RANGE_DAYS);

    if (compareCivilDates(toDate, fromDate) < 0) {
      throw new UnprocessableEntityException('"to" não pode ser anterior a "from".');
    }
    if (diffDays(toDate, fromDate) > MAX_RANGE_DAYS) {
      throw new UnprocessableEntityException(`Período solicitado excede o máximo de ${MAX_RANGE_DAYS} dias.`);
    }

    // Uma consulta só, cobrindo toda a janela — não uma por dia. A janela
    // de busca de ocupações é mais larga que [from,to] porque uma
    // reserva com blockedFrom ANTES de `from` (por causa do prepDays)
    // ainda pode se sobrepor com um pickup dentro de [from,to].
    const searchFrom = addDays(fromDate, -config.prepDays);
    const maxDuration = Math.max(...config.piecesToDaysTable.map((row) => row.days));
    const searchTo = addDays(toDate, maxDuration + config.cleaningDays + 2);
    const occupied = await this.loadOccupiedRanges(
      reservableUnits.map((u) => u.id),
      searchFrom,
      searchTo,
    );

    const items = Array.from({ length: query.countedPieces }, () => ({
      reservableOnline: true,
      countsTowardRentalDuration: true,
    }));

    const days: AvailabilityDay[] = [];
    for (let d = fromDate; compareCivilDates(d, toDate) <= 0; d = addDays(d, 1)) {
      days.push(this.computeDay(d, items, config, today, reservableUnits, occupied));
    }

    return {
      shopifyVariantId: query.shopifyVariantId,
      countedPieces: query.countedPieces,
      unitsTotal: reservableUnits.length,
      days,
    };
  }

  private computeDay(
    pickupDate: ReturnType<typeof civilDate>,
    items: { reservableOnline: boolean; countsTowardRentalDuration: boolean }[],
    config: Awaited<ReturnType<RentalRuleConfigService['load']>>,
    today: ReturnType<typeof civilDate>,
    reservableUnits: { id: string }[],
    occupied: { unitId: string; range: BlockedRange }[],
  ): AvailabilityDay {
    const planResult = calculateRentalPlan({ pickupDate, items }, config, today);

    if (!planResult.ok) {
      return {
        date: civilDateToISO(pickupDate),
        bookable: false,
        quantityAvailable: 0,
        reason: planResult.violations[0] ?? null,
      };
    }

    const plan = planResult.plan;
    // Item 7 da Fase 4: a disponibilidade tem que poder ser calculada
    // pra CADA effectiveReturnDate possível — sem exceção de domingo é
    // só a data calculada; com exceção, são as duas opções aprovadas
    // (sábado / segunda). O dia conta como reservável se PELO MENOS UMA
    // das opções tiver unidade livre — a escolha entre elas acontece na
    // Fase 5 (HOLD), não aqui.
    const candidateReturns = plan.hasSundayReturnException
      ? plan.returnOptions.map((o) => o.date)
      : [plan.calculatedReturnDate];

    let bestAvailable = 0;
    for (const effectiveReturn of candidateReturns) {
      const range = calculateBlockedRange(pickupDate, effectiveReturn, config);
      const freeCount = reservableUnits.filter(
        (unit) => !occupied.some((o) => o.unitId === unit.id && blockedRangesOverlap(o.range, range)),
      ).length;
      bestAvailable = Math.max(bestAvailable, freeCount);
    }

    return {
      date: civilDateToISO(pickupDate),
      bookable: bestAvailable > 0,
      quantityAvailable: bestAvailable,
      reason: bestAvailable > 0 ? null : 'no_units_available',
      durationDays: plan.durationDays,
      calculatedReturnDate: civilDateToISO(plan.calculatedReturnDate),
      hasSundayReturnException: plan.hasSundayReturnException,
      returnOptions: plan.returnOptions.map((o) => ({
        type: o.type,
        date: civilDateToISO(o.date),
        window: o.window,
      })),
    };
  }

  private async loadUnits(shopifyVariantId: string): Promise<{ id: string; reservableOnline: boolean }[]> {
    try {
      return await this.prisma.rentalUnit.findMany({
        where: { shopifyVariantId, active: true },
        select: { id: true, reservableOnline: true },
      });
    } catch (err) {
      this.logger.error(`Falha ao consultar rental_units: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível consultar a disponibilidade no momento.');
    }
  }

  private async loadOccupiedRanges(
    unitIds: string[],
    searchFrom: ReturnType<typeof civilDate>,
    searchTo: ReturnType<typeof civilDate>,
  ): Promise<{ unitId: string; range: BlockedRange }[]> {
    if (unitIds.length === 0) return [];

    type Row = { rentalUnitId: string; lo: Date; hi: Date };
    let rows: Row[];
    try {
      rows = await this.prisma.$queryRaw<Row[]>`
        SELECT
          rental_unit_id AS "rentalUnitId",
          lower(blocked_range) AS "lo",
          upper(blocked_range) AS "hi"
        FROM reservation_items
        WHERE rental_unit_id = ANY(${unitIds}::uuid[])
          AND status = ANY(${OCCUPYING_RESERVATION_STATUSES}::"reservation_status"[])
          AND blocked_range && daterange(${civilDateToISO(searchFrom)}::date, ${civilDateToISO(searchTo)}::date, '[)')
      `;
    } catch (err) {
      this.logger.error(`Falha ao consultar reservation_items: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível consultar a disponibilidade no momento.');
    }

    const occupied = rows.map((row) => ({
      unitId: row.rentalUnitId,
      range: { blockedFrom: civilDateFromPgDate(row.lo), blockedUntilExclusive: civilDateFromPgDate(row.hi) },
    }));
    try {
      const unitBlocks = await loadActiveUnitBlocks(this.prisma, unitIds);
      const storeBlocks = await loadActiveStoreWideBlocks(this.prisma, searchFrom, searchTo);
      return [...occupied, ...unitBlocks, ...storeBlocks.flatMap((range) => unitIds.map((unitId) => ({ unitId, range })))];
    } catch (err) {
      this.logger.error(`Falha ao consultar bloqueios operacionais: ${errorCode(err)}`);
      throw new ServiceUnavailableException('Não foi possível consultar a disponibilidade no momento.');
    }
  }
}

function errorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : 'unknown';
}
