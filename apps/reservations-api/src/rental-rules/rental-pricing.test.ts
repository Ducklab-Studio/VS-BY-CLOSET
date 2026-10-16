import { describe, expect, test } from 'vitest';
import {
  MAX_PRICE_CENTS,
  extraDayPriceCents,
  priceItem,
  priceReservation,
  validatePricingConfig,
  type PricedItemInput,
  type RentalPricingConfig,
} from './rental-pricing';

/**
 * Regras INFORMADAS: 1ª diária integral; cada diária adicional = 50% do valor-base, sem juros compostos; durações
 * independentes por peça; taxa de reserva única por pedido. O valor da taxa (R$ 49,99) ainda não está confirmado —
 * aqui é só dado de teste, o motor não o conhece.
 */
const CONFIG: RentalPricingConfig = { extraDayBasisPoints: 5000, extraDayRounding: 'half_up', reservationFeeCents: 4999 };
const NO_FEE: RentalPricingConfig = { ...CONFIG, reservationFeeCents: 0 };

const item = (id: string, baseCents: number, days: number): PricedItemInput => ({ id, baseCents, days });
const ok = (items: PricedItemInput[], config = CONFIG) => {
  const result = priceReservation(items, config);
  if (!result.ok) throw new Error(`esperava ok, veio ${JSON.stringify(result.violations)}`);
  return result.pricing;
};
const codes = (items: PricedItemInput[], config = CONFIG) => {
  const result = priceReservation(items, config);
  if (result.ok) throw new Error('esperava violação');
  return result.violations.map((v) => (v.itemId === undefined ? v.code : `${v.code}:${v.itemId}`));
};

describe('uma peça: primeira diária integral, adicionais a 50% do valor-base', () => {
  test('exemplos com os preços reais da loja (R$ 120, 150 e 350)', () => {
    // R$ 150,00: 1 dia = 150; 2 = 225; 3 = 300; 4 = 375
    expect([1, 2, 3, 4].map((days) => priceItem(item('a', 15000, days), CONFIG).totalCents)).toEqual([15000, 22500, 30000, 37500]);
    // R$ 120,00: 1 = 120; 2 = 180; 5 = 360
    expect([1, 2, 5].map((days) => priceItem(item('a', 12000, days), CONFIG).totalCents)).toEqual([12000, 18000, 36000]);
    // R$ 350,00: 3 dias = 350 + 2 × 175 = 700
    expect(priceItem(item('a', 35000, 3), CONFIG).totalCents).toBe(70000);
  });

  test('o detalhamento fecha: 1ª diária + adicionais × preço do adicional', () => {
    const priced = priceItem(item('a', 15000, 4), CONFIG);
    expect(priced).toMatchObject({ days: 4, firstDayCents: 15000, extraDays: 3, extraDayCents: 7500, extrasCents: 22500, totalCents: 37500 });
  });

  test('SEM juros compostos: o preço do dia adicional não depende da quantidade de dias e é linear', () => {
    const base = 15000;
    let previous = priceItem(item('a', base, 1), CONFIG).totalCents;
    for (let days = 2; days <= 60; days++) {
      const total = priceItem(item('a', base, days), CONFIG).totalCents;
      expect(total - previous).toBe(7500); // sempre 50% do valor-base, nunca 50% do acumulado
      expect(total).toBe(base + (days - 1) * 7500);
      previous = total;
    }
    // juros compostos dariam 15000 × 1,5^(d−1): para 5 dias, 75937,5 — o motor devolve 45000
    expect(priceItem(item('a', base, 5), CONFIG).totalCents).toBe(45000);
  });

  test('percentual é parâmetro: 0% (dias extras grátis), 100% e 25%', () => {
    expect(priceItem(item('a', 10000, 3), { ...CONFIG, extraDayBasisPoints: 0 }).totalCents).toBe(10000);
    expect(priceItem(item('a', 10000, 3), { ...CONFIG, extraDayBasisPoints: 10000 }).totalCents).toBe(30000);
    expect(priceItem(item('a', 10000, 3), { ...CONFIG, extraDayBasisPoints: 2500 }).totalCents).toBe(15000);
  });

  test('valor-base com centavos ímpares: o arredondamento é explícito e aplicado UMA vez por dia adicional', () => {
    // R$ 99,99 → 50% = 49,995 → meio centavo
    expect(extraDayPriceCents(9999, { extraDayBasisPoints: 5000, extraDayRounding: 'half_up' })).toBe(5000);
    expect(extraDayPriceCents(9999, { extraDayBasisPoints: 5000, extraDayRounding: 'down' })).toBe(4999);
    expect(extraDayPriceCents(9999, { extraDayBasisPoints: 5000, extraDayRounding: 'up' })).toBe(5000);
    // valores pares não têm fração: os três modos coincidem
    for (const rounding of ['half_up', 'down', 'up'] as const) expect(extraDayPriceCents(15000, { extraDayBasisPoints: 5000, extraDayRounding: rounding })).toBe(7500);
    // 3 dias de R$ 99,99 com half_up: 9999 + 2 × 5000
    expect(priceItem(item('a', 9999, 3), CONFIG).totalCents).toBe(19999);
    // fração menor que meio centavo desce no half_up: 33% de 1,01 = 0,3333
    expect(extraDayPriceCents(101, { extraDayBasisPoints: 3300, extraDayRounding: 'half_up' })).toBe(33);
  });

  test('valor-base zero é válido (peça gratuita) e soma zero', () => {
    expect(priceItem(item('a', 0, 5), CONFIG).totalCents).toBe(0);
  });

  test('entradas inválidas lançam (uso direto) e nunca viram preço', () => {
    for (const days of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => priceItem(item('a', 1000, days), CONFIG)).toThrow(RangeError);
    for (const base of [-1, 1.5, Number.NaN, MAX_PRICE_CENTS + 1, Number.MAX_SAFE_INTEGER]) expect(() => priceItem(item('a', base, 1), CONFIG)).toThrow(RangeError);
  });
});

