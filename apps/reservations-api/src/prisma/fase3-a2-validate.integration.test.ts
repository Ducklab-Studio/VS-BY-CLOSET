import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaClient, type Prisma } from '@prisma/client';

/**
 * Fase 3 — migration A2 (`VALIDATE CONSTRAINT` das 13 constraints NOT VALID da A1). Integração contra PostgreSQL LOCAL
 * de teste (sem `DATABASE_URL` de loopback com nome de teste o arquivo é pulado).
 *
 * Cada cenário roda num banco DESCARTÁVEL (`a2_*_test_*`) criado e removido pelo próprio teste, clonado de um banco
 * "estado A1" (todas as migrations menos a A2) para permitir exercitar a A2 sobre dados legados, bloqueios e falhas
 * sem tocar no banco compartilhado da suíte. O banco compartilhado só é LIDO (as 13 constraints precisam estar
 * validadas depois de `migrate deploy` do zero).
 */
const baseUrl = process.env.DATABASE_URL ?? '';
const local = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(baseUrl);
const localDescribe = local ? describe : describe.skip;

const apiDir = path.resolve(__dirname, '../..');
const prismaDir = path.join(apiDir, 'prisma');
const prismaCli = path.join(apiDir, 'node_modules/prisma/build/index.js');
const A1 = '20261017120000_fase3_item_schedule_pricing_columns';
const A2 = '20261017130000_fase3_validate_a1_constraints';
const suffix = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const dbNames = { template: `a2_tpl_test_${suffix}`, legacy: `a2_legacy_test_${suffix}`, lock: `a2_lock_test_${suffix}`, dirty: `a2_dirty_test_${suffix}` };
const withDb = (name: string) => { const u = new URL(baseUrl); u.pathname = `/${name}`; return u.toString(); };

const stripComments = (sql: string) => sql.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
const migrationSql = (name: string) => readFileSync(path.join(prismaDir, 'migrations', name, 'migration.sql'), 'utf8');
const names = (sql: string, re: RegExp) => [...stripComments(sql).matchAll(re)].map((m) => m[1]).sort();

let tmpA1State = ''; // cópia de prisma/ SEM a A2: "estado A1"
let admin: PrismaClient;
const clients: PrismaClient[] = [];
const open = (db: string) => { const c = new PrismaClient({ datasourceUrl: withDb(db), log: [] }); clients.push(c); return c; };

function migrate(schemaDir: string, db: string, args: string[] = ['deploy']) {
  const result = spawnSync(process.execPath, [prismaCli, 'migrate', ...args, '--schema', path.join(schemaDir, 'schema.prisma')], {
    cwd: apiDir, encoding: 'utf8', env: { ...process.env, DATABASE_URL: withDb(db), CHECKPOINT_DISABLE: '1' },
  });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}
const deployFull = (db: string) => migrate(prismaDir, db);
const deployA1State = (db: string) => migrate(tmpA1State, db);
const resolveRolledBack = (db: string) => migrate(prismaDir, db, ['resolve', '--rolled-back', A2]);

async function clone(from: string, to: string) {
  await admin.$executeRawUnsafe(`CREATE DATABASE "${to}" TEMPLATE "${from}"`);
}
const validatedCount = async (c: PrismaClient) => {
  const [r] = await c.$queryRawUnsafe<{ validated: number; not_valid: number }[]>(
    "SELECT count(*) FILTER (WHERE convalidated)::int AS validated, count(*) FILTER (WHERE NOT convalidated)::int AS not_valid FROM pg_constraint WHERE conname LIKE 'ri\\_%' OR conname LIKE 'r\\_pricing%'");
  return r;
};
const a2Row = async (c: PrismaClient) => (await c.$queryRawUnsafe<{ finished: boolean; rolled_back: boolean }[]>(
  `SELECT finished_at IS NOT NULL AS finished, rolled_back_at IS NOT NULL AS rolled_back FROM _prisma_migrations WHERE migration_name = '${A2}' ORDER BY started_at DESC`));

