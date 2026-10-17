import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import type { Prisma } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { ReservationsService } from '../reservations/reservations.service';
import { generateHoldToken, hashHoldToken } from '../holds/hold-token';
import { priceReservation } from '../rental-rules/rental-pricing';

/**
 * Fase 3 — migration A1 (colunas nulas + CHECKs NOT VALID do modelo v2.1). Integração contra PostgreSQL LOCAL de
 * teste (sem `DATABASE_URL` de loopback com nome de teste o arquivo é pulado).
 *
 * Independe de ordem e não deixa resíduo: cada caso roda dentro de UMA transação que sempre termina em ROLLBACK
 * (fixtures inclusive). Não altera `rental_rule_config` nem qualquer dado compartilhado.
 *
 * A1 NÃO ativa nada: este arquivo também garante que nenhum código de produção lê ou grava as colunas novas e que
 * elas não aparecem em respostas públicas. O PR que ativar o recurso remove/ajusta os guardas marcados com "A1".
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
afterAll(async () => {
  await prisma.$disconnect();
});

class Rollback extends Error {}
type Tx = Prisma.TransactionClient;

/** Roda `fn` numa transação que SEMPRE desfaz (mesmo com erro do Postgres, que aborta a transação). */
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

interface DbError { readonly code: string; readonly message: string }
/** Normaliza o erro do Prisma (P2010) para o código SQLSTATE e a mensagem do Postgres. */
function dbError(error: unknown): DbError {
  const e = error as { code?: string; message?: string; meta?: { code?: string; message?: string } };
  return { code: e.meta?.code ?? e.code ?? 'unknown', message: `${e.meta?.message ?? ''} ${e.message ?? ''}` };
}

async function fixtures(tx: Tx) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const storeId = `a1-${suffix}`;
  await tx.$executeRaw`INSERT INTO stores (id, shopify_domain, currency) VALUES (${storeId}, ${storeId + '.invalid'}, 'BRL')`;
  const unit = async () => {
    const code = `A1-${suffix}-${Math.random().toString(36).slice(2, 8)}`;
    const [row] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO rental_units (code, name, shopify_variant_id) VALUES (${code}, 'peça A1', ${code}) RETURNING id`;
    return row.id;
  };
  const reservation = async (o: { status?: string; source?: string; pickup?: string | null; ret?: string | null } = {}) => {
    const [row] = await tx.$queryRaw<{ id: string }[]>`INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date)
      VALUES (gen_random_uuid(), ${o.status ?? 'hold'}::reservation_status, ${o.source ?? 'online'}::reservation_source, ${storeId},
              ${o.pickup === undefined ? '2026-12-10' : o.pickup}::date, ${o.ret === undefined ? '2026-12-13' : o.ret}::date) RETURNING id`;
    return row.id;
  };
  return { storeId, unit, reservation };
}

/** Item por peça válido: retirada 10/12, 3 dias, devolução efetiva 13/12, preparação 5, limpeza 4 => [05/12, 18/12). */
interface PieceOpts {
  pickup?: string; days?: number; calc?: string; ret?: string; prep?: number; clean?: number; range?: string;
  minute?: number | null; base?: number | null; extra?: number | null; line?: number | null; status?: string;
}
async function piece(tx: Tx, reservationId: string, unitId: string, o: PieceOpts = {}) {
  const pickup = o.pickup ?? '2026-12-10';
  const days = o.days ?? 3;
  const prep = o.prep ?? 5;
  const clean = o.clean ?? 4;
  const base = o.base === undefined ? 15000 : o.base;
  const extra = o.extra === undefined ? 7500 : o.extra;
  const line = o.line === undefined ? (base === null || extra === null ? null : base + (days - 1) * extra) : o.line;
  // `range` (texto de daterange) permite quebrar só a janela; senão é a fórmula congelada.
  const range = o.range ?? null;
  return tx.$executeRaw`INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range,
      pickup_date, rental_days, calculated_return_date, return_date, prep_days_applied, cleaning_days_applied,
      pickup_minute_of_day, unit_base_cents, extra_day_cents, line_total_cents)
    VALUES (${reservationId}::uuid, ${unitId}::uuid, ${o.status ?? 'hold'}::reservation_status,
      COALESCE(${range}::daterange, daterange(${pickup}::date - ${prep}::int, (${o.ret ?? null}::date) + ${clean}::int + 1, '[)')),
      ${pickup}::date, ${days}::int, ${o.calc ?? null}::date, ${o.ret ?? null}::date, ${prep}::int, ${clean}::int,
      ${o.minute ?? null}::smallint, ${base}::int, ${extra}::int, ${line}::int)`;
}
/** Preenche calc/ret padrão (retirada + dias) quando o caso não os informa. */
function withDates(o: PieceOpts): PieceOpts {
  const pickup = o.pickup ?? '2026-12-10';
  const days = o.days ?? 3;
  const plus = (n: number) => new Date(Date.parse(`${pickup}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  return { ...o, calc: o.calc ?? plus(days), ret: o.ret ?? plus(days) };
}
const ok = (o: PieceOpts = {}) => withDates(o);

