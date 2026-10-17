import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

/**
 * Testes de MUTAÇÃO do verificador de drift, ponta a ponta, em um banco DESCARTÁVEL criado só para este arquivo:
 * cria `drift_e2e_test_*` no mesmo servidor LOCAL de teste, aplica as migrations reais, muda deliberadamente FKs,
 * índices e DEFAULTs, confirma que o verificador reprova, reverte cada mutação e confirma que volta a passar. O banco
 * é removido no fim (mesmo se algo falhar). Sem `DATABASE_URL` local de teste o arquivo é pulado; nunca toca no banco
 * compartilhado da suíte nem em qualquer banco remoto.
 */
const baseUrl = process.env.DATABASE_URL ?? '';
const local = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(baseUrl);
const localDescribe = local ? describe : describe.skip;

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '..');
const cli = path.join(here, 'check-schema-drift.mjs');
const prismaCli = local ? require.resolve('prisma/build/index.js') : '';
const { PrismaClient } = local ? require('@prisma/client') : { PrismaClient: null };

const dbName = `drift_e2e_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const withDb = (name) => { const u = new URL(baseUrl); u.pathname = `/${name}`; return u.toString(); };
const url = local ? withDb(dbName) : '';
let admin;
let db;

const run = (args = [], env = {}) => {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: apiDir, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url, ...env } });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}`, stdout: r.stdout };
};
const full = () => run();
const catalogOnly = () => run(['--catalog-only']);
const statements = () => JSON.parse(run(['--print-statements']).stdout);
const ddl = async (...sqls) => { for (const sql of sqls) await db.$executeRawUnsafe(sql); };

/** Aplica a mutação, exige que o verificador reprove (com a mensagem esperada), reverte e exige que volte a passar. */
async function mutate({ name, apply, revert, expect: expected, runner = catalogOnly, back = catalogOnly }) {
  await ddl(...[].concat(apply));
  const broken = runner();
  expect(broken.code, `${name}: deveria reprovar\n${broken.out}`).toBe(1);
  for (const pattern of [].concat(expected)) expect(broken.out, `${name}: mensagem`).toMatch(pattern);
  await ddl(...[].concat(revert));
  const fixed = back();
  expect(fixed.code, `${name}: deveria voltar a passar após reverter\n${fixed.out}`).toBe(0);
}

