/**
 * Lógica PURA do verificador de drift entre as migrations, o `schema.prisma` e o catálogo do PostgreSQL
 * (sem banco, sem processo filho). O CLI está em `check-schema-drift.mjs`; os testes, em
 * `schema-drift-lib.test.mjs` (puros) e `schema-drift.e2e.test.mjs` (mutações em banco descartável).
 *
 * Três camadas; qualquer violação reprova o CI:
 *
 *  1. DIFF DO PRISMA × lista de divergências legadas (`schema-drift.baseline.json`)
 *     - ESTRUTURAL (tabela, coluna, tipo, nulidade, tipo enumerado) nunca é tolerado e nunca pode entrar na lista;
 *     - toda outra instrução do diff precisa constar EXATAMENTE na lista, cada uma com justificativa; instrução NOVA
 *       (índice, DEFAULT, chave estrangeira...) reprova; entrada da lista que sumiu do diff (divergência corrigida)
 *       também reprova, para a lista não ficar velha e esconder uma regressão futura.
 *
 *  2. RETRATO DO CATÁLOGO × `schema-catalog.snapshot.json` — o que o Prisma NÃO enxerga:
 *     - o texto do diff não muda quando um objeto que JÁ diverge muda de novo (ex.: FK sem ação referencial trocada
 *       por ON DELETE CASCADE gera o MESMO diff), e o Prisma ignora condição de índice parcial (WHERE), ordem/opções
 *       de coluna e método de acesso;
 *     - o retrato cobre TODAS as tabelas de `public` (menos `_prisma_migrations`): chaves estrangeiras (colunas,
 *       tabela/colunas referenciadas, ON DELETE, ON UPDATE, MATCH, deferrable), índices (método, unicidade, PK,
 *       colunas/expressões, condição, opções, válido) e DEFAULTs/colunas geradas/identity.
 *     - comparação ESTRUTURADA campo a campo (nada de comparar o SQL deparsado inteiro): ação referencial vem do
 *       código do catálogo (`confdeltype`), não do texto; só expressões de DEFAULT e condição de índice são texto e
 *       passam por normalização de espaços/caixa/parênteses.
 *
 *  3. (no CLI) acesso só a PostgreSQL local de teste.
 *
 * Limites conhecidos (documentados no runbook): CHECK, gatilhos, funções, extensões, colunas (tipo/nulidade) fora do
 * diff do Prisma e privilégios não entram no retrato — CHECK/gatilhos/EXCLUDE de cada migration são cobertos por
 * testes de integração próprios; tipo/nulidade de coluna é coberto pela camada 1.
 */

/** Divergência ESTRUTURAL: nunca tolerada. */
export const STRUCTURAL = [
  /\bADD COLUMN\b/i,
  /\bDROP COLUMN\b/i,
  /\bALTER COLUMN\b[^;]*\b(TYPE|SET NOT NULL|DROP NOT NULL)\b/i,
  /^CREATE TABLE\b/i,
  /^DROP TABLE\b/i,
  /^CREATE TYPE\b/i,
  /^ALTER TYPE\b/i,
  /^DROP TYPE\b/i,
];

export function normalizeStatement(statement) {
  return statement.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim();
}

/** Saída de `prisma migrate diff --script` → instruções normalizadas (sem comentários e sem o `;` final). */
export function parseDiffScript(script) {
  return script
    .split(/;\s*\n/)
    .map((chunk) => chunk.split('\n').filter((line) => !/^\s*--/.test(line)).join('\n'))
    .map(normalizeStatement)
    .filter(Boolean);
}

export const isStructural = (statement) => STRUCTURAL.some((pattern) => pattern.test(statement));

