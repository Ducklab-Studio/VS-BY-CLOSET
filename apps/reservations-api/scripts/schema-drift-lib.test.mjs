import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  buildCatalog,
  compareStatements,
  diffCatalog,
  evaluate,
  isStructural,
  normalizeExpr,
  normalizeStatement,
  parseDiffScript,
  validateBaseline,
} from './schema-drift-lib.mjs';

/** Testes PUROS do verificador (sem banco). As instruções de exemplo têm o formato REAL emitido pelo Prisma 5.22. */
const read = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
const baseline = read('schema-drift.baseline.json');
const { generatedOnPostgresMajor: _major, ...snapshot } = read('schema-catalog.snapshot.json');
const clone = (value) => JSON.parse(JSON.stringify(value));
const currentStatements = baseline.statements.map((entry) => normalizeStatement(entry.sql));
const scriptOf = (statements) => statements.map((s) => `-- Comentário\n${s};\n`).join('\n');

describe('lista de divergências legadas (arquivo real)', () => {
  test('é válida: toda entrada tem justificativa, nenhuma é estrutural, sem duplicatas', () => {
    expect(validateBaseline(baseline)).toEqual([]);
    expect(baseline.statements).toHaveLength(33);
    for (const entry of baseline.statements) expect(entry.reason.length).toBeGreaterThan(40);
  });

  test('rejeita lista malformada, sem justificativa, duplicada ou com divergência ESTRUTURAL', () => {
    expect(validateBaseline(undefined)).not.toEqual([]);
    expect(validateBaseline({})).not.toEqual([]);
    expect(validateBaseline({ statements: [{ sql: 'DROP INDEX "x"', reason: 'curta' }] }).join()).toMatch(/justificativa/);
    expect(validateBaseline({ statements: [{ sql: '', reason: 'x'.repeat(30) }] }).join()).toMatch(/sem `sql`/);
    const dup = { sql: 'DROP INDEX "x"', reason: 'justificativa longa o bastante para valer' };
    expect(validateBaseline({ statements: [dup, dup] }).join()).toMatch(/duplicada/);
    for (const structural of [
      'ALTER TABLE "t" ADD COLUMN "c" INTEGER',
      'ALTER TABLE "t" DROP COLUMN "c"',
      'ALTER TABLE "t" ALTER COLUMN "c" SET NOT NULL',
      'ALTER TABLE "t" ALTER COLUMN "c" DROP NOT NULL',
      'ALTER TABLE "t" ALTER COLUMN "c" SET DATA TYPE BIGINT',
      'CREATE TABLE "t" ("id" INTEGER)',
      'DROP TABLE "t"',
      'CREATE TYPE "e" AS ENUM (\'a\')',
    ]) {
      expect(validateBaseline({ statements: [{ sql: structural, reason: 'justificativa longa o bastante para valer' }] }).join(), structural).toMatch(/ESTRUTURAL/);
    }
  });
});

