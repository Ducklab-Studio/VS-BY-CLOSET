/**
 * Verificador de drift: migrations × `schema.prisma` × catálogo do PostgreSQL. Sem acessar produção.
 *
 * Aplica-se a um banco LOCAL já migrado (o Postgres efêmero do CI ou um descartável). As regras e as três camadas
 * estão descritas em `schema-drift-lib.mjs`; a lista de divergências legadas (com justificativa) está em
 * `schema-drift.baseline.json` e o retrato do catálogo em `schema-catalog.snapshot.json`.
 *
 * Uso (DATABASE_URL = PostgreSQL local de teste, migrado):
 *   node scripts/check-schema-drift.mjs                    # verifica (diff do Prisma + catálogo); exit 1 se divergir
 *   node scripts/check-schema-drift.mjs --catalog-only     # só o catálogo (mais rápido; usado nos testes de mutação)
 *   node scripts/check-schema-drift.mjs --print-statements # imprime as instruções atuais do diff (para montar a lista)
 *   node scripts/check-schema-drift.mjs --write-snapshot   # regrava schema-catalog.snapshot.json (revisar o diff no PR!)
 *
 * Códigos de saída: 0 ok; 1 divergência encontrada; 2 uso/ambiente inválido (inclusive banco não-local).
 * Segurança: aborta se DATABASE_URL não for PostgreSQL local de teste (localhost e nome com test/audit/operational);
 * todas as consultas rodam em transação READ ONLY. `--write-snapshot` só escreve o arquivo do retrato.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATALOG_QUERIES, buildCatalog, evaluate, parseDiffScript } from './schema-drift-lib.mjs';

const url = process.env.DATABASE_URL ?? '';
if (!/^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(url)) {
  console.error('check-schema-drift: DATABASE_URL precisa ser um PostgreSQL local de teste (localhost e nome com test/audit/operational). Abortado.');
  process.exit(2);
}

const args = new Set(process.argv.slice(2));
const unknown = [...args].filter((a) => !['--catalog-only', '--print-statements', '--write-snapshot'].includes(a));
if (unknown.length) {
  console.error(`check-schema-drift: opção desconhecida: ${unknown.join(' ')}`);
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, '..');
const baselinePath = path.join(here, 'schema-drift.baseline.json');
const snapshotPath = path.join(here, 'schema-catalog.snapshot.json');
const require = createRequire(import.meta.url);

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return undefined; }
}

async function readCatalog() {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasourceUrl: url, log: [] });
  try {
    return await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const rows = {};
      for (const [group, sql] of Object.entries(CATALOG_QUERIES)) rows[group] = await tx.$queryRawUnsafe(sql);
      const [{ major }] = await tx.$queryRawUnsafe("SELECT split_part(current_setting('server_version'), '.', 1) AS major");
      return { catalog: buildCatalog(rows), major };
    });
  } finally {
    await prisma.$disconnect();
  }
}

function prismaDiffScript() {
  const prismaCli = require.resolve('prisma/build/index.js');
  const result = spawnSync(
    process.execPath,
    [prismaCli, 'migrate', 'diff', '--from-url', url, '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
    // CHECKPOINT_DISABLE: o CLI do Prisma não faz chamadas de rede externas (verificação de versão/telemetria).
    { cwd: apiDir, encoding: 'utf8', env: { ...process.env, CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' } },
  );
  if (result.status !== 0) {
    console.error('check-schema-drift: `prisma migrate diff` falhou.\n' + (result.stderr || result.stdout));
    process.exit(2);
  }
  return result.stdout;
}

try {
  if (args.has('--print-statements')) {
    console.log(JSON.stringify(parseDiffScript(prismaDiffScript()), null, 2));
    process.exit(0);
  }

  const { catalog, major } = await readCatalog();

  if (args.has('--write-snapshot')) {
    const snapshot = { generatedOnPostgresMajor: major, ...catalog };
    writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`check-schema-drift: retrato do catálogo gravado em scripts/schema-catalog.snapshot.json (PostgreSQL ${major}; ` +
      `${Object.keys(catalog.foreignKeys).length} FKs, ${Object.keys(catalog.indexes).length} índices, ${Object.keys(catalog.defaults).length} DEFAULTs). Revise o diff no PR.`);
    process.exit(0);
  }

  const baseline = readJson(baselinePath);
  const snapshot = readJson(snapshotPath);
  const script = args.has('--catalog-only') ? undefined : prismaDiffScript();
  const { generatedOnPostgresMajor, ...expectedCatalog } = snapshot ?? {};
  const verdict = evaluate({ script, baseline, snapshot: snapshot ? expectedCatalog : undefined, catalog });

  if (!verdict.ok) {
    console.error(`check-schema-drift: ${verdict.problems.length} problema(s):\n`);
    for (const problem of verdict.problems) console.error('  - ' + problem);
    if (generatedOnPostgresMajor && String(generatedOnPostgresMajor) !== String(major)) {
      console.error(`\nObservação: o retrato foi gerado no PostgreSQL ${generatedOnPostgresMajor} (CI) e este banco é o ${major}; diferenças só de formatação de expressão podem ocorrer fora do CI.`);
    }
    console.error('\nSe a mudança é INTENCIONAL (nova migration/schema), atualize schema-drift.baseline.json (com justificativa) e/ou rode `--write-snapshot` e revise o diff.');
    process.exit(1);
  }
  const parts = [];
  if (script !== undefined) parts.push(`${verdict.counts.diff} diferença(s) do Prisma, todas na lista de legadas justificadas`);
  parts.push(`catálogo igual ao retrato (${Object.keys(catalog.foreignKeys).length} FKs, ${Object.keys(catalog.indexes).length} índices, ${Object.keys(catalog.defaults).length} DEFAULTs)`);
  console.log(`check-schema-drift: sem divergência (${parts.join('; ')}).`);
} catch (error) {
  console.error('check-schema-drift: erro inesperado:', String(error?.message ?? error).split('\n')[0]);
  process.exit(2);
}