/** Dados legados realistas (statements exatos do HOLD e da reserva manual), em vários status. */
async function insertLegacy(c: PrismaClient) {
  await c.$executeRawUnsafe("INSERT INTO stores (id, shopify_domain, currency) VALUES ('a2-store', 'a2-store.invalid', 'BRL')");
  const statuses = ['hold', 'pending_payment', 'confirmed', 'picked_up', 'returned', 'cleaning', 'completed', 'cancelled', 'expired'];
  for (const [i, status] of statuses.entries()) {
    const code = `A2-UNIT-${i}`;
    const [unit] = await c.$queryRawUnsafe<{ id: string }[]>(`INSERT INTO rental_units (code, name, shopify_variant_id) VALUES ('${code}', 'peça A2', '${code}') RETURNING id`);
    const manual = i % 3 === 0;
    const [res] = await c.$queryRawUnsafe<{ id: string }[]>(manual
      ? `INSERT INTO reservations (id, status, source, origin_store_id, pickup_date, return_date, customer_name, customer_phone, confirmed_at)
         VALUES (gen_random_uuid(), '${status}', 'manual_admin', 'a2-store', DATE '2027-0${(i % 9) + 1}-10', DATE '2027-0${(i % 9) + 1}-12', 'Cliente Teste', '000', now()) RETURNING id`
      : `INSERT INTO reservations (id, status, origin_store_id, pickup_date, return_date, calculated_return_date, rental_duration_days, expires_at, terms_accepted_at, terms_version, hold_token_hash)
         VALUES (gen_random_uuid(), '${status}', 'a2-store', DATE '2027-0${(i % 9) + 1}-10', DATE '2027-0${(i % 9) + 1}-12', DATE '2027-0${(i % 9) + 1}-12', 2, now() + interval '30 minutes', now(), 'v1', 'h${i}') RETURNING id`);
    await c.$executeRawUnsafe(`INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
      VALUES (gen_random_uuid(), '${res.id}', '${unit.id}', '${status}', daterange(DATE '2027-0${(i % 9) + 1}-05', DATE '2027-0${(i % 9) + 1}-17', '[)'))`);
  }
}
const fingerprint = async (c: PrismaClient) => (await c.$queryRawUnsafe<{ rows: string; xmins: string; n: number }[]>(`
  SELECT (SELECT md5(string_agg(r::text, '|' ORDER BY r.id)) FROM reservations r) || (SELECT md5(string_agg(i::text, '|' ORDER BY i.id)) FROM reservation_items i) AS rows,
         (SELECT md5(string_agg(id::text || ':' || xmin::text, '|' ORDER BY id)) FROM reservations) || (SELECT md5(string_agg(id::text || ':' || xmin::text, '|' ORDER BY id)) FROM reservation_items) AS xmins,
         ((SELECT count(*) FROM reservations) + (SELECT count(*) FROM reservation_items))::int AS n`))[0];

class Rollback extends Error {}

