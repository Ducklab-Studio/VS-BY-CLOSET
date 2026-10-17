import 'reflect-metadata';
import { afterAll, describe, expect, test } from 'vitest';
import type { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import {
  DB_MAX_EXPECTED_TOTAL_CENTS,
  DB_MAX_EXTRA_DAY_CENTS,
  DB_MAX_LINE_TOTAL_CENTS,
  DB_MAX_RESERVATION_FEE_CENTS,
  DB_MAX_UNIT_BASE_CENTS,
  priceReservation,
  type ExtraDayRounding,
  type PricedItemInput,
  type PricingViolationCode,
  type RentalPricingConfig,
} from '../rental-rules/rental-pricing';

/**
 * Fase 3 — o motor de preços (`rental-pricing.ts`) × os tetos monetários da migration A1, contra PostgreSQL LOCAL.
 *
 *  1. PARIDADE: os números das constraints (`pg_get_constraintdef`) são exatamente as constantes do motor.
 *  2. SOUNDNESS: todo preço que o motor ACEITA é gravável no banco (reservation_items + reservations, todas as CHECKs).
 *  3. COMPLETUDE: todo valor que o motor rejeita por teto é recusado pelo PostgreSQL (CHECK 23514 ou int4 22003).
 *
 * Cada caso roda numa transação que SEMPRE termina em ROLLBACK: nada persiste e nenhum dado compartilhado é alterado.
 * Sem `DATABASE_URL` local de teste o arquivo é pulado (roda no CI com PostgreSQL de serviço).
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
afterAll(async () => {
  await prisma.$disconnect();
});

class Rollback extends Error {}
type Tx = Prisma.TransactionClient;

async function inTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out!: T;
  try {
    await prisma.$transaction(async (tx) => {
      out = await fn(tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  }
  return out;
}

function sqlstate(error: unknown): { code: string; message: string } {
  const e = error as { code?: string; message?: string; meta?: { code?: string; message?: string } };
  return { code: e.meta?.code ?? e.code ?? 'unknown', message: `${e.meta?.message ?? ''} ${e.message ?? ''}` };
}

interface LineValues { readonly id: string; readonly base: number; readonly extra: number; readonly line: number; readonly days: number }
interface OrderValues { readonly lines: readonly LineValues[]; readonly fee: number; readonly total: number; readonly bp: number; readonly rounding: ExtraDayRounding }

const PICKUP = '2026-12-10';
const plusDays = (n: number) => new Date(Date.parse(`${PICKUP}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Grava o pedido + as peças EXATAMENTE como a migration B/ativação gravará. Devolve o erro do Postgres ou null. */
async function writeOrder(order: OrderValues): Promise<{ code: string; message: string } | null> {
  return inTx(async (tx) => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const storeId = `pc-${suffix}`;
    await tx.$executeRaw`INSERT INTO stores (id, shopify_domain, currency) VALUES (${storeId}, ${storeId + '.invalid'}, 'BRL')`;
    const snapshot = JSON.stringify({ engine: 'rental-pricing@1', currency: 'BRL', timezone: 'America/Santiago', extraDayBasisPoints: order.bp, extraDayRounding: order.rounding, reservationFeeCents: order.fee });
    try {
      const [reservation] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO reservations (id, status, origin_store_id, pricing_version, pricing_snapshot, reservation_fee_cents, expected_total_cents)
        VALUES (gen_random_uuid(), 'hold', ${storeId}, 1, ${snapshot}::jsonb, ${order.fee}::int, ${order.total}::int) RETURNING id`;
      let n = 0;
      for (const l of order.lines) {
        const code = `PC-${suffix}-${n++}`;
        const [unit] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO rental_units (code, name, shopify_variant_id) VALUES (${code}, 'peça', ${code}) RETURNING id`;
        const ret = plusDays(l.days);
        await tx.$executeRaw`INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range, pickup_date, rental_days,
            calculated_return_date, return_date, prep_days_applied, cleaning_days_applied, unit_base_cents, extra_day_cents, line_total_cents)
          VALUES (${reservation.id}::uuid, ${unit.id}::uuid, 'hold', daterange(${PICKUP}::date, (${ret}::date) + 1, '[)'), ${PICKUP}::date, ${l.days}::int,
            ${ret}::date, ${ret}::date, 0, 0, ${l.base}::int, ${l.extra}::int, ${l.line}::int)`;
      }
      return null;
    } catch (error) {
      return sqlstate(error);
    }
  });
}

/** Diária adicional pela mesma regra do motor, mas SEM o teto de entrada (o motor lançaria RangeError). */
function extraDayUnclamped(base: number, config: RentalPricingConfig): number {
  const numerator = base * config.extraDayBasisPoints;
  const quotient = Math.floor(numerator / 10_000);
  const remainder = numerator - quotient * 10_000;
  if (remainder === 0 || config.extraDayRounding === 'down') return quotient;
  if (config.extraDayRounding === 'up') return quotient + 1;
  return remainder * 2 >= 10_000 ? quotient + 1 : quotient;
}