describe('pedido: peças com durações independentes + uma taxa de reserva', () => {
  test('cada peça tem a sua duração; o total é a soma exata mais UMA taxa', () => {
    const pricing = ok([item('jaqueta', 15000, 1), item('blazer', 12000, 3), item('conjunto', 35000, 2)]);
    expect(pricing.items.map((i) => [i.id, i.days, i.totalCents])).toEqual([
      ['jaqueta', 1, 15000], // 1 dia
      ['blazer', 3, 24000], // 120 + 2 × 60
      ['conjunto', 2, 52500], // 350 + 175
    ]);
    expect(pricing.subtotalCents).toBe(91500);
    expect(pricing.reservationFeeCents).toBe(4999);
    expect(pricing.totalCents).toBe(96499);
  });

  test('a taxa é única por pedido: não muda com 1 ou 6 peças', () => {
    expect(ok([item('a', 10000, 1)]).totalCents).toBe(10000 + 4999);
    const six = ok(Array.from({ length: 6 }, (_, i) => item(`p${i}`, 10000, 1)));
    expect(six.reservationFeeCents).toBe(4999);
    expect(six.totalCents).toBe(60000 + 4999);
  });

  test('sem taxa configurada o total é só o subtotal', () => {
    const pricing = ok([item('a', 10000, 2)], NO_FEE);
    expect(pricing.reservationFeeCents).toBe(0);
    expect(pricing.totalCents).toBe(pricing.subtotalCents);
  });

  test('a ordem das peças não muda nenhum valor', () => {
    const items = [item('a', 15000, 4), item('b', 9999, 2), item('c', 35000, 1), item('d', 12000, 7)];
    const forward = ok(items);
    const backward = ok([...items].reverse());
    expect(backward.totalCents).toBe(forward.totalCents);
    expect(backward.subtotalCents).toBe(forward.subtotalCents);
    for (const priced of forward.items) expect(backward.items.find((i) => i.id === priced.id)).toEqual(priced);
  });

  test('a mesma peça (mesmo valor-base) com durações diferentes é precificada separadamente', () => {
    const pricing = ok([item('unidade-1', 15000, 1), item('unidade-2', 15000, 3)]);
    expect(pricing.items.map((i) => i.totalCents)).toEqual([15000, 30000]);
  });

  test('só inteiros em todos os campos, e a soma de partes iguala o total (sem ponto flutuante)', () => {
    const pricing = ok(Array.from({ length: 6 }, (_, i) => item(`p${i}`, 9999 + i * 7, 1 + i)));
    const numbers = [pricing.subtotalCents, pricing.reservationFeeCents, pricing.totalCents, ...pricing.items.flatMap((i) => [i.firstDayCents, i.extraDayCents, i.extrasCents, i.totalCents])];
    for (const value of numbers) expect(Number.isSafeInteger(value)).toBe(true);
    expect(pricing.items.reduce((sum, i) => sum + i.totalCents, 0)).toBe(pricing.subtotalCents);
    expect(pricing.subtotalCents + pricing.reservationFeeCents).toBe(pricing.totalCents);
    for (const i of pricing.items) expect(i.firstDayCents + i.extrasCents).toBe(i.totalCents);
  });

  test('propriedade: para qualquer valor-base e duração, total = base + (dias − 1) × adicional, e crescer 1 dia soma exatamente o adicional', () => {
    let seed = 12345;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
    for (let n = 0; n < 500; n++) {
      const base = next() % 500_000;
      const days = 1 + (next() % 30);
      const rounding = (['half_up', 'down', 'up'] as const)[next() % 3];
      const config: RentalPricingConfig = { extraDayBasisPoints: next() % 20_000, extraDayRounding: rounding, reservationFeeCents: next() % 10_000 };
      const here = priceItem(item('x', base, days), config);
      const more = priceItem(item('x', base, days + 1), config);
      expect(here.totalCents).toBe(base + (days - 1) * extraDayPriceCents(base, config));
      expect(more.totalCents - here.totalCents).toBe(extraDayPriceCents(base, config));
    }
  });
});

