import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { addDays, civilDateFromPgDate, civilDateToISO, type CivilDate } from '../rental-rules/civil-date';
import { itemPickupDate, itemReturnDate, occupiedBounds, occupiesWindow } from '../reservation-schedule/occupancy-sql';
import { loadActiveStoreWideBlocks, loadActiveUnitBlocks } from '../admin/operational-blocks';
import { kindForReservationStatus, type Occupation } from './unavailable-reason';

type DbClient = Pick<PrismaService | Prisma.TransactionClient, '$queryRaw'>;

/**
 * Tudo o que ocupa as unidades na janela [searchFrom, searchTo), já com o
 * motivo: itens de reserva que ocupam (mesma lista e mesmo filtro da EXCLUDE
 * constraint — peça devolvida/em limpeza segura até concluir) e bloqueios
 * operacionais de peça e de loja. Lê só datas e status: nenhum dado da outra
 * cliente sai daqui.
 */
export async function loadOccupations(client: DbClient, unitIds: readonly string[], searchFrom: CivilDate, searchTo: CivilDate): Promise<Occupation[]> {
  if (unitIds.length === 0) return [];
  const from = civilDateToISO(searchFrom);
  const to = civilDateToISO(searchTo);
  // Regra de ocupação e datas por peça vêm de `reservation-schedule/occupancy-sql` (uma só cópia). Item legado:
  // o COALESCE devolve as datas da reserva, exatamente como antes.
  const bounds = occupiedBounds(from, to, 'ri');
  const rows = await client.$queryRaw<{ rentalUnitId: string; status: string; lo: Date; hi: Date; pickup: Date | null; return: Date | null }[]>`
    SELECT
      ri.rental_unit_id AS "rentalUnitId",
      ri.status::text AS "status",
      ${bounds.lo} AS "lo",
      ${bounds.hi} AS "hi",
      ${itemPickupDate('ri', 'r')} AS "pickup",
      ${itemReturnDate('ri', 'r')} AS "return"
    FROM reservation_items ri
    JOIN reservations r ON r.id = ri.reservation_id
    WHERE ri.rental_unit_id = ANY(${[...unitIds]}::uuid[])
      AND ${occupiesWindow(from, to, 'ri')}
  `;
  const reservations: Occupation[] = rows.map((row) => {
    const kind = kindForReservationStatus(row.status);
    const rentalPeriod =
      kind !== 'preparation' && row.pickup && row.return
        ? { blockedFrom: civilDateFromPgDate(row.pickup), blockedUntilExclusive: addDays(civilDateFromPgDate(row.return), 1) }
        : undefined;
    return {
      unitId: row.rentalUnitId,
      range: { blockedFrom: civilDateFromPgDate(row.lo), blockedUntilExclusive: civilDateFromPgDate(row.hi) },
      kind,
      ...(rentalPeriod ? { rentalPeriod } : {}),
    };
  });
  const unitBlocks = await loadActiveUnitBlocks(client, unitIds);
  const storeBlocks = await loadActiveStoreWideBlocks(client, searchFrom, searchTo);
  return [
    ...reservations,
    ...unitBlocks.map((b) => ({ unitId: b.unitId, range: b.range, kind: 'operational_block' as const })),
    ...storeBlocks.flatMap((b) => unitIds.map((unitId) => ({ unitId, range: { blockedFrom: b.blockedFrom, blockedUntilExclusive: b.blockedUntilExclusive }, kind: 'operational_block' as const }))),
  ];
}