/** Mesma aritmética do motor, SEM tetos — o que seria gravado se o motor não protegesse o banco. */
function unclamped(items: readonly PricedItemInput[], config: RentalPricingConfig): OrderValues {
  const lines = items.map((i) => {
    const extra = extraDayUnclamped(i.baseCents, config);
    return { id: i.id, base: i.baseCents, extra, line: i.baseCents + (i.days - 1) * extra, days: i.days };
  });
  return { lines, fee: config.reservationFeeCents, total: lines.reduce((s, l) => s + l.line, 0) + config.reservationFeeCents, bp: config.extraDayBasisPoints, rounding: config.extraDayRounding };
}

/** Gerador determinístico (mulberry32): o mesmo conjunto de cenários em toda execução. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CEILING_CODES: readonly PricingViolationCode[] = ['price_above_ceiling', 'extra_day_above_ceiling', 'line_total_above_ceiling', 'reservation_fee_above_ceiling', 'order_total_above_ceiling'];
const INT4_OR_CHECK = ['23514', '22003'];

localDescribe('Fase 3 — motor de preços × tetos monetários da A1 (Postgres local)', () => {
  test('paridade: os números das CHECKs do banco são exatamente as constantes do motor', async () => {
    const rows = await prisma.$queryRaw<{ conname: string; def: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname IN ('ri_pricing_ceilings', 'r_pricing_amounts', 'ri_schedule_ranges')`;
    const def = (name: string) => rows.find((r) => r.conname === name)?.def.replace(/[()\s]+/g, ' ') ?? '';
    const ri = def('ri_pricing_ceilings');
    expect(ri).toContain(`unit_base_cents >= 0 AND unit_base_cents <= ${DB_MAX_UNIT_BASE_CENTS}`);
    expect(ri).toContain(`extra_day_cents >= 0 AND extra_day_cents <= ${DB_MAX_EXTRA_DAY_CENTS}`);
    expect(ri).toContain(`line_total_cents >= 0 AND line_total_cents <= ${DB_MAX_LINE_TOTAL_CENTS}`);
    const r = def('r_pricing_amounts');
    expect(r).toContain(`reservation_fee_cents >= 0 AND reservation_fee_cents <= ${DB_MAX_RESERVATION_FEE_CENTS}`);
    expect(r).toContain(`expected_total_cents >= reservation_fee_cents AND expected_total_cents <= ${DB_MAX_EXPECTED_TOTAL_CENTS}`);
    // e as durações (1..3650) são as do teto de sanidade do motor
    expect(def('ri_schedule_ranges')).toContain('rental_days >= 1 AND rental_days <= 3650');
  });

  test('fronteiras exatas: o teto é aceito pelo banco e pelo motor; um centavo acima é recusado pelos dois', async () => {
    const config: RentalPricingConfig = { extraDayBasisPoints: 10_000, extraDayRounding: 'half_up', reservationFeeCents: DB_MAX_RESERVATION_FEE_CENTS };
    // 2 linhas no teto (1e9 cada) + taxa no teto: total 2,1e9 > 2e9 ⇒ teto do pedido; tira a taxa ⇒ exatamente 2e9
    const two: PricedItemInput[] = [{ id: 'a', baseCents: DB_MAX_UNIT_BASE_CENTS, days: 10 }, { id: 'b', baseCents: DB_MAX_UNIT_BASE_CENTS, days: 10 }];
    const atCeiling = priceReservation(two, { ...config, reservationFeeCents: 0 });
    expect(atCeiling.ok && atCeiling.pricing.totalCents).toBe(DB_MAX_EXPECTED_TOTAL_CENTS);
    if (atCeiling.ok) {
      expect(await writeOrder({ lines: atCeiling.pricing.items.map((i) => ({ id: i.id, base: i.baseCents, extra: i.extraDayCents, line: i.totalCents, days: i.days })), fee: 0, total: atCeiling.pricing.totalCents, bp: 10_000, rounding: 'half_up' })).toBeNull();
    }
    const over = priceReservation(two, { ...config, reservationFeeCents: 1 });
    expect(over).toEqual({ ok: false, violations: [{ code: 'order_total_above_ceiling' }] });
    expect((await writeOrder({ ...unclamped(two, { ...config, reservationFeeCents: 1 }) }))?.code).toBe('23514');
    // taxa no teto aceita; um centavo acima recusada (motor e banco)
    const one: PricedItemInput[] = [{ id: 'a', baseCents: 1000, days: 1 }];
    const feeOk = priceReservation(one, config);
    expect(feeOk.ok).toBe(true);
    expect(await writeOrder({ lines: [{ id: 'a', base: 1000, extra: 500, line: 1000, days: 1 }], fee: DB_MAX_RESERVATION_FEE_CENTS, total: DB_MAX_RESERVATION_FEE_CENTS + 1000, bp: 10_000, rounding: 'half_up' })).toBeNull();
    expect(priceReservation(one, { ...config, reservationFeeCents: DB_MAX_RESERVATION_FEE_CENTS + 1 })).toEqual({ ok: false, violations: [{ code: 'reservation_fee_above_ceiling' }] });
    const feeOver = await writeOrder({ lines: [{ id: 'a', base: 1000, extra: 500, line: 1000, days: 1 }], fee: DB_MAX_RESERVATION_FEE_CENTS + 1, total: DB_MAX_RESERVATION_FEE_CENTS + 1001, bp: 10_000, rounding: 'half_up' });
    expect(feeOver?.message).toContain('"r_pricing_amounts"');
  });

  test('soundness e completude: 400 pedidos gerados (extremos, várias peças, taxas, dias adicionais)', async () => {
    const next = rng(20261017);
    const pick = <T,>(values: readonly T[]) => values[Math.floor(next() * values.length)];
    const bases = [0, 1, 99, 9999, 15000, 4_999_999, 50_000_000, DB_MAX_UNIT_BASE_CENTS - 1, DB_MAX_UNIT_BASE_CENTS, DB_MAX_UNIT_BASE_CENTS + 1, 150_000_000];
    const dayss = [1, 2, 3, 7, 30, 365, 3649, 3650];
    const bps = [0, 1, 2500, 5000, 5001, 10_000, 20_000, 100_000];
    const fees = [0, 4999, 100_000, DB_MAX_RESERVATION_FEE_CENTS, DB_MAX_RESERVATION_FEE_CENTS + 1];
    const roundings: readonly ExtraDayRounding[] = ['half_up', 'down', 'up'];

    const tally = { accepted: 0, rejected: new Map<string, number>() };
    for (let scenario = 0; scenario < 400; scenario++) {
      const count = 1 + Math.floor(next() * 4);
      // ~10% dos pedidos são de "linhas no teto" (100% por diária, base máxima, 10 diárias = R$ 10 milhões cada):
      // é o único jeito de somar além do teto do pedido com cada linha ainda válida
      const saturated = next() < 0.1;
      const items: PricedItemInput[] = Array.from({ length: count }, (_, i) => saturated ? { id: `p${i}`, baseCents: DB_MAX_UNIT_BASE_CENTS, days: 10 } : ({
        id: `p${i}`,
        // metade dos casos usa valores "comportados" (aceitos), a outra metade mira os extremos
        baseCents: next() < 0.5 ? Math.floor(next() * 400_000) : pick(bases),
        days: next() < 0.5 ? 1 + Math.floor(next() * 30) : pick(dayss),
      }));
      const config: RentalPricingConfig = {
        extraDayBasisPoints: saturated ? 10_000 : next() < 0.5 ? 5000 : pick(bps),
        extraDayRounding: pick(roundings),
        reservationFeeCents: next() < 0.5 ? 4999 : pick(fees),
      };
      const result = priceReservation(items, config);
      if (result.ok) {
        tally.accepted++;
        const p = result.pricing;
        // o que o motor aceitou satisfaz as fórmulas do banco e CABE nas colunas
        const error = await writeOrder({
          lines: p.items.map((i) => ({ id: i.id, base: i.baseCents, extra: i.extraDayCents, line: i.totalCents, days: i.days })),
          fee: p.reservationFeeCents, total: p.totalCents, bp: config.extraDayBasisPoints, rounding: config.extraDayRounding,
        });
        expect(error, `motor aceitou e o banco recusou: ${JSON.stringify({ items, config, error })}`).toBeNull();
        expect(p.totalCents).toBeLessThanOrEqual(DB_MAX_EXPECTED_TOTAL_CENTS);
      } else {
        const codes = result.violations.map((v) => v.code);
        for (const code of codes) tally.rejected.set(code, (tally.rejected.get(code) ?? 0) + 1);
        if (codes.some((c) => CEILING_CODES.includes(c)) && codes.every((c) => CEILING_CODES.includes(c))) {
          // rejeitado SÓ por teto: o banco tem que recusar exatamente esses valores
          const error = await writeOrder(unclamped(items, config));
          expect(error, `motor rejeitou por teto (${codes.join(',')}) e o banco aceitou: ${JSON.stringify({ items, config })}`).not.toBeNull();
          expect(INT4_OR_CHECK).toContain(error!.code);
        }
      }
    }
    // o conjunto gerado de fato exercita os dois lados e cada tipo de teto
    expect(tally.accepted).toBeGreaterThan(100);
    for (const code of ['price_above_ceiling', 'extra_day_above_ceiling', 'line_total_above_ceiling', 'reservation_fee_above_ceiling', 'order_total_above_ceiling']) {
      expect(tally.rejected.get(code) ?? 0, `nenhum cenário gerou ${code}`).toBeGreaterThan(0);
    }
  }, 300_000);
});
