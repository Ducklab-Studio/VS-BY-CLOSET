import { type CivilDate, civilDateFromPgDate, diffDays } from '../rental-rules/civil-date';

/**
 * Leitura CENTRALIZADA das datas de uma peça (Fase 3). Cada item de reserva pode ter o próprio cronograma
 * (`reservation_items.pickup_date` / `return_date`, migration A1); o item LEGADO não tem (colunas nulas) e usa as
 * datas da reserva. Todo leitor deve passar por aqui em vez de ler `reservation.pickupDate/returnDate` direto, para
 * que, no dia em que existirem peças com datas diferentes na mesma reserva, nenhum leitor use a data errada.
 *
 * Nada aqui decide regra de aluguel nem ativa o recurso: para toda reserva existente o resultado é IDÊNTICO ao que
 * os leitores calculavam antes (fallback para a reserva).
 */

/** Datas como vêm do banco (`date` → `Date` em UTC à meia-noite). */
export interface PgDateSource {
  readonly pickupDate?: Date | null;
  readonly returnDate?: Date | null;
}

export interface ItemDates {
  readonly pickupDate: CivilDate | null;
  /** Devolução EFETIVA (a data em que a peça deve voltar). */
  readonly returnDate: CivilDate | null;
  /** De onde vieram: cronograma próprio do item ou fallback para a reserva (item legado). */
  readonly origin: 'item' | 'reservation';
}

const civil = (value: Date | null | undefined): CivilDate | null => (value ? civilDateFromPgDate(value) : null);

/**
 * O item tem cronograma próprio SOMENTE se tiver retirada E devolução. O banco garante "tudo ou nada" (CHECK
 * `ri_schedule_all_or_none`); um item "pela metade" não existe, e se existisse cairia no fallback seguro (reserva).
 */
export function hasOwnSchedule(item: PgDateSource | null | undefined): boolean {
  return Boolean(item?.pickupDate && item?.returnDate);
}

export function readItemDates(item: PgDateSource | null | undefined, reservation: PgDateSource): ItemDates {
  if (hasOwnSchedule(item)) {
    return { pickupDate: civil(item?.pickupDate), returnDate: civil(item?.returnDate), origin: 'item' };
  }
  return { pickupDate: civil(reservation.pickupDate), returnDate: civil(reservation.returnDate), origin: 'reservation' };
}

/** Devolução prevista desta peça (item ou, no legado, reserva). `null` se a reserva não tem devolução. */
export function expectedReturnDate(item: PgDateSource | null | undefined, reservation: PgDateSource): CivilDate | null {
  return readItemDates(item, reservation).returnDate;
}

/** Mesma data de `expectedReturnDate`, no formato do banco (`Date` UTC à meia-noite), para gravar em colunas `date`. */
export function effectiveReturnPgDate(item: PgDateSource | null | undefined, reservation: PgDateSource): Date | null {
  return (hasOwnSchedule(item) ? item?.returnDate : reservation.returnDate) ?? null;
}

/** Dias de atraso: 0 se não há data prevista ou ainda não venceu; nunca negativo. Mesma conta de antes: hoje − prevista. */
export function daysLate(expected: CivilDate | null, today: CivilDate): number {
  return expected ? Math.max(0, diffDays(today, expected)) : 0;
}
