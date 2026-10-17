/**
 * Motor PURO de diárias e preço da locação por peça (Fase 3). Sem banco, sem HTTP, sem Shopify, sem relógio.
 *
 * NÃO está ligado a checkout, HOLD, disponibilidade nem webhooks: é um módulo isolado, testado, pronto para ser
 * integrado depois que as decisões comerciais pendentes forem confirmadas. Nada aqui altera as regras que os
 * clientes usam hoje (`rental-engine.ts`).
 *
 * Regras informadas e implementadas (as DEMAIS são parâmetros explícitos, nunca valores embutidos):
 *  - cada peça tem a SUA duração, independente das outras da mesma reserva;
 *  - a primeira diária custa o valor-base INTEGRAL da peça;
 *  - cada diária adicional custa `extraDayBasisPoints` do valor-base (5000 = 50%), SEM juros compostos: o preço do dia
 *    adicional é sempre calculado sobre o valor-base, nunca sobre o total acumulado;
 *  - a taxa de reserva é UMA por pedido (não por peça) — o VALOR vem da configuração (R$ 49,99 ainda não confirmado);
 *  - tudo em centavos inteiros: nenhuma conta passa por ponto flutuante.
 *
 * Pendente de decisão comercial (por isso é parâmetro e não constante): arredondamento quando 50% do valor-base não
 * fecha em centavos (valor-base com centavos ímpares), duração máxima por peça e a própria taxa de reserva.
 */

import { MAX_SANE_RENTAL_DAYS } from './engine-guards';

/** Como fechar o centavo quando `base × percentual` não é inteiro. `half_up`: 0,5 sobe. */
export type ExtraDayRounding = 'half_up' | 'down' | 'up';

export interface RentalPricingConfig {
  /** Percentual do valor-base por diária adicional, em pontos-base (5000 = 50%). Inteiro de 0 a 100000. */
  readonly extraDayBasisPoints: number;
  /** Só importa quando `base × percentual` deixa fração de centavo. Decisão comercial pendente: o chamador escolhe. */
  readonly extraDayRounding: ExtraDayRounding;
  /** Taxa de reserva ÚNICA por pedido, em centavos (0 = sem taxa). O valor definitivo ainda não foi confirmado. */
  readonly reservationFeeCents: number;
  /** Duração máxima por peça (dias). Sem valor padrão: ausente = sem teto neste motor (o teto real é regra de negócio). */
  readonly maxDaysPerItem?: number;
  /** Máximo de peças por pedido. Ausente = sem teto neste motor. */
  readonly maxItems?: number;
}

export interface PricedItemInput {
  /** Identificador estável da peça na reserva (qualquer string única dentro do pedido). */
  readonly id: string;
  /** Valor-base da peça em centavos = preço da primeira diária. */
  readonly baseCents: number;
  /** Quantidade de diárias desta peça (inteiro ≥ 1). */
  readonly days: number;
}

export type PricingViolationCode =
  | 'invalid_config'
  | 'no_items'
  | 'too_many_items'
  | 'duplicate_item_id'
  /** Item ausente/não-objeto, ou `id` que não é uma string não vazia. */
  | 'invalid_item'
  | 'invalid_price'
  | 'invalid_days'
  | 'days_above_max'
  /** Tetos do banco (CHECKs da migration A1): o valor é um inteiro válido, mas o PostgreSQL não o comporta. */
  | 'price_above_ceiling'
  | 'extra_day_above_ceiling'
  | 'line_total_above_ceiling'
  | 'reservation_fee_above_ceiling'
  | 'order_total_above_ceiling';

export interface PricingViolation {
  readonly code: PricingViolationCode;
  /** Peça envolvida, quando a violação é de uma peça específica. */
  readonly itemId?: string;
}

export interface PricedItem {
  readonly id: string;
  readonly days: number;
  readonly baseCents: number;
  /** Primeira diária (= valor-base integral). */
  readonly firstDayCents: number;
  /** Quantas diárias são adicionais (days − 1). */
  readonly extraDays: number;
  /** Preço de CADA diária adicional (constante, calculado só sobre o valor-base). */
  readonly extraDayCents: number;
  /** extraDays × extraDayCents. */
  readonly extrasCents: number;
  /** firstDayCents + extrasCents. */
  readonly totalCents: number;
}

export interface ReservationPricing {
  readonly items: readonly PricedItem[];
  /** Soma das peças, sem a taxa de reserva. */
  readonly subtotalCents: number;
  /** Taxa de reserva única por pedido (0 se a configuração não tem taxa). */
  readonly reservationFeeCents: number;
  readonly totalCents: number;
}