localDescribe('Fase 3 — migration A2 (VALIDATE) em bancos descartáveis', () => {
  beforeAll(async () => {
    admin = new PrismaClient({ datasourceUrl: withDb('postgres'), log: [] });
    // cópia de prisma/ sem a A2 = estado em que a produção estava depois da A1
    tmpA1State = mkdtempSync(path.join(tmpdir(), 'a2-state-a1-'));
    cpSync(prismaDir, tmpA1State, { recursive: true });
    rmSync(path.join(tmpA1State, 'migrations', A2), { recursive: true, force: true });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbNames.template}"`);
    const r = deployA1State(dbNames.template);
    if (r.status !== 0) throw new Error(`deploy do estado A1 falhou:\n${r.out}`.slice(0, 800));
    // todos os clones saem do mesmo estado A1 (o template não pode ter conexões abertas)
    await clone(dbNames.template, dbNames.legacy);
    await clone(dbNames.template, dbNames.lock);
    await clone(dbNames.template, dbNames.dirty);
  }, 240_000);

  afterAll(async () => {
    await Promise.allSettled(clients.map((c) => c.$disconnect()));
    for (const db of Object.values(dbNames)) await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => undefined);
    await admin?.$disconnect();
    if (tmpA1State) rmSync(tmpA1State, { recursive: true, force: true });
  }, 60_000);

  describe('conteúdo da migration', () => {
    test('valida EXATAMENTE as 13 constraints que a A1 criou (nem a mais, nem a menos)', () => {
      const created = names(migrationSql(A1), /ADD CONSTRAINT "([a-z_]+)"/g);
      const validated = names(migrationSql(A2), /VALIDATE CONSTRAINT "([a-z_]+)"/g);
      expect(created).toHaveLength(13);
      expect(validated).toEqual(created);
    });

    test('só valida: nenhuma operação de dados nem de estrutura', () => {
      const sql = stripComments(migrationSql(A2));
      const statements = sql.split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
      expect(statements.filter((s) => !/^(SET lock_timeout = '5s'|RESET lock_timeout)$/.test(s) && !/^ALTER TABLE "(reservation_items|reservations)" (VALIDATE CONSTRAINT "[a-z_]+"(, )?)+$/.test(s))).toEqual([]);
      expect(sql).not.toMatch(/\b(ADD|DROP|CREATE|UPDATE|DELETE|INSERT|TRUNCATE|RENAME|ALTER COLUMN|NOT VALID)\b/i);
    });

    test('é a migration mais recente e vem depois da A1', () => {
      const all = readdirSync(path.join(prismaDir, 'migrations')).filter((n) => /^\d{14}_/.test(n)).sort();
      expect(all.indexOf(A2)).toBeGreaterThan(all.indexOf(A1));
      expect(all[all.length - 1] >= A2).toBe(true);
    });
  });

  describe('banco compartilhado da suíte (migrado do zero, só leitura)', () => {
    test('depois de migrate deploy, as 13 constraints estão VALIDADAS', async () => {
      const shared = new PrismaClient({ log: [] });
      try {
        expect(await validatedCount(shared)).toEqual({ validated: 13, not_valid: 0 });
      } finally {
        await shared.$disconnect();
      }
    });
  });

  describe('dados legados preservados', () => {
    test('A2 sobre um banco com reservas legadas: todas validam, e NENHUMA linha é reescrita (xmin/ctid iguais)', async () => {
      const c = open(dbNames.legacy);
      expect(await validatedCount(c)).toEqual({ validated: 0, not_valid: 13 }); // estado A1
      await insertLegacy(c);
      const before = await fingerprint(c);
      expect(before.n).toBe(18);

      const r = deployFull(dbNames.legacy);
      expect(r.status, r.out).toBe(0);
      expect(r.out).toMatch(new RegExp(A2));

      expect(await validatedCount(c)).toEqual({ validated: 13, not_valid: 0 });
      expect(await fingerprint(c)).toEqual(before); // conteúdo E versões de linha (xmin) idênticos: nada foi reescrito
      expect(await a2Row(c)).toEqual([{ finished: true, rolled_back: false }]);
      // as proteções originais continuam
      const [p] = await c.$queryRawUnsafe<{ ex: number; tg: number }[]>("SELECT (SELECT count(*) FROM pg_constraint WHERE conname='reservation_items_no_overlap_per_unit')::int AS ex, (SELECT count(*) FROM pg_trigger WHERE tgname='reservation_status_sync')::int AS tg");
      expect(p).toEqual({ ex: 1, tg: 1 });
    }, 180_000);

    test('depois da A2 as constraints continuam rejeitando dado novo inválido e aceitando legado', async () => {
      const c = open(dbNames.legacy);
      await c.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("INSERT INTO rental_units (code, name, shopify_variant_id) VALUES ('A2-POST', 'peça', 'A2-POST')");
        const [u] = await tx.$queryRawUnsafe<{ id: string }[]>("SELECT id FROM rental_units WHERE code='A2-POST'");
        const [r] = await tx.$queryRawUnsafe<{ id: string }[]>("INSERT INTO reservations (id, status, origin_store_id) VALUES (gen_random_uuid(), 'hold', 'a2-store') RETURNING id");
        // legado (colunas novas nulas): aceito
        await tx.$executeRawUnsafe(`INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range) VALUES ('${r.id}', '${u.id}', 'hold', daterange(DATE '2028-01-05', DATE '2028-01-17', '[)'))`);
        await expect(tx.$executeRawUnsafe(`INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range, rental_days) VALUES ('${r.id}', '${u.id}', 'hold', daterange(DATE '2029-01-05', DATE '2029-01-17', '[)'), 3)`)).rejects.toThrow();
        throw new Rollback();
      }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
    });
  });

  describe('locks e concorrência', () => {
    const modes = async (tx: Pick<Prisma.TransactionClient, '$queryRawUnsafe'>) => (await tx.$queryRawUnsafe<{ relname: string; mode: string }[]>(
      "SELECT c.relname, l.mode FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE l.pid = pg_backend_pid() AND c.relname IN ('reservations','reservation_items') ORDER BY 1, 2")).filter((r) => /^(ShareUpdateExclusive|Share|ShareRowExclusive|Exclusive|AccessExclusive)Lock$/.test(r.mode));

    test('A2 pede só SHARE UPDATE EXCLUSIVE: leitura, INSERT, UPDATE (com gatilho) e DELETE não esperam; DDL concorrente espera', async () => {
      const x = open(dbNames.lock);
      const y = open(dbNames.lock);
      const validateSql = stripComments(migrationSql(A2)).split(';').map((s) => s.trim()).filter((s) => s.startsWith('ALTER TABLE'));
      let held: { relname: string; mode: string }[] = [];
      let dmlMs = 0;
      let ddlBlockedWith = '';

      await x.$transaction(async (tx) => {
        for (const sql of validateSql) await tx.$executeRawUnsafe(sql);
        held = await modes(tx);

        const t0 = Date.now();
        await y.$transaction(async (ty) => {
          await ty.$executeRawUnsafe("SET LOCAL lock_timeout = '1500ms'");
          await ty.$executeRawUnsafe("INSERT INTO stores (id, shopify_domain, currency) VALUES ('a2-lock', 'a2-lock.invalid', 'BRL')");
          await ty.$executeRawUnsafe("INSERT INTO rental_units (code, name, shopify_variant_id) VALUES ('A2-LOCK', 'peça', 'A2-LOCK')");
          const [u] = await ty.$queryRawUnsafe<{ id: string }[]>("SELECT id FROM rental_units WHERE code='A2-LOCK'");
          const [r] = await ty.$queryRawUnsafe<{ id: string }[]>("INSERT INTO reservations (id, status, origin_store_id) VALUES (gen_random_uuid(), 'hold', 'a2-lock') RETURNING id");
          await ty.$executeRawUnsafe(`INSERT INTO reservation_items (reservation_id, rental_unit_id, status, blocked_range) VALUES ('${r.id}', '${u.id}', 'hold', daterange(DATE '2027-05-05', DATE '2027-05-17', '[)'))`);
          await ty.$executeRawUnsafe(`UPDATE reservations SET status = 'confirmed' WHERE id = '${r.id}'`); // dispara o gatilho de status
          await ty.$queryRawUnsafe('SELECT count(*) FROM reservations');
          await ty.$queryRawUnsafe('SELECT count(*) FROM reservation_items');
          await ty.$executeRawUnsafe(`DELETE FROM reservation_items WHERE reservation_id = '${r.id}'`);
          throw new Rollback();
        }, { timeout: 20_000 }).catch((e) => { if (!(e instanceof Rollback)) throw e; });
        dmlMs = Date.now() - t0;

        // controle positivo: o lock existe de fato — um DDL concorrente (ACCESS EXCLUSIVE) fica esperando e estoura o lock_timeout
        await y.$transaction(async (ty) => {
          await ty.$executeRawUnsafe("SET LOCAL lock_timeout = '800ms'");
          try { await ty.$executeRawUnsafe('ALTER TABLE reservation_items ADD COLUMN zz_probe integer'); } catch (e) { ddlBlockedWith = String((e as { meta?: { message?: string } }).meta?.message ?? e); }
          throw new Rollback();
        }, { timeout: 20_000 }).catch((e) => { if (!(e instanceof Rollback)) throw e; });

        throw new Rollback(); // não deixa a validação valer: o teste de falha abaixo parte do estado A1
      }, { timeout: 60_000 }).catch((e) => { if (!(e instanceof Rollback)) throw e; });

      expect(held.map((r) => `${r.relname}:${r.mode}`)).toEqual(['reservation_items:ShareUpdateExclusiveLock', 'reservations:ShareUpdateExclusiveLock']);
      expect(dmlMs, 'DML concorrente não pode esperar a validação').toBeLessThan(3000);
      expect(ddlBlockedWith).toMatch(/lock timeout/);
      expect(await validatedCount(x)).toEqual({ validated: 0, not_valid: 13 });
    }, 120_000);

    test('lock conflitante (SHARE) estoura o lock_timeout: lote atômico, P3009 e recuperação com resolve --rolled-back', async () => {
      const c = open(dbNames.lock);
      const blocker = open(dbNames.lock);
      let first!: ReturnType<typeof deployFull>;

      await blocker.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('LOCK TABLE reservation_items IN SHARE MODE'); // conflita com SHARE UPDATE EXCLUSIVE
        first = deployFull(dbNames.lock);
        throw new Rollback();
      }, { timeout: 90_000 }).catch((e) => { if (!(e instanceof Rollback)) throw e; });

      expect(first.status).toBe(1);
      expect(first.out).toMatch(/lock timeout/);
      expect(await validatedCount(c)).toEqual({ validated: 0, not_valid: 13 }); // nada foi validado pela metade
      expect(await a2Row(c)).toEqual([{ finished: false, rolled_back: false }]); // registrada como falha

      // com o bloqueio liberado, um novo deploy AINDA recusa: P3009
      const second = deployFull(dbNames.lock);
      expect(second.status).toBe(1);
      expect(second.out).toMatch(/P3009/);

      const resolved = resolveRolledBack(dbNames.lock);
      expect(resolved.status, resolved.out).toBe(0);
      const third = deployFull(dbNames.lock);
      expect(third.status, third.out).toBe(0);
      expect(await validatedCount(c)).toEqual({ validated: 13, not_valid: 0 });
    }, 240_000);
  });

  describe('falha por dado inválido', () => {
    test('uma linha que viola um CHECK derruba a A2 INTEIRA (nenhuma constraint é validada), e a recuperação funciona', async () => {
      const c = open(dbNames.dirty);
      // simula dado sujo legado: a constraint é recriada NOT VALID depois de a linha inválida já existir
      await c.$executeRawUnsafe("INSERT INTO stores (id, shopify_domain, currency) VALUES ('a2-dirty', 'a2-dirty.invalid', 'BRL')");
      await c.$executeRawUnsafe('ALTER TABLE reservation_items DROP CONSTRAINT ri_schedule_ranges');
      await c.$executeRawUnsafe("INSERT INTO rental_units (code, name, shopify_variant_id) VALUES ('A2-DIRTY', 'peça', 'A2-DIRTY')");
      await c.$executeRawUnsafe("INSERT INTO reservations (id, status, origin_store_id) VALUES ('11111111-1111-4111-8111-111111111111', 'hold', 'a2-dirty')");
      await c.$executeRawUnsafe(`INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range, pickup_date, rental_days, calculated_return_date, return_date, prep_days_applied, cleaning_days_applied)
        VALUES ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', (SELECT id FROM rental_units WHERE code='A2-DIRTY'), 'hold', daterange(DATE '2026-12-05', DATE '2026-12-15', '[)'),
                DATE '2026-12-10', 0, DATE '2026-12-10', DATE '2026-12-10', 5, 4)`); // rental_days = 0 (viola ri_schedule_ranges)
      await c.$executeRawUnsafe(`ALTER TABLE reservation_items ADD CONSTRAINT ri_schedule_ranges CHECK (
        (rental_days IS NULL OR rental_days BETWEEN 1 AND 3650) AND (prep_days_applied IS NULL OR prep_days_applied BETWEEN 0 AND 365)
        AND (cleaning_days_applied IS NULL OR cleaning_days_applied BETWEEN 0 AND 365)) NOT VALID`);
      const before = await fingerprint(c);

      const failed = deployFull(dbNames.dirty);
      expect(failed.status).toBe(1);
      expect(failed.out).toMatch(/ri_schedule_ranges/);
      expect(failed.out).toMatch(/violated by some row/);
      // ATOMICIDADE: nem as constraints validadas ANTES da que falhou (na mesma instrução) ficaram validadas
      expect(await validatedCount(c)).toEqual({ validated: 0, not_valid: 13 });
      expect(await fingerprint(c)).toEqual(before); // dados intactos
      expect(await a2Row(c)).toEqual([{ finished: false, rolled_back: false }]);

      expect(deployFull(dbNames.dirty).out).toMatch(/P3009/);

      // recuperação: corrige o dado (aqui, remove a linha de teste), marca como revertida e reaplica
      await c.$executeRawUnsafe("DELETE FROM reservation_items WHERE id = '22222222-2222-4222-8222-222222222222'");
      expect(resolveRolledBack(dbNames.dirty).status).toBe(0);
      const ok = deployFull(dbNames.dirty);
      expect(ok.status, ok.out).toBe(0);
      expect(await validatedCount(c)).toEqual({ validated: 13, not_valid: 0 });
    }, 240_000);
  });
});
