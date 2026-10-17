/**
 * Verificação de drift ESTRUTURAL entre as migrations e o `schema.prisma`, sem acessar produção.
 *
 * Aplica-se a um banco LOCAL já migrado (o Postgres efêmero do CI ou um descartável): compara o banco real
 * (`--from-url`) com o schema Prisma e FALHA se houver diferença de tabela, coluna, tipo ou nulidade — por exemplo,
 * uma migration que cria coluna sem o campo no `schema.prisma` (o cliente não a enxerga) ou um campo no schema sem
 * migration (o Prisma consultaria uma coluna inexistente).
 *
 * Ignorado de propósito (divergências antigas e benignas, medidas em 16/10/2026, anteriores à Fase 3): ações
 * referenciais de chaves estrangeiras (ON DELETE/UPDATE), índices antigos, e `DROP DEFAULT` de `updated_at`
 * (o Prisma gera `@updatedAt` no cliente). Nada disso envolve coluna, tipo ou nulidade.
 *
 * Uso: DATABASE_URL=<postgres local de teste> node scripts/check-schema-drift.mjs
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.env.DATABASE_URL ?? '';
if (!/^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(url)) {
  console.error('check-schema-drift: DATABASE_URL precisa ser um PostgreSQL local de teste (localhost e nome com test/audit/operational). Abortado.');
  process.exit(2);
}

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Executa a CLI do Prisma diretamente com o Node (sem shell), a partir das dependências deste pacote.
const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
const result = spawnSync(
  process.execPath,
  [prismaCli, 'migrate', 'diff', '--from-url', url, '--to-schema-datamodel', 'prisma/schema.prisma', '--script'],
  { cwd: apiDir, encoding: 'utf8' },
);
if (result.status !== 0) {
  console.error('check-schema-drift: `prisma migrate diff` falhou.\n' + (result.stderr || result.stdout));
  process.exit(2);
}

// Divergência ESTRUTURAL: tabela, coluna, tipo, nulidade ou tipo enumerado.
const STRUCTURAL = [
  /\bADD COLUMN\b/i,
  /\bDROP COLUMN\b/i,
  /\bALTER COLUMN\b[^;]*\b(TYPE|SET NOT NULL|DROP NOT NULL)\b/i,
  /^CREATE TABLE\b/i,
  /^DROP TABLE\b/i,
  /^CREATE TYPE\b/i,
  /^ALTER TYPE\b/i,
  /^DROP TYPE\b/i,
];
const statements = result.stdout
  .split(/;\s*\n/)
  .map((statement) => statement.replace(/^(--[^\n]*\n)+/g, '').trim())
  .filter(Boolean);
const drift = statements.filter((statement) => STRUCTURAL.some((pattern) => pattern.test(statement)));

if (drift.length > 0) {
  console.error('check-schema-drift: o schema.prisma e as migrations divergem (tabela/coluna/tipo/nulidade):\n');
  for (const statement of drift) console.error('  ' + statement.replace(/\s+/g, ' ') + ';');
  console.error('\nCorrija a migration ou o schema.prisma (prisma/schema.prisma) para que descrevam o mesmo banco.');
  process.exit(1);
}
console.log(`check-schema-drift: sem divergência estrutural (${statements.length} diferenças benignas conhecidas ignoradas).`);
