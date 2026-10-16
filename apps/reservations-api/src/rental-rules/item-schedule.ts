/**
 * Cronograma PURO de UMA peça (Fase 3): retirada própria + duração própria → devolução, janela bloqueada e
 * antecedência mínima em HORAS. Sem banco, sem HTTP, sem relógio (o "agora" é sempre um argumento).
 *
 * NÃO está ligado a disponibilidade, HOLD nem checkout; `rental-engine.ts` (regras em uso) não foi tocado.
 *
 * O que é regra informada:
 *  - cada peça tem retirada e duração independentes;
 *  - devolução = retirada + dias (a mesma convenção do motor atual: "retirada + duração, direto");
 *  - antecedência mínima medida em horas (48 h) contra o INSTANTE da retirada, no fuso da operação;
 *  - domingo permitido "durante o período de funcionamento": o calendário de funcionamento é INJETADO (`isOpenOn`).
 *
 * O que NÃO é assumido aqui (todos parâmetros explícitos, sem valor padrão):
 *  - dias de preparação e de limpeza que bloqueiam a peça (higienização noturna pode significar 0 dia de limpeza);
 *  - horário de retirada (vem da operação) e o calendário de funcionamento;
 *  - o que fazer quando a devolução cai num dia fechado: aqui é uma violação (`return_closed`), a regra de
 *    deslocamento é decisão comercial.
 */

import { type CivilDate, addDays, isBefore } from './civil-date';
import { MAX_SANE_RENTAL_DAYS, isValidCivilDate, parseStrictCivilDateISO } from './engine-guards';
import type { BlockedRange } from './rental-engine';

export interface ScheduleRules {
  /** Dias bloqueados ANTES da retirada (preparação/separação antecipada). */
  readonly prepDays: number;
  /** Dias bloqueados DEPOIS da devolução. 0 = a peça volta à prateleira já no dia seguinte (limpeza noturna). */
  readonly cleaningDays: number;
  /** Antecedência mínima em horas entre "agora" e o instante da retirada. */
  readonly minAdvanceHours: number;
  /** Fuso IANA da operação (ex.: "America/Santiago"). */
  readonly timezone: string;
  /** Calendário de funcionamento: a loja abre nesta data civil? */
  readonly isOpenOn: (date: CivilDate) => boolean;
  /** Duração máxima por peça. Sem valor padrão: ausente = sem teto neste motor. */
  readonly maxDays?: number;
  /** Primeira data de retirada aceita (início da operação). Ausente = sem restrição. */
  readonly operationStartDate?: CivilDate | null;
}

export interface ItemScheduleRequest {
  readonly pickupDate: CivilDate;
  readonly days: number;
  /** Horário de retirada informado pela operação, na hora local do fuso (0–23 / 0–59). */
  readonly pickupTime: { readonly hour: number; readonly minute: number };
}

export type ScheduleViolation =
  | 'invalid_rules'
  | 'invalid_days'
  | 'days_above_max'
  | 'invalid_pickup_time'
  | 'invalid_pickup_date'
  | 'invalid_computed_date'
  | 'pickup_before_operation_start'
  | 'pickup_closed'
  | 'return_closed'
  | 'pickup_before_minimum_advance';

export interface ItemSchedule {
  readonly pickupDate: CivilDate;
  readonly returnDate: CivilDate;
  readonly days: number;
  /** Instante exato da retirada. */
  readonly pickupAt: Date;
  /** [retirada − prep, devolução + limpeza + 1) — meio-aberto, igual ao `daterange` do Postgres e ao motor atual. */
  readonly blockedRange: BlockedRange;
}

export type ItemScheduleResult =
  | { readonly ok: true; readonly schedule: ItemSchedule }
  | { readonly ok: false; readonly violations: readonly ScheduleViolation[] };

const MS_PER_HOUR = 3_600_000;

/** Deslocamento do fuso em um instante (hora local − UTC), em ms. Negativo a oeste de Greenwich (Santiago ≈ −3 h/−4 h). Usa só `Intl`. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
  const whole = Math.floor(utcMs / 1000) * 1000;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(whole));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const localAsUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return localAsUtc - whole;
}

const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Data civil + hora local num fuso → instante, com a virada de horário de verão tratada de forma explícita:
 *  - hora REPETIDA (relógio volta): vale a PRIMEIRA ocorrência (o instante mais cedo — o lado conservador para a
 *    antecedência mínima);
 *  - hora INEXISTENTE (relógio salta): vale o mesmo "relógio de parede" deslocado para frente pela duração do salto
 *    (ex.: 00:30 inexistente → 01:30 local, que existe).
 * Lança `RangeError` se a data/hora for inválida; `planItemSchedule` valida antes e nunca chega aqui com entrada ruim.
 */