describe('camada 1 — diff do Prisma × lista', () => {
  test('parseDiffScript: ignora comentários, espaços e o ";" final', () => {
    const script = '-- DropIndex\nDROP INDEX   "a";\n\n-- AlterTable\nALTER TABLE "t"\n  ALTER COLUMN "c" DROP DEFAULT;\n';
    expect(parseDiffScript(script)).toEqual(['DROP INDEX "a"', 'ALTER TABLE "t" ALTER COLUMN "c" DROP DEFAULT']);
    expect(parseDiffScript('')).toEqual([]);
  });

  test('o diff atual (= a lista) passa, em qualquer ordem e com qualquer formatação de espaços', () => {
    expect(evaluate({ script: scriptOf(currentStatements), baseline }).ok).toBe(true);
    const shuffled = [...currentStatements].reverse().map((s) => s.replace(/ /g, '  '));
    expect(evaluate({ script: scriptOf(shuffled), baseline }).ok).toBe(true);
  });

  // Formatos reais capturados do Prisma 5.22 ao mutar um banco migrado.
  const novas = [
    ['índice extra no banco', 'DROP INDEX "zz_probe_idx"', /NOVA divergência/],
    ['chave estrangeira alinhada ao schema removida do banco', 'ALTER TABLE "reservation_item_returns" ADD CONSTRAINT "reservation_item_returns_reservation_item_id_fkey" FOREIGN KEY ("reservation_item_id") REFERENCES "reservation_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE', /NOVA divergência/],
    ['DEFAULT removido de coluna alinhada', 'ALTER TABLE "reservation_items" ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP', /NOVA divergência/],
    ['DEFAULT de updated_at em OUTRA tabela', 'ALTER TABLE "vale_passes" ALTER COLUMN "updated_at" DROP DEFAULT', /NOVA divergência/],
    ['índice declarado no schema e ausente no banco', 'CREATE INDEX "reservation_items_status_idx" ON "reservation_items"("status")', /NOVA divergência/],
    ['índice único declarado e ausente', 'CREATE UNIQUE INDEX "x_key" ON "x"("a")', /NOVA divergência/],
    ['coluna nova só no banco', 'ALTER TABLE "reservation_items" DROP COLUMN "zz_probe"', /ESTRUTURAL/],
    ['campo novo só no schema', 'ALTER TABLE "reservations" ADD COLUMN "zz_novo" INTEGER', /ESTRUTURAL/],
    ['nulidade', 'ALTER TABLE "reservation_items" ALTER COLUMN "rental_days" DROP NOT NULL', /ESTRUTURAL/],
    ['tabela nova no schema', 'CREATE TABLE "zz" ("id" INTEGER NOT NULL)', /ESTRUTURAL/],
  ];
  test.each(novas)('reprova diferença nova: %s', (_name, statement, expected) => {
    const verdict = evaluate({ script: scriptOf([...currentStatements, statement]), baseline });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(expected);
  });

  test('instrução COMBINADA (legada + nova) não passa pela lista: o texto inteiro precisa ser igual', () => {
    const combined = 'ALTER TABLE "reservations" ALTER COLUMN "status" DROP DEFAULT, ALTER COLUMN "updated_at" DROP DEFAULT';
    const withoutLegacy = currentStatements.filter((s) => s !== 'ALTER TABLE "reservations" ALTER COLUMN "updated_at" DROP DEFAULT');
    const verdict = evaluate({ script: scriptOf([...withoutLegacy, combined]), baseline });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/NOVA divergência/);
    expect(verdict.problems.join('\n')).toMatch(/OBSOLETA/);
    // e a combinação com uma estrutural é estrutural
    expect(isStructural('ALTER TABLE "reservations" DROP COLUMN "x", ALTER COLUMN "updated_at" DROP DEFAULT')).toBe(true);
  });

  test('entrada OBSOLETA na lista (divergência corrigida) também reprova', () => {
    const verdict = evaluate({ script: scriptOf(currentStatements.slice(1)), baseline });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join('\n')).toMatch(/OBSOLETA/);
  });

  test('compareStatements classifica estrutural, nova e obsoleta separadamente', () => {
    const result = compareStatements(['DROP INDEX "n"', 'ALTER TABLE "t" ADD COLUMN "c" INTEGER'], baseline);
    expect(result.novas).toEqual(['DROP INDEX "n"']);
    expect(result.structural).toEqual(['ALTER TABLE "t" ADD COLUMN "c" INTEGER']);
    expect(result.obsoletas).toHaveLength(33);
  });
});