/** Problemas de formato da lista (vazio = válida). A lista nunca aceita instrução estrutural. */
export function validateBaseline(baseline) {
  const problems = [];
  if (!baseline || typeof baseline !== 'object' || !Array.isArray(baseline.statements)) return ['lista ausente ou sem `statements`'];
  const seen = new Set();
  for (const entry of baseline.statements) {
    const sql = typeof entry?.sql === 'string' ? normalizeStatement(entry.sql) : '';
    if (!sql) { problems.push('entrada sem `sql`'); continue; }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 20) problems.push(`sem justificativa (mín. 20 caracteres): ${sql.slice(0, 80)}`);
    if (isStructural(sql)) problems.push(`divergência ESTRUTURAL não pode constar na lista: ${sql.slice(0, 80)}`);
    if (seen.has(sql)) problems.push(`entrada duplicada: ${sql.slice(0, 80)}`);
    seen.add(sql);
  }
  return problems;
}

/** Camada 1: compara o diff atual com a lista. */
export function compareStatements(current, baseline) {
  const known = new Set(baseline.statements.map((entry) => normalizeStatement(entry.sql)));
  const currentSet = new Set(current);
  return {
    structural: current.filter(isStructural),
    novas: current.filter((statement) => !known.has(statement) && !isStructural(statement)),
    obsoletas: [...known].filter((statement) => !currentSet.has(statement)),
  };
}

// ───────────────────────────── Camada 2: retrato estruturado do catálogo ─────────────────────────────

const ACTION = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
const MATCH = { s: 'SIMPLE', f: 'FULL', p: 'PARTIAL' };

/** Expressão (DEFAULT ou condição de índice): sem espaços, minúscula, sem parênteses externos redundantes. */
export function normalizeExpr(expr) {
  if (expr === null || expr === undefined || expr === '') return null;
  let out = String(expr).replace(/\s+/g, '').toLowerCase();
  while (out.startsWith('(') && out.endsWith(')') && balanced(out.slice(1, -1))) out = out.slice(1, -1);
  return out;
}
function balanced(text) {
  let depth = 0;
  for (const ch of text) {
    if (ch === '(') depth += 1;
    else if (ch === ')') { depth -= 1; if (depth < 0) return false; }
  }
  return depth === 0;
}

/** Consultas de catálogo (somente leitura). `_prisma_migrations` é do próprio Prisma e fica de fora. */
export const CATALOG_QUERIES = {
  foreignKeys: `
    SELECT c.conrelid::regclass::text AS tbl, c.conname AS name,
      (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS cols,
      c.confrelid::regclass::text AS ref_tbl,
      (SELECT array_agg(a.attname ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS ref_cols,
      c.confdeltype::text AS on_delete, c.confupdtype::text AS on_update, c.confmatchtype::text AS match_type,
      c.condeferrable AS deferrable, c.condeferred AS deferred
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.contype = 'f' AND n.nspname = 'public' AND c.conrelid::regclass::text <> '_prisma_migrations'
    ORDER BY 1, 2`,
  indexes: `
    SELECT t.relname AS tbl, i.relname AS name, am.amname AS method, x.indisunique AS uniq, x.indisprimary AS pk,
      x.indnkeyatts::int AS nkey, x.indnatts::int AS natts, x.indisvalid AS valid, x.indoption::text AS options,
      (SELECT array_agg(CASE WHEN k.attnum = 0 THEN pg_get_indexdef(x.indexrelid, k.ord::int, true) ELSE a.attname END ORDER BY k.ord)
         FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(attnum, ord)
         LEFT JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum) AS cols,
      pg_get_expr(x.indpred, x.indrelid) AS predicate
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_am am ON am.oid = i.relam
    WHERE n.nspname = 'public' AND t.relname <> '_prisma_migrations'
    ORDER BY 1, 2`,
  defaults: `
    SELECT c.relname AS tbl, a.attname AS col, pg_get_expr(d.adbin, d.adrelid) AS expr,
      a.attgenerated::text AS generated, a.attidentity::text AS identity
    FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
      AND a.attnum > 0 AND NOT a.attisdropped AND (d.adbin IS NOT NULL OR a.attgenerated <> '' OR a.attidentity <> '')
    ORDER BY 1, 2`,
};

