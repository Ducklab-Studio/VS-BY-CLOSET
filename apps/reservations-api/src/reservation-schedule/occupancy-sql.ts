import { Prisma } from '@prisma/client';
import { OCCUPYING_RESERVATION_STATUSES } from '../reservation-status';

/**
 * Fragmentos SQL COMPARTILHADOS de ocupação de peças (Fase 3 — leitura por peça).
 *
 * Antes, a regra "peça devolvida ou em higienização continua ocupando a unidade até concluir, mesmo depois da janela
 * planejada" estava copiada à mão em várias consultas (HOLD, reserva manual, disponibilidade, calendário, painel de
 * peças, alerta de peça retida). Aqui ela vive em UM lugar. O texto SQL gerado é equivalente, caractere a caractere em
 * semântica, ao que existia — a equivalência é provada por teste contra o SQL antigo (occupancy.equivalence).
 *
 * A EXCLUDE `reservation_items_no_overlap_per_unit` NÃO muda: ela só enxerga `blocked_range` e o status. A parte "até
 * concluir" continua sendo regra de aplicação (e agora de um único arquivo).
 */

/** Itens nestes status continuam segurando a unidade até a higienização ser CONCLUÍDA (status `completed`). */
export const HELD_UNTIL_COMPLETED_STATUSES = ['returned', 'cleaning'] as const;

/** Alias da tabela `reservation_items` na consulta (`''` = sem alias). Lista fechada: nada vem de entrada externa. */
export type ItemAlias = '' | 'ri';
/** Alias da tabela `reservations` na consulta. */
export type ReservationAlias = 'r' | 'rs';

const ITEM_ALIASES: readonly string[] = ['', 'ri'];
const RESERVATION_ALIASES: readonly string[] = ['r', 'rs'];

const STATUS_NAME = /^[a-z_]+$/;
for (const status of [...HELD_UNTIL_COMPLETED_STATUSES, ...OCCUPYING_RESERVATION_STATUSES]) {
  if (!STATUS_NAME.test(status)) throw new Error(`status inválido para SQL: ${status}`);
}
const HELD_LITERAL = Prisma.raw(HELD_UNTIL_COMPLETED_STATUSES.map((status) => `'${status}'`).join(', '));

function itemColumn(alias: ItemAlias, column: string): Prisma.Sql {
  if (!ITEM_ALIASES.includes(alias)) throw new Error(`alias de reservation_items inválido: ${alias}`);
  return Prisma.raw(alias ? `${alias}.${column}` : column);
}
function reservationColumn(alias: ReservationAlias, column: string): Prisma.Sql {
  if (!RESERVATION_ALIASES.includes(alias)) throw new Error(`alias de reservations inválido: ${alias}`);
  return Prisma.raw(`${alias}.${column}`);
}

/** `status IN ('returned', 'cleaning')` — a peça já foi recebida e ainda não foi liberada. */
export function heldUntilCompleted(alias: ItemAlias = ''): Prisma.Sql {
  return Prisma.sql`${itemColumn(alias, 'status')} IN (${HELD_LITERAL})`;
}

/** `status = ANY(<ocupantes>)` — a mesma lista do WHERE da EXCLUDE (`reservation-status.ts`). */
export function occupyingStatus(alias: ItemAlias = ''): Prisma.Sql {
  return Prisma.sql`${itemColumn(alias, 'status')} = ANY(${[...OCCUPYING_RESERVATION_STATUSES]}::"reservation_status"[])`;
}

/**
 * O item ocupa a unidade em alguma parte de [from, to)? É a regra completa de ocupação:
 *  - status que ocupa (`occupyingStatus`) E
 *  - a janela gravada do item cruza [from, to), OU o item está recebido/em higienização e a janela dele COMEÇOU até
 *    `to` (a peça segue ocupada mesmo que a janela planejada tenha terminado antes de `from`).
 * `from`/`to` são datas ISO (YYYY-MM-DD), passadas como parâmetros.
 */
export function occupiesWindow(from: string, to: string, alias: ItemAlias = ''): Prisma.Sql {
  const range = itemColumn(alias, 'blocked_range');
  return Prisma.sql`${occupyingStatus(alias)}
    AND (
      ${range} && daterange(${from}::date, ${to}::date, '[)')
      OR (${heldUntilCompleted(alias)} AND lower(${range}) <= ${to}::date)
    )`;
}

/**
 * Início e fim EXIBIDOS da ocupação no intervalo pedido: itens recebidos/em higienização ocupam TODO o intervalo
 * [from, to); os demais, a janela gravada (`lower`/`upper` de `blocked_range`).
 */
export function occupiedBounds(from: string, to: string, alias: ItemAlias = ''): { lo: Prisma.Sql; hi: Prisma.Sql } {
  const range = itemColumn(alias, 'blocked_range');
  return {
    lo: Prisma.sql`CASE WHEN ${heldUntilCompleted(alias)} THEN ${from}::date ELSE lower(${range}) END`,
    hi: Prisma.sql`CASE WHEN ${heldUntilCompleted(alias)} THEN ${to}::date ELSE upper(${range}) END`,
  };
}

/**
 * Retirada e devolução EFETIVA desta peça: as do próprio item (cronograma por peça) ou, no item legado, as da reserva.
 * Fallback por COALESCE: item legado (colunas nulas) lê exatamente o que sempre leu.
 */
export function itemPickupDate(item: ItemAlias = 'ri', reservation: ReservationAlias = 'r'): Prisma.Sql {
  return Prisma.sql`COALESCE(${itemColumn(item, 'pickup_date')}, ${reservationColumn(reservation, 'pickup_date')})`;
}
export function itemReturnDate(item: ItemAlias = 'ri', reservation: ReservationAlias = 'r'): Prisma.Sql {
  return Prisma.sql`COALESCE(${itemColumn(item, 'return_date')}, ${reservationColumn(reservation, 'return_date')})`;
}