describe('camada 2 — retrato do catálogo (o que o Prisma não enxerga)', () => {
  const mutate = (fn) => { const copy = clone(snapshot); fn(copy); return copy; };
  const legacyFk = 'reservation_items.reservation_items_rental_unit_id_fkey';
  const alignedFk = 'reservation_item_returns.reservation_item_returns_reservation_item_id_fkey';

  test('o retrato real tem FKs, índices e DEFAULTs, e é igual a si mesmo', () => {
    expect(Object.keys(snapshot.foreignKeys).length).toBeGreaterThanOrEqual(19);
    expect(Object.keys(snapshot.indexes).length).toBeGreaterThanOrEqual(60);
    expect(Object.keys(snapshot.defaults).length).toBeGreaterThanOrEqual(60);
    expect(diffCatalog(snapshot, clone(snapshot))).toEqual([]);
    expect(evaluate({ baseline, snapshot, catalog: clone(snapshot) }).ok).toBe(true); // modo só-catálogo
  });

  test('FK LEGADA (que o diff do Prisma não distingue): ON DELETE / ON UPDATE / colunas / referência / MATCH / deferrable', () => {
    expect(snapshot.foreignKeys[legacyFk].onDelete).toBe('NO ACTION');
    const cases = [
      ['onDelete', 'CASCADE'], ['onDelete', 'SET NULL'], ['onUpdate', 'CASCADE'], ['onUpdate', 'RESTRICT'],
      ['columns', ['reservation_id']], ['references', 'reservations'], ['referencedColumns', ['code']],
      ['match', 'FULL'], ['deferrable', true], ['initiallyDeferred', true],
    ];
    for (const [field, value] of cases) {
      const actual = mutate((s) => { s.foreignKeys[legacyFk][field] = value; });
      const messages = diffCatalog(snapshot, actual);
      expect(messages.length, `${field}=${JSON.stringify(value)}`).toBe(1);
      expect(messages[0]).toContain(`MUDOU em "${field}"`);
      expect(evaluate({ baseline, snapshot, catalog: actual }).ok).toBe(false);
    }
  });

  test('FK alinhada ao schema: ação alterada, removida ou nova', () => {
    expect(diffCatalog(snapshot, mutate((s) => { s.foreignKeys[alignedFk].onDelete = 'CASCADE'; }))[0]).toMatch(/MUDOU em "onDelete"/);
    expect(diffCatalog(snapshot, mutate((s) => { delete s.foreignKeys[alignedFk]; }))[0]).toMatch(/SUMIU/);
    expect(diffCatalog(snapshot, mutate((s) => { s.foreignKeys['x.zz_fkey'] = clone(s.foreignKeys[alignedFk]); }))[0]).toMatch(/NOVO\(A\)/);
  });

  test('índice: unicidade, colunas, ordem das colunas, método, condição (WHERE), opções, validade, remoção e inclusão', () => {
    const uniqueIdx = 'reservations.reservations_shopify_cart_id_key';
    expect(snapshot.indexes[uniqueIdx].unique).toBe(true);
    const partial = 'reservation_items.reservation_items_no_overlap_per_unit'; // EXCLUDE: gist com condição
    expect(snapshot.indexes[partial].predicate).toMatch(/status=any/);
    const composite = 'reservations.reservations_sku_status_idx';
    const cases = [
      [uniqueIdx, 'unique', false], [uniqueIdx, 'columns', ['other']], [composite, 'columns', ['status', 'sku']],
      [uniqueIdx, 'method', 'hash'], [uniqueIdx, 'predicate', "(status='hold')"], [partial, 'predicate', null],
      [uniqueIdx, 'options', '3'], [uniqueIdx, 'valid', false], [uniqueIdx, 'primary', true], [uniqueIdx, 'totalColumns', 2],
    ];
    for (const [name, field, value] of cases) {
      const messages = diffCatalog(snapshot, mutate((s) => { s.indexes[name][field] = value; }));
      expect(messages.length, `${name}.${field}`).toBe(1);
      expect(messages[0]).toContain(`MUDOU em "${field}"`);
    }
    expect(diffCatalog(snapshot, mutate((s) => { delete s.indexes[uniqueIdx]; }))[0]).toMatch(/SUMIU/);
    expect(diffCatalog(snapshot, mutate((s) => { s.indexes['x.zz_idx'] = clone(s.indexes[uniqueIdx]); }))[0]).toMatch(/NOVO\(A\)/);
  });

  test('DEFAULT: alterado, removido, novo e coluna gerada/identity', () => {
    const key = 'reservations.updated_at';
    expect(snapshot.defaults[key].default).toBe('now()');
    expect(diffCatalog(snapshot, mutate((s) => { s.defaults[key].default = "(now()+'1day'::interval)"; }))[0]).toMatch(/MUDOU em "default"/);
    expect(diffCatalog(snapshot, mutate((s) => { delete s.defaults[key]; }))[0]).toMatch(/SUMIU/);
    expect(diffCatalog(snapshot, mutate((s) => { s.defaults['reservations.customer_email'] = { default: "'x'::text", generated: null, identity: null }; }))[0]).toMatch(/NOVO\(A\)/);
    expect(diffCatalog(snapshot, mutate((s) => { s.defaults[key].identity = 'a'; }))[0]).toMatch(/MUDOU em "identity"/);
    expect(diffCatalog(snapshot, mutate((s) => { s.defaults[key].generated = 's'; }))[0]).toMatch(/MUDOU em "generated"/);
  });

  test('formatação irrelevante NÃO reprova: espaços, caixa e parênteses externos em DEFAULT e condição de índice', () => {
    expect(normalizeExpr(" ( 'ONLINE'::reservation_source ) ")).toBe(normalizeExpr("'online'::reservation_source"));
    expect(normalizeExpr('NOW ( )')).toBe(normalizeExpr('now()'));
    expect(normalizeExpr("((status = 'hold'))")).toBe(normalizeExpr("status = 'hold'"));
    expect(normalizeExpr('')).toBeNull();
    expect(normalizeExpr(null)).toBeNull();
    // parênteses internos NÃO são removidos (mudam o significado)
    expect(normalizeExpr('(a) and (b)')).toBe('(a)and(b)');
    expect(normalizeExpr('(a) and (b)')).not.toBe(normalizeExpr('a and b'));
    // expressões realmente diferentes continuam diferentes
    expect(normalizeExpr('now()')).not.toBe(normalizeExpr('current_timestamp'));
  });

  test('buildCatalog: determinístico (ordem das linhas não importa) e traduz códigos do catálogo', () => {
    const rows = {
      foreignKeys: [
        { tbl: 'b', name: 'b_fkey', cols: ['x'], ref_tbl: 'a', ref_cols: ['id'], on_delete: 'n', on_update: 'c', match_type: 's', deferrable: false, deferred: false },
        { tbl: 'a', name: 'a_fkey', cols: ['y'], ref_tbl: 'c', ref_cols: ['id'], on_delete: 'a', on_update: 'a', match_type: 's', deferrable: true, deferred: true },
      ],
      indexes: [{ tbl: 'a', name: 'a_idx', method: 'btree', uniq: false, pk: false, nkey: 1, natts: 1, valid: true, options: '0', cols: ['y'], predicate: "( status = 'HOLD' )" }],
      defaults: [{ tbl: 'a', col: 'z', expr: ' NOW ( ) ', generated: '', identity: '' }],
    };
    const reversed = { foreignKeys: [...rows.foreignKeys].reverse(), indexes: rows.indexes, defaults: rows.defaults };
    expect(JSON.stringify(buildCatalog(rows))).toBe(JSON.stringify(buildCatalog(reversed)));
    const catalog = buildCatalog(rows);
    expect(catalog.foreignKeys['b.b_fkey']).toMatchObject({ onDelete: 'SET NULL', onUpdate: 'CASCADE', match: 'SIMPLE' });
    expect(catalog.foreignKeys['a.a_fkey']).toMatchObject({ onDelete: 'NO ACTION', deferrable: true, initiallyDeferred: true });
    expect(catalog.indexes['a.a_idx'].predicate).toBe("status='hold'");
    expect(catalog.defaults['a.z']).toEqual({ default: 'now()', generated: null, identity: null });
  });

  test('retrato ausente reprova; relatório completo reúne camada 1 e camada 2', () => {
    expect(evaluate({ baseline, snapshot: undefined, catalog: clone(snapshot) }).problems.join()).toMatch(/snapshot.*ausente/);
    const catalog = mutate((s) => { s.foreignKeys[legacyFk].onDelete = 'CASCADE'; });
    const verdict = evaluate({ script: scriptOf([...currentStatements, 'DROP INDEX "n"']), baseline, snapshot, catalog });
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.some((p) => p.startsWith('NOVA divergência do Prisma'))).toBe(true);
    expect(verdict.problems.some((p) => p.startsWith('catálogo:'))).toBe(true);
  });
});