/** Linhas das consultas → retrato estruturado e determinístico (chaves ordenadas). */
export function buildCatalog(rows) {
  const sortObj = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const foreignKeys = {};
  for (const r of rows.foreignKeys) {
    foreignKeys[`${r.tbl}.${r.name}`] = {
      columns: r.cols, references: r.ref_tbl, referencedColumns: r.ref_cols,
      onDelete: ACTION[r.on_delete] ?? r.on_delete, onUpdate: ACTION[r.on_update] ?? r.on_update,
      match: MATCH[r.match_type] ?? r.match_type, deferrable: r.deferrable, initiallyDeferred: r.deferred,
    };
  }
  const indexes = {};
  for (const r of rows.indexes) {
    indexes[`${r.tbl}.${r.name}`] = {
      method: r.method, unique: r.uniq, primary: r.pk, keyColumns: r.nkey, totalColumns: r.natts, valid: r.valid,
      options: r.options, columns: r.cols, predicate: normalizeExpr(r.predicate),
    };
  }
  const defaults = {};
  for (const r of rows.defaults) {
    defaults[`${r.tbl}.${r.col}`] = { default: normalizeExpr(r.expr), generated: r.generated || null, identity: r.identity || null };
  }
  return { foreignKeys: sortObj(foreignKeys), indexes: sortObj(indexes), defaults: sortObj(defaults) };
}

/** Compara dois retratos; devolve mensagens legíveis (vazio = iguais). */
export function diffCatalog(expected, actual) {
  const out = [];
  const labels = { foreignKeys: 'chave estrangeira', indexes: 'índice', defaults: 'DEFAULT' };
  for (const group of Object.keys(labels)) {
    const exp = expected?.[group] ?? {};
    const act = actual?.[group] ?? {};
    for (const key of Object.keys(act)) {
      if (!(key in exp)) out.push(`${labels[group]} NOVO(A) no banco e fora do retrato: ${key} = ${JSON.stringify(act[key])}`);
    }
    for (const key of Object.keys(exp)) {
      if (!(key in act)) { out.push(`${labels[group]} do retrato SUMIU do banco: ${key}`); continue; }
      for (const field of new Set([...Object.keys(exp[key]), ...Object.keys(act[key])])) {
        if (JSON.stringify(exp[key][field]) !== JSON.stringify(act[key][field])) {
          out.push(`${labels[group]} ${key} MUDOU em "${field}": era ${JSON.stringify(exp[key][field])}, agora ${JSON.stringify(act[key][field])}`);
        }
      }
    }
  }
  return out;
}

/** Veredito completo. `catalog` pode ser omitido (modo só-diff do Prisma). */
export function evaluate({ script, baseline, snapshot, catalog }) {
  const formatProblems = validateBaseline(baseline);
  if (formatProblems.length) return { ok: false, problems: formatProblems.map((p) => `lista de divergências conhecidas: ${p}`), counts: {} };

  const problems = [];
  let diffCount = 0;
  if (script !== undefined) {
    const current = parseDiffScript(script);
    diffCount = current.length;
    const { structural, novas, obsoletas } = compareStatements(current, baseline);
    for (const s of structural) problems.push(`ESTRUTURAL (tabela/coluna/tipo/nulidade): ${s}`);
    for (const s of novas) problems.push(`NOVA divergência do Prisma (não está na lista de legadas): ${s}`);
    for (const s of obsoletas) problems.push(`entrada OBSOLETA em schema-drift.baseline.json (a divergência foi corrigida; remova-a): ${s}`);
  }
  if (catalog !== undefined) {
    if (!snapshot) problems.push('schema-catalog.snapshot.json ausente');
    else for (const m of diffCatalog(snapshot, catalog)) problems.push(`catálogo: ${m}`);
  }
  return { ok: problems.length === 0, problems, counts: { diff: diffCount, conhecidas: baseline.statements.length } };
}