export type ReservationPricingResult =
  | { readonly ok: true; readonly pricing: ReservationPricing }
  | { readonly ok: false; readonly violations: readonly PricingViolation[] };

/**
 * Tetos monetários (centavos) IDÊNTICOS aos CHECKs da migration A1 (`ri_pricing_ceilings`, `r_pricing_amounts`). São
 * limites TÉCNICOS (as colunas são int4), não regra comercial: o motor nunca devolve um valor que o banco recusaria.
 * Se um CHECK mudar, mude aqui junto — o teste de integração compara as duas pontas contra o Postgres.
 */
export const DB_MAX_UNIT_BASE_CENTS = 100_000_000; // reservation_items.unit_base_cents (R$ 1 milhão)
export const DB_MAX_EXTRA_DAY_CENTS = 100_000_000; // reservation_items.extra_day_cents
export const DB_MAX_LINE_TOTAL_CENTS = 1_000_000_000; // reservation_items.line_total_cents (R$ 10 milhões)
export const DB_MAX_RESERVATION_FEE_CENTS = 100_000_000; // reservations.reservation_fee_cents
export const DB_MAX_EXPECTED_TOTAL_CENTS = 2_000_000_000; // reservations.expected_total_cents (< 2^31 − 1)

/** Teto do valor-base de uma peça (= `DB_MAX_UNIT_BASE_CENTS`); mantido com este nome por compatibilidade. */
export const MAX_PRICE_CENTS = DB_MAX_UNIT_BASE_CENTS;
export const MAX_BASIS_POINTS = 100_000;
export const BASIS_POINTS_PER_UNIT = 10_000;

/** Inteiro seguro e não negativo (ainda SEM olhar teto): a diferença entre "inválido" e "válido, mas acima do teto do banco". */
const isNonNegativeSafeInt = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isCents = (value: unknown): value is number => isNonNegativeSafeInt(value) && value <= DB_MAX_UNIT_BASE_CENTS;

/** Divisão inteira com o arredondamento pedido. Só para numeradores e denominadores positivos e seguros. */
function divideRounded(numerator: number, denominator: number, mode: ExtraDayRounding): number {
  const quotient = Math.floor(numerator / denominator);
  const remainder = numerator - quotient * denominator;
  if (remainder === 0) return quotient;
  if (mode === 'down') return quotient;
  if (mode === 'up') return quotient + 1;
  return remainder * 2 >= denominator ? quotient + 1 : quotient;
}

export function validatePricingConfig(config: RentalPricingConfig): boolean {
  if (!config || typeof config !== 'object') return false;
  if (!Number.isInteger(config.extraDayBasisPoints) || config.extraDayBasisPoints < 0 || config.extraDayBasisPoints > MAX_BASIS_POINTS) return false;
  if (!['half_up', 'down', 'up'].includes(config.extraDayRounding)) return false;
  if (!isNonNegativeSafeInt(config.reservationFeeCents) || config.reservationFeeCents > DB_MAX_RESERVATION_FEE_CENTS) return false;
  if (config.maxDaysPerItem !== undefined && (!Number.isInteger(config.maxDaysPerItem) || config.maxDaysPerItem < 1)) return false;
  if (config.maxItems !== undefined && (!Number.isInteger(config.maxItems) || config.maxItems < 1)) return false;
  return true;
}

/**
 * Preço de UMA diária adicional: `base × percentual`, sempre sobre o valor-base. É esta função que garante que não há
 * juros compostos: o resultado não depende da quantidade de dias.
 */
export function extraDayPriceCents(baseCents: number, config: Pick<RentalPricingConfig, 'extraDayBasisPoints' | 'extraDayRounding'>): number {
  if (!isCents(baseCents)) throw new RangeError('baseCents inválido.');
  return divideRounded(baseCents * config.extraDayBasisPoints, BASIS_POINTS_PER_UNIT, config.extraDayRounding);
}

/** Preço de uma peça por `days` diárias (sem taxa de reserva). Lança `RangeError` para entrada inválida. */
export function priceItem(input: PricedItemInput, config: Pick<RentalPricingConfig, 'extraDayBasisPoints' | 'extraDayRounding'>): PricedItem {
  if (!isCents(input.baseCents)) throw new RangeError('baseCents inválido.');
  if (!Number.isInteger(input.days) || input.days < 1 || input.days > MAX_SANE_RENTAL_DAYS) throw new RangeError('days deve ser um inteiro entre 1 e o teto de sanidade.');
  const extraDays = input.days - 1;
  const extraDayCents = extraDayPriceCents(input.baseCents, config);
  const extrasCents = extraDays * extraDayCents;
  if (extraDayCents > DB_MAX_EXTRA_DAY_CENTS) throw new RangeError('Diária adicional acima do teto do banco.');
  const totalCents = input.baseCents + extrasCents;
  if (!Number.isSafeInteger(totalCents) || totalCents > DB_MAX_LINE_TOTAL_CENTS) throw new RangeError('Total da peça acima do teto do banco.');
  return { id: input.id, days: input.days, baseCents: input.baseCents, firstDayCents: input.baseCents, extraDays, extraDayCents, extrasCents, totalCents };
}