export function zonedTimeToInstant(date: CivilDate, hour: number, minute: number, timeZone: string): Date {
  if (!isValidCivilDate(date) || !Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    throw new RangeError('Data ou hora local inválida.');
  }
  const guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  // Deslocamentos vigentes um dia antes e um dia depois: uma transição de horário de verão cabe entre os dois.
  const before = zoneOffsetMs(guess - MS_PER_DAY, timeZone);
  const after = zoneOffsetMs(guess + MS_PER_DAY, timeZone);
  const candidates = [...new Set([before, after])]
    .map((offset) => ({ offset, instant: guess - offset }))
    .filter(({ offset, instant }) => zoneOffsetMs(instant, timeZone) === offset)
    .map(({ instant }) => instant);
  if (candidates.length > 0) return new Date(Math.min(...candidates));
  // Nenhum candidato é consistente: a hora local não existe (salto). Usa o deslocamento anterior ao salto.
  return new Date(guess - before);
}

/** Mesma fórmula do motor atual: [retirada − prep, devolução + limpeza + 1). */
export function blockedRangeFor(pickupDate: CivilDate, returnDate: CivilDate, rules: Pick<ScheduleRules, 'prepDays' | 'cleaningDays'>): BlockedRange {
  return { blockedFrom: addDays(pickupDate, -rules.prepDays), blockedUntilExclusive: addDays(returnDate, rules.cleaningDays + 1) };
}

/** `now` + antecedência mínima ainda não alcança o instante da retirada? */
export function meetsMinimumAdvance(pickupAt: Date, now: Date, minAdvanceHours: number): boolean {
  return pickupAt.getTime() - now.getTime() >= minAdvanceHours * MS_PER_HOUR;
}

function validRules(rules: ScheduleRules): boolean {
  if (!rules || typeof rules.isOpenOn !== 'function') return false;
  for (const value of [rules.prepDays, rules.cleaningDays]) if (!Number.isInteger(value) || value < 0 || value > 365) return false;
  if (!Number.isFinite(rules.minAdvanceHours) || rules.minAdvanceHours < 0) return false;
  if (rules.maxDays !== undefined && (!Number.isInteger(rules.maxDays) || rules.maxDays < 1)) return false;
  if (rules.operationStartDate !== undefined && rules.operationStartDate !== null && !isValidCivilDate(rules.operationStartDate)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: rules.timezone });
  } catch {
    return false;
  }
  return true;
}

/**
 * Valida tudo ANTES de calcular (fail closed): havendo qualquer violação devolve `{ ok: false, violations }` e nenhum
 * cronograma. `now` é argumento — o motor nunca lê o relógio.
 */
export function planItemSchedule(request: ItemScheduleRequest, rules: ScheduleRules, now: Date): ItemScheduleResult {
  if (!validRules(rules)) return { ok: false, violations: ['invalid_rules'] };

  const violations: ScheduleViolation[] = [];
  const hour = request?.pickupTime?.hour;
  const minute = request?.pickupTime?.minute;
  const validTime = Number.isInteger(hour) && hour >= 0 && hour <= 23 && Number.isInteger(minute) && minute >= 0 && minute <= 59;
  if (!validTime) violations.push('invalid_pickup_time');
  if (!isValidCivilDate(request?.pickupDate)) violations.push('invalid_pickup_date');
  if (!Number.isInteger(request?.days) || request.days < 1) violations.push('invalid_days');
  else if (request.days > MAX_SANE_RENTAL_DAYS || (rules.maxDays !== undefined && request.days > rules.maxDays)) violations.push('days_above_max');
  if (violations.length > 0) return { ok: false, violations };

  const returnDate = addDays(request.pickupDate, request.days);
  const blockedRange = blockedRangeFor(request.pickupDate, returnDate, rules);
  // Defesa em profundidade: toda data calculada precisa existir no calendário antes de qualquer outra regra.
  if (![returnDate, blockedRange.blockedFrom, blockedRange.blockedUntilExclusive].every(isValidCivilDate)) {
    return { ok: false, violations: ['invalid_computed_date'] };
  }
  if (rules.operationStartDate && isBefore(request.pickupDate, rules.operationStartDate)) violations.push('pickup_before_operation_start');
  if (!rules.isOpenOn(request.pickupDate)) violations.push('pickup_closed');
  if (!rules.isOpenOn(returnDate)) violations.push('return_closed');

  const pickupAt = zonedTimeToInstant(request.pickupDate, hour, minute, rules.timezone);
  if (!(now instanceof Date) || !meetsMinimumAdvance(pickupAt, now, rules.minAdvanceHours)) violations.push('pickup_before_minimum_advance');

  if (violations.length > 0) return { ok: false, violations };
  return {
    ok: true,
    schedule: { pickupDate: request.pickupDate, returnDate, days: request.days, pickupAt, blockedRange },
  };
}

/**
 * Conveniência para quem recebe ISO (YYYY-MM-DD) do cliente. Parser ESTRITO: formato errado ou data inexistente
 * ("2026-02-31") vira a violação `invalid_pickup_date` — não lança e não normaliza para outra data.
 */
export function planItemScheduleFromISO(pickupISO: string, days: number, pickupTime: ItemScheduleRequest['pickupTime'], rules: ScheduleRules, now: Date): ItemScheduleResult {
  const pickupDate = parseStrictCivilDateISO(pickupISO);
  if (!pickupDate) return { ok: false, violations: ['invalid_pickup_date'] };
  return planItemSchedule({ pickupDate, days, pickupTime }, rules, now);
}
