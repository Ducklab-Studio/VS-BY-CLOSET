/**
 * Por que a data não pode ser alugada — o texto que o cliente vê. O motivo
 * vem da API do ClosetAdmin (GET /availability: `unavailableReason(s)`), que
 * é a fonte oficial de reservas, HOLDs, limpeza e bloqueios; aqui só se
 * escolhe a frase. Nunca há dado de outra cliente (a API só manda códigos).
 * Arquivo puro (sem imports) para test/unavailable-reason.test.mjs.
 */

export type OccupationReason = 'reserved' | 'held' | 'preparation' | 'operational_block';

export interface DayReasonInfo {
  readonly bookable: boolean;
  readonly reason: string | null;
  readonly unavailableReason?: string | null;
  readonly unavailableReasons?: readonly string[] | null;
}

const PRIORITY: readonly OccupationReason[] = ['reserved', 'held', 'preparation', 'operational_block'];

const MESSAGES: Record<OccupationReason, string> = {
  reserved: 'Esta peça já está alugada para outra reserva nesse período.',
  held: 'Esta peça está temporariamente reservada. Tente outra data.',
  preparation: 'Esta peça está indisponível para esta data devido ao período de preparação/limpeza.',
  operational_block: 'Esta peça está indisponível para esta data devido ao período de preparação/limpeza.',
};

/** Rótulo curto de um motivo secundário (explicação de "também há"). */
const SHORT: Record<OccupationReason, string> = {
  reserved: 'outra reserva nesse período',
  held: 'uma reserva temporária em andamento',
  preparation: 'período de preparação/limpeza',
  operational_block: 'período de preparação/limpeza',
};

/** Regras da loja que não dependem de ocupação (já existiam no motor de regras). */
const PLAN_MESSAGES: Record<string, string> = {
  pickup_is_sunday: 'A loja não abre aos domingos para retirada. Escolha outra data.',
  pickup_before_minimum_advance: 'Esta data está muito próxima: é preciso reservar com mais antecedência.',
  pickup_before_operation_start: 'As reservas online ainda não estão abertas para esta data.',
  max_pieces_exceeded: 'Esta reserva passou do máximo de peças permitido.',
};

export const SHOPIFY_UNAVAILABLE_MESSAGE = 'Esta peça está indisponível na Shopify.';
export const GENERIC_UNAVAILABLE_MESSAGE = 'Indisponível para esta data.';

const isOccupation = (value: unknown): value is OccupationReason => typeof value === 'string' && (PRIORITY as readonly string[]).includes(value);

/** Motivos conhecidos, sem repetição, do mais prioritário ao menos. */
export function rankedReasons(day: DayReasonInfo): OccupationReason[] {
  const all = [day.unavailableReason, ...(day.unavailableReasons ?? [])].filter(isOccupation);
  return PRIORITY.filter((reason) => all.includes(reason));
}

/**
 * Mensagem para uma data indisponível: o motivo prioritário e, se houver mais
 * de um, uma explicação curta. `null` se a data está disponível.
 */
export function unavailableExplanation(day: DayReasonInfo | undefined): { message: string; extra: string | null } | null {
  if (!day || day.bookable) return null;
  const reasons = rankedReasons(day);
  if (reasons.length > 0) {
    const others = [...new Set(reasons.slice(1).map((reason) => SHORT[reason]).filter((text) => text !== SHORT[reasons[0]]))];
    return { message: MESSAGES[reasons[0]], extra: others.length > 0 ? `Também há ${others.join(' e ')}.` : null };
  }
  if (day.reason && PLAN_MESSAGES[day.reason]) return { message: PLAN_MESSAGES[day.reason], extra: null };
  return { message: GENERIC_UNAVAILABLE_MESSAGE, extra: null };
}

/** Mensagem curta de um motivo vindo do HOLD/checkout (`reason` do 409). */
export function reasonMessage(reason: unknown): string {
  return isOccupation(reason) ? MESSAGES[reason] : GENERIC_UNAVAILABLE_MESSAGE;
}