async function expectViolation(setup: (tx: Tx, f: Awaited<ReturnType<typeof fixtures>>) => Promise<unknown>, constraint: string | RegExp, code = '23514') {
  const result = await inTx(async (tx) => {
    const f = await fixtures(tx);
    try {
      await setup(tx, f);
      return null;
    } catch (error) {
      return dbError(error);
    }
  });
  expect(result, 'esperava violação, mas o Postgres aceitou').not.toBeNull();
  expect(result!.code).toBe(code);
  if (typeof constraint === 'string') expect(result!.message).toContain(`"${constraint}"`);
  else expect(result!.message).toMatch(constraint);
}
async function expectAccepted(setup: (tx: Tx, f: Awaited<ReturnType<typeof fixtures>>) => Promise<unknown>) {
  await inTx(async (tx) => {
    await setup(tx, await fixtures(tx));
  });
}

localDescribe('Fase 3 — migration A1 (Postgres local)', () => {
  describe('compatibilidade com reservas legadas (statements EXATOS do código atual)', () => {
    test('INSERT legado do HOLD e da reserva manual continuam aceitos; colunas novas ficam nulas', async () => {
      await inTx(async (tx) => {
        const f = await fixtures(tx);
        const unit = await f.unit();
        const [hold] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO reservations (id, status, origin_store_id, pickup_date, return_date, calculated_return_date, rental_duration_days, expires_at, terms_accepted_at, terms_version, hold_token_hash)
          VALUES (gen_random_uuid(), 'hold', ${f.storeId}, '2027-01-10'::date, '2027-01-12'::date, '2027-01-12'::date, 2, now() + 30 * interval '1 minute', now(), 'v1', 'h')
          RETURNING id`;
        await tx.$executeRaw`INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
          VALUES (gen_random_uuid(), ${hold.id}::uuid, ${unit}::uuid, 'hold', daterange('2027-01-05'::date, '2027-01-17'::date, '[)'))`;
        const [manual] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date, customer_name, customer_phone, customer_email, internal_note, confirmed_at)
          VALUES (gen_random_uuid(), 'confirmed', 'manual_admin', ${f.storeId}, '2027-02-10'::date, '2027-02-12'::date, 'N', '1', null, null, now()) RETURNING id`;
        await tx.$executeRaw`INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
          VALUES (gen_random_uuid(), ${manual.id}::uuid, ${await f.unit()}::uuid, 'confirmed', daterange('2027-02-05'::date, '2027-02-17'::date, '[)'))`;

        const items = await tx.reservationItem.findMany({ where: { reservationId: { in: [hold.id, manual.id] } } });
        expect(items).toHaveLength(2);
        for (const item of items) {
          expect(item.pickupDate).toBeNull(); expect(item.rentalDays).toBeNull(); expect(item.calculatedReturnDate).toBeNull();
          expect(item.returnDate).toBeNull(); expect(item.prepDaysApplied).toBeNull(); expect(item.cleaningDaysApplied).toBeNull();
          expect(item.pickupMinuteOfDay).toBeNull(); expect(item.unitBaseCents).toBeNull(); expect(item.extraDayCents).toBeNull();
          expect(item.lineTotalCents).toBeNull();
        }
        const reservations = await tx.reservation.findMany({ where: { id: { in: [hold.id, manual.id] } } });
        for (const r of reservations) {
          expect(r.pricingVersion).toBeNull(); expect(r.pricingSnapshot).toBeNull();
          expect(r.reservationFeeCents).toBeNull(); expect(r.expectedTotalCents).toBeNull();
        }
      });
    });

    test('gatilho de status continua espelhando o status do pedido em itens legados e por peça', async () => {
      await inTx(async (tx) => {
        const f = await fixtures(tx);
        const rid = await f.reservation({ pickup: '2027-03-10', ret: '2027-03-13' });
        await tx.$executeRaw`INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range)
          VALUES (${rid}::uuid, ${await f.unit()}::uuid, 'hold', daterange('2027-02-01'::date, '2027-02-10'::date, '[)'))`;
        await piece(tx, rid, await f.unit(), ok({ pickup: '2027-03-10' }));
        await tx.$executeRaw`UPDATE reservations SET status = 'confirmed' WHERE id = ${rid}::uuid`;
        const rows = await tx.$queryRaw<{ status: string }[]>`SELECT status::text FROM reservation_items WHERE reservation_id = ${rid}::uuid`;
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.status === 'confirmed')).toBe(true);
      });
    });

    test('EXCLUDE inalterada: sobreposição na mesma unidade é recusada (23P01), por peça × por peça e por peça × legado', async () => {
      await expectViolation(async (tx, f) => {
        const u = await f.unit();
        await piece(tx, await f.reservation(), u, ok());
        await piece(tx, await f.reservation(), u, ok({ pickup: '2026-12-15' })); // [10/12..18/12) × [10/12..) sobrepõe
      }, 'reservation_items_no_overlap_per_unit', '23P01');
      await expectViolation(async (tx, f) => {
        const u = await f.unit();
        await piece(tx, await f.reservation(), u, ok());
        await tx.$executeRaw`INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range)
          VALUES (${await f.reservation()}::uuid, ${u}::uuid, 'hold', daterange('2026-12-17'::date, '2026-12-20'::date, '[)'))`;
      }, 'reservation_items_no_overlap_per_unit', '23P01');
    });

    test('duas peças da MESMA unidade no MESMO pedido com janelas disjuntas são aceitas', async () => {
      await expectAccepted(async (tx, f) => {
        const u = await f.unit();
        const rid = await f.reservation();
        await piece(tx, rid, u, ok());
        await piece(tx, rid, u, ok({ pickup: '2027-01-20', days: 2, extra: 7500, line: 22500 }));
      });
    });

    test('reserva MANUAL com cronograma por peça e SEM preço (sem Shopify) é aceita', async () => {
      await expectAccepted(async (tx, f) => {
        const rid = await f.reservation({ source: 'manual_admin', status: 'confirmed' });
        await piece(tx, rid, await f.unit(), ok({ base: null, extra: null, line: null, status: 'confirmed' }));
      });
    });
  });

  describe('CHECKs do cronograma por peça', () => {
    test('item válido é aceito', () => expectAccepted(async (tx, f) => piece(tx, await f.reservation(), await f.unit(), ok())));

    const cases: [string, PieceOpts, string][] = [
      ['rental_days 0', { days: 0 }, 'ri_schedule_ranges'],
      ['rental_days 3651', { days: 3651 }, 'ri_schedule_ranges'],
      ['preparação 366', { prep: 366 }, 'ri_schedule_ranges'],
      ['preparação negativa', { prep: -1 }, 'ri_schedule_ranges'],
      ['limpeza 366', { clean: 366 }, 'ri_schedule_ranges'],
      ['devolução contratada ≠ retirada + dias', { calc: '2026-12-14', ret: '2026-12-13' }, 'ri_calculated_return_matches'],
      ['devolução efetiva antes da retirada', { ret: '2026-12-09' }, 'ri_return_not_before_pickup'],
      ['janela bloqueada iniciando 1 dia depois', { range: '[2026-12-06,2026-12-18)' }, 'ri_blocked_range_matches_frozen_rules'],
      ['janela bloqueada terminando 1 dia antes', { range: '[2026-12-05,2026-12-17)' }, 'ri_blocked_range_matches_frozen_rules'],
      ['minuto do dia −1', { minute: -1 }, 'ri_pickup_minute_range'],
      ['minuto do dia 1440', { minute: 1440 }, 'ri_pickup_minute_range'],
    ];
    // cada caso quebra UM CHECK e mantém o resto coerente (sem preço, para não misturar com o grupo de preço)
    test.each(cases)('recusa: %s', async (_name, opts, constraint) => {
      await expectViolation(async (tx, f) => piece(tx, await f.reservation(), await f.unit(), { ...withDates(opts), base: null, extra: null, line: null }), constraint);
    });

    test('grupo de cronograma incompleto → ri_schedule_all_or_none (e pickup_date sozinho também é recusado)', async () => {
      await expectViolation(async (tx, f) => tx.$executeRaw`INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range, rental_days)
        VALUES (${await f.reservation()}::uuid, ${await f.unit()}::uuid, 'hold', daterange('2026-12-05'::date, '2026-12-18'::date, '[)'), 3)`, 'ri_schedule_all_or_none');
      await expectViolation(async (tx, f) => tx.$executeRaw`INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range, pickup_date)
        VALUES (${await f.reservation()}::uuid, ${await f.unit()}::uuid, 'hold', daterange('2026-12-05'::date, '2026-12-18'::date, '[)'), '2026-12-10'::date)`, /ri_/);
    });

    test('minuto do dia sem cronograma é recusado; 0 e 1439 são aceitos', async () => {
      await expectViolation(async (tx, f) => tx.$executeRaw`INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range, pickup_minute_of_day)
        VALUES (${await f.reservation()}::uuid, ${await f.unit()}::uuid, 'hold', daterange('2026-12-05'::date, '2026-12-18'::date, '[)'), 600)`, 'ri_pickup_minute_range');
      for (const minute of [0, 1439]) await expectAccepted(async (tx, f) => piece(tx, await f.reservation(), await f.unit(), ok({ minute })));
    });

    test('duração de 3650 dias é aceita (extremo válido); devolução no mesmo dia da retirada é aceita (D1 pendente: ">=")', async () => {
      await expectAccepted(async (tx, f) =>
        piece(tx, await f.reservation(), await f.unit(), { ...withDates({ days: 3650 }), base: null, extra: null, line: null }));
      await expectAccepted(async (tx, f) =>
        piece(tx, await f.reservation(), await f.unit(), { ...withDates({ days: 1 }), ret: '2026-12-10', base: null, extra: null, line: null }));
    });
  });

  describe('datas inválidas e valores absurdos', () => {
    test('data inexistente (31/02) e fora do calendário são recusadas pelo próprio tipo date', async () => {
      for (const bad of ['2026-02-31', '2026-13-01', '2026-00-10', '2026-04-31']) {
        const e = await inTx(async (tx) => {
          const f = await fixtures(tx);
          try {
            await tx.$executeRawUnsafe(`INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range, pickup_date, rental_days, calculated_return_date, return_date, prep_days_applied, cleaning_days_applied)
              VALUES ('${await f.reservation()}'::uuid, '${await f.unit()}'::uuid, 'hold', daterange('2026-12-05','2026-12-18','[)'), '${bad}', 3, '2026-12-13', '2026-12-13', 5, 4)`);
            return null;
          } catch (error) { return dbError(error); }
        });
        expect(e, `data ${bad} aceita`).not.toBeNull();
        expect(['22008', '22007']).toContain(e!.code);
      }
    });

    test('rental_days no limite do tipo (2.147.483.647) é recusado, sem estourar silenciosamente', async () => {
      const e = await inTx(async (tx) => {
        const f = await fixtures(tx);
        try {
          await tx.$executeRaw`INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range, pickup_date, rental_days, calculated_return_date, return_date, prep_days_applied, cleaning_days_applied)
            VALUES (${await f.reservation()}::uuid, ${await f.unit()}::uuid, 'hold', daterange('2026-12-05'::date, '2026-12-18'::date, '[)'), '2026-12-10'::date, 2147483647, '2026-12-13'::date, '2026-12-13'::date, 5, 4)`;
          return null;
        } catch (error) { return dbError(error); }
      });
      expect(e).not.toBeNull();
      // Dependendo da ordem de avaliação do Postgres, "date out of range" (22008) ou o CHECK (23514): ambos recusam.
      expect(['22008', '23514']).toContain(e!.code);
    });
  });

  describe('preço congelado, tetos e overflow (aritmética em bigint)', () => {
    test('preço válido; grupo de preço parcial; preço sem cronograma', async () => {
      await expectAccepted(async (tx, f) => piece(tx, await f.reservation(), await f.unit(), ok()));
      await expectViolation(async (tx, f) => tx.$executeRaw`INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range, unit_base_cents)
        VALUES (${await f.reservation()}::uuid, ${await f.unit()}::uuid, 'hold', daterange('2026-12-05'::date, '2026-12-18'::date, '[)'), 100)`, 'ri_pricing_all_or_none');
      await expectViolation(async (tx, f) => tx.$executeRaw`INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range, unit_base_cents, extra_day_cents, line_total_cents)
        VALUES (${await f.reservation()}::uuid, ${await f.unit()}::uuid, 'hold', daterange('2026-12-05'::date, '2026-12-18'::date, '[)'), 100, 50, 100)`, 'ri_pricing_requires_schedule');
    });

    test('total ≠ base + (dias − 1) × extra → ri_line_total_formula', () =>
      expectViolation(async (tx, f) => piece(tx, await f.reservation(), await f.unit(), ok({ line: 22499 })), 'ri_line_total_formula'));

    test.each([
      ['valor-base negativo', { days: 1, base: -1, extra: 0, line: -1 }],
      ['valor-base 100.000.001', { days: 1, base: 100_000_001, extra: 0, line: 100_000_001 }],
      ['dia extra 100.000.001', { days: 2, base: 0, extra: 100_000_001, line: 100_000_001 }],
      ['total de linha 1.000.000.001', { days: 11, base: 1, extra: 100_000_000, line: 1_000_000_001 }],
    ] as [string, PieceOpts][])('teto técnico: %s → ri_pricing_ceilings', async (_n, opts) => {
      await expectViolation(async (tx, f) => piece(tx, await f.reservation(), await f.unit(), ok(opts)), 'ri_pricing_ceilings');
    });

    test('limites exatos dos tetos são aceitos', async () => {
      await expectAccepted(async (tx, f) => piece(tx, await f.reservation(), await f.unit(), ok({ days: 1, base: 100_000_000, extra: 100_000_000, line: 100_000_000 })));
      await expectAccepted(async (tx, f) => piece(tx, await f.reservation(), await f.unit(), ok({ days: 11, base: 0, extra: 100_000_000, line: 1_000_000_000 })));
    });

    test('OVERFLOW: 3650 dias × 100.000.000 vira violação de CHECK (23514), não "integer out of range" (22003)', async () => {
      const e = await inTx(async (tx) => {
        const f = await fixtures(tx);
        try {
          await piece(tx, await f.reservation(), await f.unit(), ok({ days: 3650, base: 100_000_000, extra: 100_000_000, line: 1_000_000_000 }));
          return null;
        } catch (error) { return dbError(error); }
      });
      expect(e).not.toBeNull();
      expect(e!.code).toBe('23514');
      expect(e!.message).toContain('"ri_line_total_formula"');
    });

    test('valor acima da faixa do próprio tipo (3.000.000.000) é recusado pelo tipo (22003): o motor precisa impedir antes', async () => {
      const e = await inTx(async (tx) => {
        const f = await fixtures(tx);
        try {
          await piece(tx, await f.reservation(), await f.unit(), ok({ days: 1, base: 0, extra: 0, line: 0 }));
          await tx.$executeRawUnsafe(`UPDATE reservation_items SET unit_base_cents = 3000000000 WHERE rental_days = 1`);
          return null;
        } catch (error) { return dbError(error); }
      });
      expect(e).not.toBeNull();
      expect(e!.code).toBe('22003');
    });
  });

  describe('regra de preço congelada no pedido (pricing_snapshot)', () => {
    const snap = (extra: Record<string, unknown> = {}, fee = 4999) =>
      JSON.stringify({ engine: 'rental-pricing@1', currency: 'BRL', timezone: 'America/Santiago', extraDayBasisPoints: 5000, extraDayRounding: 'half_up', reservationFeeCents: fee, ...extra });
    const reservationWith = (tx: Tx, f: { storeId: string }, snapshot: string, o: { version?: number; fee?: number; total?: number } = {}) =>
      tx.$executeRaw`INSERT INTO reservations (id, status, origin_store_id, pricing_version, pricing_snapshot, reservation_fee_cents, expected_total_cents)
        VALUES (gen_random_uuid(), 'hold', ${f.storeId}, ${o.version ?? 1}::int, ${snapshot}::jsonb, ${o.fee ?? 4999}::int, ${o.total ?? 20000}::int)`;

    test('snapshot válido (inclusive com chaves extras e limites 0 / 100000) é aceito', async () => {
      await expectAccepted((tx, f) => reservationWith(tx, f, snap()));
      await expectAccepted((tx, f) => reservationWith(tx, f, snap({ extraDayBasisPoints: 0 })));
      await expectAccepted((tx, f) => reservationWith(tx, f, snap({ extraDayBasisPoints: 100000, maxDaysPerItem: 7, qualquer: { coisa: 1 } })));
    });

    test.each([
      ['engine ausente', JSON.stringify({ currency: 'BRL', timezone: 'x', extraDayBasisPoints: 5000, extraDayRounding: 'half_up', reservationFeeCents: 4999 })],
      ['engine ≠ versão', snap({ engine: 'rental-pricing@2' })],
      ['moeda minúscula', snap({ currency: 'brl' })],
      ['moeda com 4 letras', snap({ currency: 'BRLL' })],
      ['fuso vazio', snap({ timezone: '' })],
      ['fuso não-texto', snap({ timezone: 5 })],
      ['percentual 100001', snap({ extraDayBasisPoints: 100001 })],
      ['percentual negativo', snap({ extraDayBasisPoints: -1 })],
      ['percentual fracionário', snap({ extraDayBasisPoints: 50.5 })],
      ['percentual em texto', snap({ extraDayBasisPoints: '5000' })],
      ['arredondamento inválido', snap({ extraDayRounding: 'banker' })],
      ['taxa do snapshot ≠ coluna', snap({ reservationFeeCents: 1 })],
      ['taxa do snapshot em texto', snap({ reservationFeeCents: '4999' })],
      ['array', '[]'],
      ['texto', '"x"'],
      ['número', '5'],
    ])('recusa snapshot: %s', async (_n, snapshot) => {
      await expectViolation((tx, f) => reservationWith(tx, f, snapshot as string), /r_pricing_snapshot_valid/);
    });

    test('versão sem snapshot ou snapshot sem versão → r_pricing_all_or_none', async () => {
      await expectViolation((tx, f) => tx.$executeRaw`INSERT INTO reservations (id, status, origin_store_id, pricing_version) VALUES (gen_random_uuid(), 'hold', ${f.storeId}, 1)`, 'r_pricing_all_or_none');
      await expectViolation((tx, f) => tx.$executeRaw`INSERT INTO reservations (id, status, origin_store_id, pricing_snapshot) VALUES (gen_random_uuid(), 'hold', ${f.storeId}, '{}'::jsonb)`, 'r_pricing_all_or_none');
    });

    test('valores: total menor que a taxa, total acima de 2.000.000.000, taxa acima do teto → r_pricing_amounts; limites aceitos', async () => {
      await expectViolation((tx, f) => reservationWith(tx, f, snap({}, 100), { fee: 100, total: 99 }), 'r_pricing_amounts');
      await expectViolation((tx, f) => reservationWith(tx, f, snap(), { total: 2_000_000_001 }), 'r_pricing_amounts');
      await expectViolation((tx, f) => reservationWith(tx, f, snap({}, 100_000_001), { fee: 100_000_001, total: 100_000_001 }), 'r_pricing_amounts');
      await expectAccepted((tx, f) => reservationWith(tx, f, snap(), { total: 2_000_000_000 }));
      await expectAccepted((tx, f) => reservationWith(tx, f, snap({}, 0), { fee: 0, total: 0 }));
    });
  });

  describe('motor de preço × tetos do banco (alinhados; varredura completa em fase3-pricing-db-ceilings)', () => {
    const CONFIG = { extraDayBasisPoints: 5000, extraDayRounding: 'half_up' as const, reservationFeeCents: 4999 };

    test('o motor REJEITA os valores que o banco recusa (com violação estruturada) e o banco continua recusando', async () => {
      // valor-base de R$ 2.000.000,00: teto técnico do banco é 100.000.000
      expect(priceReservation([{ id: 'a', baseCents: 200_000_000, days: 1 }], CONFIG)).toEqual({ ok: false, violations: [{ code: 'price_above_ceiling', itemId: 'a' }] });
      await expectViolation(async (tx, f) => piece(tx, await f.reservation(), await f.unit(), ok({ days: 1, base: 200_000_000, extra: 100_000_000, line: 200_000_000 })), 'ri_pricing_ceilings');

      // 1000% do valor-base: dia extra de 1.000.000.000 (teto do banco: 100.000.000)
      expect(priceReservation([{ id: 'a', baseCents: 100_000_000, days: 2 }], { ...CONFIG, extraDayBasisPoints: 100_000 })).toEqual({ ok: false, violations: [{ code: 'extra_day_above_ceiling', itemId: 'a' }] });
      await expectViolation(async (tx, f) => piece(tx, await f.reservation(), await f.unit(), ok({ days: 2, base: 100_000_000, extra: 1_000_000_000, line: 1_100_000_000 })), 'ri_pricing_ceilings');

      // 3 peças de R$ 7.000.000,00 passam de 100.000.000 cada: o motor recusa a peça (antes aceitava e o banco recusava o total)
      const totalOver = priceReservation(Array.from({ length: 3 }, (_, i) => ({ id: `p${i}`, baseCents: 700_000_000, days: 1 })), CONFIG);
      expect(totalOver.ok).toBe(false);
      await expectViolation(async (tx, f) => tx.$executeRaw`INSERT INTO reservations (id, status, origin_store_id, pricing_version, pricing_snapshot, reservation_fee_cents, expected_total_cents)
        VALUES (gen_random_uuid(), 'hold', ${f.storeId}, 1, ${JSON.stringify({ engine: 'rental-pricing@1', currency: 'BRL', timezone: 'America/Santiago', extraDayBasisPoints: 5000, extraDayRounding: 'half_up', reservationFeeCents: 4999 })}::jsonb, 4999, 2100004999::int)`, 'r_pricing_amounts');
    });

    test('resultados dentro dos tetos (preços reais da loja) casam com o banco: a fórmula do motor satisfaz o CHECK', async () => {
      for (const [base, days] of [[12000, 1], [15000, 3], [35000, 2], [9999, 3], [15000, 3650]] as const) {
        const priced = priceReservation([{ id: 'a', baseCents: base, days }], CONFIG);
        if (!priced.ok) throw new Error('motor recusou preço válido');
        const item = priced.pricing.items[0];
        if (item.totalCents > 1_000_000_000) continue;
        await expectAccepted(async (tx, f) => piece(tx, await f.reservation(), await f.unit(), ok({ days, base: item.baseCents, extra: item.extraDayCents, line: item.totalCents })));
      }
    });
  });

  describe('Prisma e serialização JSON', () => {
    test('cliente tipado lê os campos novos como number/Date/Json, sem BigInt (JSON.stringify funciona)', async () => {
      await inTx(async (tx) => {
        const f = await fixtures(tx);
        const rid = await f.reservation({ pickup: '2026-12-10', ret: '2026-12-13' });
        await piece(tx, rid, await f.unit(), ok({ minute: 630 }));
        await tx.$executeRaw`UPDATE reservations SET pricing_version = 1, pricing_snapshot = ${JSON.stringify({ engine: 'rental-pricing@1', currency: 'BRL', timezone: 'America/Santiago', extraDayBasisPoints: 5000, extraDayRounding: 'half_up', reservationFeeCents: 4999 })}::jsonb,
          reservation_fee_cents = 4999, expected_total_cents = 34999 WHERE id = ${rid}::uuid`;
        const item = await tx.reservationItem.findFirstOrThrow({ where: { reservationId: rid } });
        const reservation = await tx.reservation.findUniqueOrThrow({ where: { id: rid } });
        expect(typeof item.rentalDays).toBe('number');
        expect(typeof item.lineTotalCents).toBe('number');
        expect(item.pickupMinuteOfDay).toBe(630);
        expect(item.pickupDate).toBeInstanceOf(Date);
        expect(item.pickupDate!.toISOString()).toBe('2026-12-10T00:00:00.000Z');
        expect(reservation.expectedTotalCents).toBe(34999);
        expect(typeof reservation.pricingVersion).toBe('number');
        expect(() => JSON.stringify({ item, reservation })).not.toThrow();
      });
    });

    test('SUM de colunas inteiras em $queryRaw retorna bigint (precisa de cast antes de serializar)', async () => {
      await inTx(async (tx) => {
        const f = await fixtures(tx);
        const rid = await f.reservation();
        await piece(tx, rid, await f.unit(), ok());
        const [row] = await tx.$queryRaw<{ soma: unknown; soma_int: unknown }[]>`SELECT sum(line_total_cents) AS soma, sum(line_total_cents)::int AS soma_int FROM reservation_items WHERE reservation_id = ${rid}::uuid`;
        expect(typeof row.soma).toBe('bigint');
        expect(() => JSON.stringify(row)).toThrow(/BigInt/);
        expect(typeof row.soma_int).toBe('number');
      });
    });
  });

  describe('A1 não ativa nada e os campos novos não vazam em respostas públicas', () => {
    test('resposta pública do status NÃO contém nenhum campo novo (mesmo com os campos preenchidos)', async () => {
      await inTx(async (tx) => {
        const f = await fixtures(tx);
        const token = generateHoldToken();
        const [row] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO reservations (id, status, origin_store_id, pickup_date, return_date, hold_token_hash, pricing_version, pricing_snapshot, reservation_fee_cents, expected_total_cents)
          VALUES (gen_random_uuid(), 'confirmed', ${f.storeId}, '2026-12-10'::date, '2026-12-13'::date, ${hashHoldToken(token)}, 1,
                  ${JSON.stringify({ engine: 'rental-pricing@1', currency: 'BRL', timezone: 'America/Santiago', extraDayBasisPoints: 5000, extraDayRounding: 'half_up', reservationFeeCents: 4999, segredo: 'SENTINELA-SNAPSHOT' })}::jsonb, 4999, 76999)
          RETURNING id`;
        await piece(tx, row.id, await f.unit(), ok({ base: 15000, extra: 7500, line: 30000 }));
        const service = new ReservationsService(tx as unknown as PrismaService);
        const status = await service.getStatus(row.id, token);
        expect(Object.keys(status).sort()).toEqual(['effectiveReturnDate', 'paymentStatus', 'pickupDate', 'status']);
        const text = JSON.stringify(status);
        for (const forbidden of ['SENTINELA-SNAPSHOT', 'rental-pricing', '76999', '4999', 'pricing', 'expectedTotal', 'unitBase', 'lineTotal']) {
          expect(text).not.toContain(forbidden);
        }
      });
    });

    test('A1: nenhum código de produção lê ou grava as colunas novas (apenas migration, schema, motor puro e testes)', () => {
      const names = [
        'pricingVersion', 'pricingSnapshot', 'expectedTotalCents', 'reservationFeeCents', 'pickupMinuteOfDay', 'unitBaseCents',
        'extraDayCents', 'lineTotalCents', 'prepDaysApplied', 'cleaningDaysApplied', 'rentalDays',
        'pricing_version', 'pricing_snapshot', 'expected_total_cents', 'reservation_fee_cents', 'pickup_minute_of_day',
        'unit_base_cents', 'extra_day_cents', 'line_total_cents', 'rental_days', 'prep_days_applied', 'cleaning_days_applied',
      ];
      const srcDir = path.resolve(__dirname, '..');
      const offenders: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
          const full = path.join(dir, entry);
          if (statSync(full).isDirectory()) { walk(full); continue; }
          const rel = path.relative(srcDir, full).split(path.sep).join('/');
          if (!rel.endsWith('.ts') || rel.endsWith('.test.ts') || rel.startsWith('rental-rules/')) continue; // motor puro isolado
          const text = readFileSync(full, 'utf8');
          for (const name of names) if (text.includes(name)) offenders.push(`${rel}: ${name}`);
        }
      };
      walk(srcDir);
      expect(offenders, 'A1 não ativa o recurso: o PR que ativar ajusta este guarda').toEqual([]);
    });

    test('A1: nenhuma linha de reserva ou item existente usa as colunas novas', async () => {
      const [row] = await prisma.$queryRaw<{ n: number }[]>`SELECT (
          (SELECT count(*) FROM reservation_items WHERE pickup_date IS NOT NULL OR unit_base_cents IS NOT NULL OR pickup_minute_of_day IS NOT NULL)
        + (SELECT count(*) FROM reservations WHERE pricing_version IS NOT NULL OR pricing_snapshot IS NOT NULL OR expected_total_cents IS NOT NULL))::int AS n`;
      expect(row.n).toBe(0);
    });
  });

  describe('as 13 constraints existem (NOT VALID é decidido pela migration A2, separada)', () => {
    test('nomes presentes em pg_constraint', async () => {
      const rows = await prisma.$queryRaw<{ conname: string }[]>`SELECT conname FROM pg_constraint WHERE conname LIKE 'ri\\_%' OR conname LIKE 'r\\_pricing%'`;
      expect(rows.map((r) => r.conname).sort()).toEqual([
        'r_pricing_all_or_none', 'r_pricing_amounts', 'r_pricing_snapshot_valid',
        'ri_blocked_range_matches_frozen_rules', 'ri_calculated_return_matches', 'ri_line_total_formula', 'ri_pickup_minute_range',
        'ri_pricing_all_or_none', 'ri_pricing_ceilings', 'ri_pricing_requires_schedule', 'ri_return_not_before_pickup',
        'ri_schedule_all_or_none', 'ri_schedule_ranges',
      ]);
    });
  });
});