describe('fail closed: violações em vez de total parcial', () => {
  test('pedido vazio, peças demais e ids duplicados', () => {
    expect(codes([])).toEqual(['no_items']);
    expect(codes([item('a', 1000, 1), item('b', 1000, 1), item('c', 1000, 1)], { ...CONFIG, maxItems: 2 })).toEqual(['too_many_items']);
    expect(codes([item('a', 1000, 1), item('a', 2000, 1)])).toEqual(['duplicate_item_id:a']);
    expect(codes([item('', 1000, 1)])).toEqual(['duplicate_item_id:']);
  });

  test('duração inválida ou acima do teto, e preço inválido, apontando a peça', () => {
    expect(codes([item('a', 1000, 0), item('b', 1000, 2.5)])).toEqual(['invalid_days:a', 'invalid_days:b']);
    expect(codes([item('a', 1000, 8)], { ...CONFIG, maxDaysPerItem: 7 })).toEqual(['days_above_max:a']);
    expect(ok([item('a', 1000, 7)], { ...CONFIG, maxDaysPerItem: 7 }).items).toHaveLength(1);
    expect(codes([item('a', -5, 1), item('b', 10.5, 1), item('c', MAX_PRICE_CENTS + 1, 1)])).toEqual(['invalid_price:a', 'invalid_price:b', 'invalid_price:c']);
  });

  test('todas as violações vêm juntas e nenhuma peça válida vaza preço', () => {
    const result = priceReservation([item('a', 1000, 0), item('b', -1, 1), item('c', 1000, 1)], CONFIG);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('pricing');
    expect(!result.ok && result.violations.map((v) => v.itemId)).toEqual(['a', 'b']);
  });

  test('configuração inválida é recusada', () => {
    const bad: Partial<RentalPricingConfig>[] = [
      { extraDayBasisPoints: -1 },
      { extraDayBasisPoints: 100_001 },
      { extraDayBasisPoints: 50.5 },
      { extraDayRounding: 'banker' as unknown as 'down' },
      { reservationFeeCents: -1 },
      { reservationFeeCents: 49.99 },
      { maxDaysPerItem: 0 },
      { maxItems: 0 },
    ];
    for (const patch of bad) {
      const config = { ...CONFIG, ...patch };
      expect(validatePricingConfig(config)).toBe(false);
      expect(priceReservation([item('a', 1000, 1)], config)).toEqual({ ok: false, violations: [{ code: 'invalid_config' }] });
    }
    expect(validatePricingConfig(CONFIG)).toBe(true);
  });

  test('o motor não conhece a taxa nem o percentual: sem config válida não há preço padrão', () => {
    expect(priceReservation([item('a', 1000, 1)], undefined as unknown as RentalPricingConfig)).toEqual({ ok: false, violations: [{ code: 'invalid_config' }] });
  });
});
