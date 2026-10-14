/**
 * Alerta de peça retida (manutenção/avaria) com reserva futura dependendo dela — regras puras,
 * sem rede e sem React. É informação para a equipe agir: nada aqui cancela reserva, libera
 * peça ou mexe em pagamento. Resposta malformada NUNCA vira "sem alertas": `parseHeldAlerts`
 * devolve `null` e a tela avisa que não conseguiu verificar.
 */

export type HeldCondition = 'needs_maintenance' | 'damaged';

export interface HeldAlert {
  readonly reservationItemId: string;
  readonly heldReservationId: string;
  readonly code: string;
  readonly name: string;
  readonly condition: HeldCondition;
  readonly heldSince: string;
  readonly nextReservation: {
    readonly id: string;
    readonly status: string;
    readonly pickupDate: string;
    readonly returnDate: string | null;
    readonly customerName: string | null;
    readonly daysUntilPickup: number;
  };
  readonly affectedCount: number;
}

export type Urgency = 'urgent' | 'soon' | 'later';

/** Retirada em até 7 dias é urgente; até 21, atenção; depois, acompanhar. */
export function urgencyOf(daysUntilPickup: number): Urgency {
  if (daysUntilPickup <= 7) return 'urgent';
  if (daysUntilPickup <= 21) return 'soon';
  return 'later';
}

export function pickupLabel(daysUntilPickup: number): string {
  if (daysUntilPickup <= 0) return 'hoje';
  if (daysUntilPickup === 1) return 'amanhã';
  return `em ${daysUntilPickup} dias`;
}

export function holdConditionLabel(condition: HeldCondition): string {
  return condition === 'damaged' ? 'Danificada' : 'Em manutenção';
}

export function headline(count: number): string {
  return count === 1 ? '1 peça retida tem reserva futura' : `${count} peças retidas têm reservas futuras`;
}

/** Sem nome (reserva online ainda sem contato), identifica pelo código curto que a tela já usa. */
export function reservationLabel(reservation: { id: string; customerName: string | null }): string {
  return reservation.customerName?.trim() || `Reserva ${reservation.id.slice(0, 8)}`;
}

export function otherReservationsLabel(affectedCount: number): string | null {
  const others = affectedCount - 1;
  if (others <= 0) return null;
  return others === 1 ? '+ 1 outra reserva também depende desta peça' : `+ ${others} outras reservas também dependem desta peça`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isIsoDay = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** `null` = formato inesperado (não confundir com "nenhum alerta", que é uma lista vazia). */
export function parseHeldAlerts(json: unknown): HeldAlert[] | null {
  if (!isObject(json) || !Array.isArray(json.alerts)) return null;
  const out: HeldAlert[] = [];
  for (const raw of json.alerts) {
    if (!isObject(raw) || !isObject(raw.nextReservation)) return null;
    const n = raw.nextReservation;
    if (
      typeof raw.reservationItemId !== 'string' || typeof raw.heldReservationId !== 'string' || typeof raw.code !== 'string' ||
      (raw.condition !== 'damaged' && raw.condition !== 'needs_maintenance') || typeof raw.heldSince !== 'string' ||
      typeof n.id !== 'string' || typeof n.status !== 'string' || !isIsoDay(n.pickupDate) || typeof n.daysUntilPickup !== 'number'
    ) return null;
    out.push({
      reservationItemId: raw.reservationItemId,
      heldReservationId: raw.heldReservationId,
      code: raw.code,
      name: typeof raw.name === 'string' ? raw.name : raw.code,
      condition: raw.condition,
      heldSince: raw.heldSince,
      nextReservation: {
        id: n.id,
        status: n.status,
        pickupDate: n.pickupDate,
        returnDate: isIsoDay(n.returnDate) ? n.returnDate : null,
        customerName: typeof n.customerName === 'string' ? n.customerName : null,
        daysUntilPickup: n.daysUntilPickup,
      },
      affectedCount: typeof raw.affectedCount === 'number' && raw.affectedCount >= 1 ? raw.affectedCount : 1,
    });
  }
  return out;
}