localDescribe('verificador de drift — mutações em banco descartável', () => {
  beforeAll(async () => {
    admin = new PrismaClient({ datasourceUrl: withDb('postgres'), log: [] });
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    const migrated = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], { cwd: apiDir, encoding: 'utf8', env: { ...process.env, DATABASE_URL: url, CHECKPOINT_DISABLE: '1' } });
    if (migrated.status !== 0) throw new Error(`migrate deploy falhou no banco descartável:\n${migrated.stdout}\n${migrated.stderr}`.slice(0, 600));
    db = new PrismaClient({ datasourceUrl: url, log: [] });
  }, 180_000);

  afterAll(async () => {
    await db?.$disconnect();
    try { await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`); } finally { await admin?.$disconnect(); }
  }, 60_000);

  test('linha de base: o banco migrado passa na verificação completa (diff do Prisma + catálogo)', () => {
    const r = full();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/sem divergência/);
  }, 120_000);

  test('FK LEGADA NO ACTION → ON DELETE CASCADE: o diff do Prisma NÃO muda, o catálogo pega', async () => {
    const fk = 'reservation_items_rental_unit_id_fkey';
    const before = statements();
    await ddl(`ALTER TABLE reservation_items DROP CONSTRAINT ${fk}`, `ALTER TABLE reservation_items ADD CONSTRAINT ${fk} FOREIGN KEY (rental_unit_id) REFERENCES rental_units(id) ON DELETE CASCADE`);
    expect(statements(), 'o Prisma é cego a esta mudança').toEqual(before);
    await ddl(`ALTER TABLE reservation_items DROP CONSTRAINT ${fk}`, `ALTER TABLE reservation_items ADD CONSTRAINT ${fk} FOREIGN KEY (rental_unit_id) REFERENCES rental_units(id)`);
    await mutate({
      name: 'FK legada → CASCADE',
      apply: [`ALTER TABLE reservation_items DROP CONSTRAINT ${fk}`, `ALTER TABLE reservation_items ADD CONSTRAINT ${fk} FOREIGN KEY (rental_unit_id) REFERENCES rental_units(id) ON DELETE CASCADE`],
      revert: [`ALTER TABLE reservation_items DROP CONSTRAINT ${fk}`, `ALTER TABLE reservation_items ADD CONSTRAINT ${fk} FOREIGN KEY (rental_unit_id) REFERENCES rental_units(id)`],
      expect: [/chave estrangeira reservation_items\.reservation_items_rental_unit_id_fkey MUDOU em "onDelete"/, /"NO ACTION"/, /"CASCADE"/],
      runner: full, back: full,
    });
  }, 180_000);

  test('FK LEGADA: ON UPDATE e coluna referenciada', async () => {
    const fk = 'reservation_items_reservation_id_fkey';
    const original = 'FOREIGN KEY (reservation_id) REFERENCES reservations(id)';
    const re = (def) => [`ALTER TABLE reservation_items DROP CONSTRAINT ${fk}`, `ALTER TABLE reservation_items ADD CONSTRAINT ${fk} ${def}`];
    await mutate({ name: 'FK legada ON UPDATE CASCADE', apply: re(`${original} ON UPDATE CASCADE`), revert: re(original), expect: /MUDOU em "onUpdate"/ });
    await mutate({ name: 'FK legada deferrable', apply: re(`${original} DEFERRABLE INITIALLY DEFERRED`), revert: re(original), expect: [/"deferrable"/, /"initiallyDeferred"/] });
  }, 120_000);

  test('FK ALINHADA ao schema: ação alterada e FK removida (reprova nas duas camadas)', async () => {
    const fk = 'reservation_item_returns_reservation_item_id_fkey';
    const original = 'FOREIGN KEY (reservation_item_id) REFERENCES reservation_items(id) ON DELETE RESTRICT ON UPDATE CASCADE';
    await mutate({
      name: 'FK alinhada → CASCADE',
      apply: [`ALTER TABLE reservation_item_returns DROP CONSTRAINT ${fk}`, `ALTER TABLE reservation_item_returns ADD CONSTRAINT ${fk} FOREIGN KEY (reservation_item_id) REFERENCES reservation_items(id) ON DELETE CASCADE ON UPDATE CASCADE`],
      revert: [`ALTER TABLE reservation_item_returns DROP CONSTRAINT ${fk}`, `ALTER TABLE reservation_item_returns ADD CONSTRAINT ${fk} ${original}`],
      expect: [/MUDOU em "onDelete"/], runner: full, back: full,
    });
    await mutate({
      name: 'FK alinhada removida',
      apply: `ALTER TABLE reservation_item_returns DROP CONSTRAINT ${fk}`,
      revert: `ALTER TABLE reservation_item_returns ADD CONSTRAINT ${fk} ${original}`,
      expect: [/SUMIU do banco/, /NOVA divergência do Prisma/], runner: full, back: full,
    });
  }, 180_000);

  test('índice: unicidade, ordem das colunas, condição (WHERE) e índice extra — o Prisma não vê a condição', async () => {
    await mutate({
      name: 'único → comum',
      apply: ['DROP INDEX reservations_shopify_cart_id_key', 'CREATE INDEX reservations_shopify_cart_id_key ON reservations (shopify_cart_id)'],
      revert: ['DROP INDEX reservations_shopify_cart_id_key', 'CREATE UNIQUE INDEX reservations_shopify_cart_id_key ON reservations (shopify_cart_id)'],
      expect: /índice reservations\.reservations_shopify_cart_id_key MUDOU em "unique"/,
    });
    await mutate({
      name: 'ordem das colunas (índice legado)',
      apply: ['DROP INDEX reservations_sku_status_idx', 'CREATE INDEX reservations_sku_status_idx ON reservations (status, sku)'],
      revert: ['DROP INDEX reservations_sku_status_idx', 'CREATE INDEX reservations_sku_status_idx ON reservations (sku, status)'],
      expect: /MUDOU em "columns"/,
    });
    // índice declarado no schema (reservation_items_reservation_id_idx) vira PARCIAL: o Prisma ignora o WHERE
    await mutate({
      name: 'condição parcial adicionada',
      apply: ['DROP INDEX reservation_items_reservation_id_idx', "CREATE INDEX reservation_items_reservation_id_idx ON reservation_items (reservation_id) WHERE status = 'hold'"],
      revert: ['DROP INDEX reservation_items_reservation_id_idx', 'CREATE INDEX reservation_items_reservation_id_idx ON reservation_items (reservation_id)'],
      expect: /MUDOU em "predicate"/,
    });
    await mutate({
      name: 'índice extra',
      apply: 'CREATE INDEX zz_probe_idx ON reservation_items (status)',
      revert: 'DROP INDEX zz_probe_idx',
      expect: [/índice NOVO\(A\) no banco e fora do retrato: reservation_items\.zz_probe_idx/, /NOVA divergência do Prisma/], runner: full, back: full,
    });
    await mutate({
      name: 'índice do schema removido',
      apply: 'DROP INDEX reservation_items_reservation_id_idx',
      revert: 'CREATE INDEX reservation_items_reservation_id_idx ON reservation_items (reservation_id)',
      expect: /SUMIU do banco/,
    });
  }, 240_000);

  test('DEFAULT: alterado, removido (alinhada e legada) e novo', async () => {
    await mutate({
      name: 'default alterado',
      apply: "ALTER TABLE reservation_items ALTER COLUMN created_at SET DEFAULT (now() + interval '1 day')",
      revert: 'ALTER TABLE reservation_items ALTER COLUMN created_at SET DEFAULT now()',
      expect: /DEFAULT reservation_items\.created_at MUDOU em "default"/,
    });
    await mutate({
      name: 'default removido (coluna alinhada)',
      apply: 'ALTER TABLE reservation_items ALTER COLUMN created_at DROP DEFAULT',
      revert: 'ALTER TABLE reservation_items ALTER COLUMN created_at SET DEFAULT now()',
      expect: [/SUMIU do banco/, /NOVA divergência do Prisma/], runner: full, back: full,
    });
    await mutate({
      name: 'default legado removido (corrige a divergência: entrada obsoleta)',
      apply: 'ALTER TABLE reservations ALTER COLUMN updated_at DROP DEFAULT',
      revert: 'ALTER TABLE reservations ALTER COLUMN updated_at SET DEFAULT now()',
      expect: [/OBSOLETA/, /SUMIU do banco/], runner: full, back: full,
    });
    await mutate({
      name: 'default novo em coluna sem default',
      apply: "ALTER TABLE reservations ALTER COLUMN customer_email SET DEFAULT 'x@y.z'",
      revert: 'ALTER TABLE reservations ALTER COLUMN customer_email DROP DEFAULT',
      expect: /DEFAULT NOVO\(A\) no banco e fora do retrato: reservations\.customer_email/,
    });
  }, 240_000);

  test('formatação irrelevante NÃO reprova: mesma FK/índice/default recriados com outra grafia SQL', async () => {
    await ddl(
      'ALTER TABLE reservation_items DROP CONSTRAINT reservation_items_rental_unit_id_fkey',
      'alter  table   reservation_items   add  constraint reservation_items_rental_unit_id_fkey  foreign key ( rental_unit_id )   references   rental_units ( id )  on delete no action  on update no action  not deferrable',
      'DROP INDEX reservations_sku_status_idx',
      'create   index   reservations_sku_status_idx   on   public.reservations   using   btree  ( sku ,  status )',
      'ALTER TABLE reservations ALTER COLUMN updated_at SET DEFAULT NOW  ( )',
    );
    const r = full();
    expect(r.code, r.out).toBe(0);
  }, 120_000);

  test('ESTRUTURAL e lista obsoleta: coluna nova, nulidade e índice legado removido', async () => {
    await mutate({ name: 'coluna nova só no banco', apply: 'ALTER TABLE reservation_items ADD COLUMN zz_probe integer', revert: 'ALTER TABLE reservation_items DROP COLUMN zz_probe', expect: /ESTRUTURAL/, runner: full, back: full });
    await mutate({ name: 'nulidade', apply: 'ALTER TABLE reservation_items ALTER COLUMN rental_days SET NOT NULL', revert: 'ALTER TABLE reservation_items ALTER COLUMN rental_days DROP NOT NULL', expect: /ESTRUTURAL/, runner: full, back: full });
    await mutate({
      name: 'índice legado corrigido (entrada obsoleta)',
      apply: 'DROP INDEX hold_idempotency_keys_reservation_id_idx',
      revert: 'CREATE INDEX hold_idempotency_keys_reservation_id_idx ON hold_idempotency_keys (reservation_id)',
      expect: [/OBSOLETA/, /SUMIU do banco/], runner: full, back: full,
    });
  }, 240_000);

  test('proteções de acesso: banco remoto ou sem nome de teste aborta (exit 2) sem tentar conectar', () => {
    for (const bad of ['postgresql://u:p@db.example.com:5432/prod_test', 'postgresql://u:p@localhost:5432/neondb', 'postgresql://u:p@ep-x-pooler.neon.tech/neondb', '']) {
      const r = run(['--catalog-only'], { DATABASE_URL: bad });
      expect(r.code, bad).toBe(2);
      expect(r.out).toMatch(/PostgreSQL local de teste/);
    }
    expect(run(['--opcao-inexistente']).code).toBe(2);
  }, 60_000);

  test('depois de todas as mutações e reversões o banco volta a passar na verificação completa', () => {
    const r = full();
    expect(r.code, r.out).toBe(0);
  }, 120_000);
});
