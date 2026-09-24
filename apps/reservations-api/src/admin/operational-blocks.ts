import type { Prisma } from '@prisma/client';
import { type BlockedRange, blockedRangesOverlap } from '../rental-rules/rental-engine';
import { addDays, civilDateFromPgDate, civilDateToISO } from '../rental-rules/civil-date';
import type { PrismaService } from '../prisma/prisma.service';

/**
 * Fase 9, item 13: bloqueio operacional precisa afetar o BACKEND de
 * verdade (disponibilidade, calendário, reserva manual, fluxo público),
 * nunca só aparecer visualmente. Estas duas funções são a fonte única
 * consultada por AvailabilityService, HoldsService e
 * AdminReservationsService — nenhuma reimplementa a query.
 *
 * Nunca há override para bloqueio (mesmo princípio de double booking —
 * item 6 da Fase 8, estendido aqui): é realidade operacional (loja
 * fechada, peça quebrada), não uma regra de negócio soft.
 */

export interface StoreWideBlockRange {
  readonly blockedFrom: ReturnType<typeof civilDateFromPgDate>;
  readonly blockedUntilExclusive: ReturnType<typeof civilDateFromPgDate>;
  readonly reason: string;
}

type DbClient = Pick<PrismaService | Prisma.TransactionClient, '$queryRaw'>;

/** Readers may allocate concurrently; block changes wait for in-flight allocations. */
export async function lockOperationalBlocks(tx: Prisma.TransactionClient, write = false): Promise<void> {
  if (write) await tx.$executeRaw`SELECT pg_advisory_xact_lock(194731, 1)`;
  else await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(194731, 1)`;
}

/** Bloqueios de loja inteira ativos que tocam a janela [from, to). */
export async function loadActiveStoreWideBlocks(
  client: DbClient,
  from: { year: number; month: number; day: number },
  to: { year: number; month: number; day: number },
): Promise<StoreWideBlockRange[]> {
  const rows = await client.$queryRaw<{ lo: Date; hi: Date; reason: string }[]>`
    SELECT start_date AS "lo", end_date AS "hi", reason
    FROM operational_blocks
    WHERE scope = 'STORE_WIDE'
      AND removed_at IS NULL
      AND active
      AND daterange(start_date, end_date, '[]') && daterange(${civilDateToISO(from)}::date, ${civilDateToISO(to)}::date, '[)')
  `;
  return rows.map((r) => ({ blockedFrom: civilDateFromPgDate(r.lo), blockedUntilExclusive: addDays(civilDateFromPgDate(r.hi), 1), reason: r.reason }));
}

/** Bloqueios de peça específica ativos, no mesmo formato de "ocupação"
 *  já usado por AvailabilityService/HoldsService — pra poder ser somado
 *  direto à lista de ranges ocupados, sem checagem separada. */
export async function loadActiveUnitBlocks(
  client: DbClient,
  unitIds: readonly string[],
): Promise<{ unitId: string; range: BlockedRange; reason: string }[]> {
  if (unitIds.length === 0) return [];
  const rows = await client.$queryRaw<{ rentalUnitId: string; lo: Date; hi: Date; reason: string }[]>`
    SELECT rental_unit_id AS "rentalUnitId", start_date AS "lo", end_date AS "hi", reason
    FROM operational_blocks
    WHERE scope = 'UNIT'
      AND removed_at IS NULL
      AND active
      AND rental_unit_id = ANY(${unitIds}::uuid[])
  `;
  return rows.map((r) => ({
    unitId: r.rentalUnitId,
    range: { blockedFrom: civilDateFromPgDate(r.lo), blockedUntilExclusive: addDays(civilDateFromPgDate(r.hi), 1) },
    reason: r.reason,
  }));
}

export function isRangeBlockedStoreWide(range: BlockedRange, blocks: readonly StoreWideBlockRange[]): string | null {
  const hit = blocks.find((b) => blockedRangesOverlap(range, { blockedFrom: b.blockedFrom, blockedUntilExclusive: b.blockedUntilExclusive }));
  return hit ? hit.reason : null;
}
