import type { BlockedRange } from '../rental-rules/rental-engine';
import { blockedRangesOverlap } from '../rental-rules/rental-engine';

/**
 * Por que uma peça não pode ser alugada numa data — o motivo REAL, vindo das
 * ocupações do ClosetAdmin (reservas, HOLDs, limpeza e bloqueios). Só códigos:
 * nunca nome, telefone, e-mail, código ou id da reserva de outra cliente.
 *
 * Ordem de prioridade (quando há mais de um motivo, o primeiro é o exibido):
 *  1. `reserved`          — outra reserva confirmada/em andamento ocupa o período;
 *  2. `held`              — HOLD ou pagamento pendente segurando a peça (pode liberar);
 *  3. `preparation`       — período de preparação/limpeza (peça devolvida/higienizando,
 *                            ou só a folga antes/depois de outra reserva encosta na data);
 *  4. `operational_block` — bloqueio operacional da peça ou da loja.
 */
export type OccupationKind = 'reserved' | 'held' | 'preparation' | 'operational_block';

export const OCCUPATION_PRIORITY: readonly OccupationKind[] = ['reserved', 'held', 'preparation', 'operational_block'];

/** Uma ocupação de unidade, já classificada. `rentalPeriod` = retirada→devolução da
 *  OUTRA reserva (sem as folgas); ausente em limpeza e bloqueios. */
export interface Occupation {
  readonly unitId: string;
  readonly range: BlockedRange;
  readonly kind: OccupationKind;
  readonly rentalPeriod?: BlockedRange;
}

/** Classifica a ocupação de um item de reserva pelo status (já espelhado no item). */
export function kindForReservationStatus(status: string): OccupationKind {
  if (status === 'returned' || status === 'cleaning') return 'preparation';
  if (status === 'hold' || status === 'pending_payment') return 'held';
  return 'reserved';
}

/**
 * Motivo de UMA ocupação para o período pedido: se o período pedido só encosta
 * nas folgas (preparação/limpeza) da outra reserva — não no aluguel dela —, o
 * motivo é preparação/limpeza.
 */
export function kindFor(occupation: Occupation, requested: BlockedRange): OccupationKind {
  if (occupation.kind !== 'reserved' && occupation.kind !== 'held') return occupation.kind;
  if (occupation.rentalPeriod && !blockedRangesOverlap(occupation.rentalPeriod, requested)) return 'preparation';
  return occupation.kind;
}

/** Motivos distintos, do mais prioritário ao menos. */
export function rankReasons(kinds: Iterable<OccupationKind>): OccupationKind[] {
  const set = new Set(kinds);
  return OCCUPATION_PRIORITY.filter((kind) => set.has(kind));
}

/** Motivos que impedem as `units` no período pedido (só as ocupações que se sobrepõem). */
export function reasonsFor(units: readonly { id: string }[], occupied: readonly Occupation[], requested: BlockedRange): OccupationKind[] {
  const ids = new Set(units.map((u) => u.id));
  return rankReasons(occupied.filter((o) => ids.has(o.unitId) && blockedRangesOverlap(o.range, requested)).map((o) => kindFor(o, requested)));
}

/** Mensagem em português para a resposta do HOLD (a vitrine mostra a mesma ideia). */
export function reasonMessage(kind: OccupationKind | undefined): string {
  if (kind === 'reserved') return 'Esta peça já está alugada para outra reserva nesse período.';
  if (kind === 'held') return 'Esta peça está temporariamente reservada. Tente outra data.';
  if (kind === 'preparation' || kind === 'operational_block') return 'Esta peça está indisponível para esta data devido ao período de preparação/limpeza.';
  return 'Não há disponibilidade para o período solicitado.';
}