/**
 * Preço do pedido inteiro: soma das peças (cada uma com a sua duração) + UMA taxa de reserva.
 *
 * FAIL CLOSED, no mesmo estilo de `calculateRentalPlan`: se qualquer entrada for inválida devolve `{ ok: false }` com
 * TODAS as violações e nenhum preço — não existe jeito de ler um total parcial por engano.
 */
export function priceReservation(items: readonly PricedItemInput[], config: RentalPricingConfig): ReservationPricingResult {
  if (!validatePricingConfig(config)) {
    // Taxa inteira e válida, só acima do teto do banco: violação própria (o resto da configuração está bem).
    const feeOnly = config && typeof config === 'object' && isNonNegativeSafeInt(config.reservationFeeCents) && config.reservationFeeCents > DB_MAX_RESERVATION_FEE_CENTS
      && validatePricingConfig({ ...config, reservationFeeCents: 0 });
    return { ok: false, violations: [{ code: feeOnly ? 'reservation_fee_above_ceiling' : 'invalid_config' }] };
  }

  if (!Array.isArray(items)) return { ok: false, violations: [{ code: 'no_items' }] };
  const violations: PricingViolation[] = [];
  if (items.length === 0) violations.push({ code: 'no_items' });
  if (config.maxItems !== undefined && items.length > config.maxItems) violations.push({ code: 'too_many_items' });

  const seen = new Set<string>();
  for (const item of items) {
    if (item === null || typeof item !== 'object' || typeof item.id !== 'string' || item.id === '') {
      violations.push({ code: 'invalid_item', ...(item !== null && typeof item === 'object' && typeof item.id === 'string' ? { itemId: item.id } : {}) });
      continue;
    }
    if (seen.has(item.id)) violations.push({ code: 'duplicate_item_id', itemId: item.id });
    seen.add(item.id);
    const baseUsable = isCents(item.baseCents);
    if (baseUsable) {
      // Mesma conta de `priceItem`, para apontar QUAL teto do banco estoura (base × bp ≤ 1e13: seguro).
      const extra = extraDayPriceCents(item.baseCents, config);
      if (extra > DB_MAX_EXTRA_DAY_CENTS) violations.push({ code: 'extra_day_above_ceiling', itemId: item.id });
      else if (Number.isInteger(item.days) && item.days >= 1 && item.days <= MAX_SANE_RENTAL_DAYS && item.baseCents + (item.days - 1) * extra > DB_MAX_LINE_TOTAL_CENTS) {
        violations.push({ code: 'line_total_above_ceiling', itemId: item.id });
      }
    } else if (isNonNegativeSafeInt(item.baseCents)) violations.push({ code: 'price_above_ceiling', itemId: item.id });
    else violations.push({ code: 'invalid_price', itemId: item.id });
    if (!Number.isInteger(item.days) || item.days < 1) violations.push({ code: 'invalid_days', itemId: item.id });
    else if (item.days > MAX_SANE_RENTAL_DAYS || (config.maxDaysPerItem !== undefined && item.days > config.maxDaysPerItem)) violations.push({ code: 'days_above_max', itemId: item.id });
  }
  if (violations.length > 0) return { ok: false, violations };

  let priced: PricedItem[];
  try {
    priced = items.map((item) => priceItem(item, config));
  } catch {
    // Só alcançável com valores no limite da faixa segura: tratado como preço inválido, nunca como total parcial.
    return { ok: false, violations: [{ code: 'invalid_price' }] };
  }
  const subtotalCents = priced.reduce((sum, item) => sum + item.totalCents, 0);
  const totalCents = subtotalCents + config.reservationFeeCents;
  if (!Number.isSafeInteger(totalCents)) return { ok: false, violations: [{ code: 'invalid_price' }] };
  if (totalCents > DB_MAX_EXPECTED_TOTAL_CENTS) return { ok: false, violations: [{ code: 'order_total_above_ceiling' }] };

  return { ok: true, pricing: { items: priced, subtotalCents, reservationFeeCents: config.reservationFeeCents, totalCents } };
}
