#!/usr/bin/env node
/**
 * Verificador SOMENTE LEITURA da homologação do AUTO_VERIFY (ver docs/VALLE-PASS-HOMOLOGACAO-RUNBOOK.md).
 *
 *   railway run -p <projeto> -e <ambiente> -s "@valle/reservations-api" -- node apps/reservations-api/scripts/homologacao-verify.mjs "#1015"
 *
 * Usa a DATABASE_URL do ambiente, abre uma transação `READ ONLY` e só faz leituras. Imprime os critérios (OK/FALHA) e o fingerprint; sem dados pessoais nem códigos de
 * voucher. Código de saída: 0 = todos os critérios OK; 2 = algum reprovado ou pedido não encontrado. Requer `pnpm --filter @valle/reservations-api build` (usa `dist/`).
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, '..');
const orderName = process.argv[2];
if (!orderName || !/^#?[A-Za-z0-9-]{1,32}$/.test(orderName)) {
  console.error('Uso: node scripts/homologacao-verify.mjs "#<número do pedido de teste>"');
  process.exit(1);
}
const { PrismaClient } = createRequire(path.join(apiRoot, 'package.json'))('@prisma/client');
const { checkHomologation } = await import(pathToFileURL(path.join(apiRoot, 'dist/src/vale-pass/homologation-check.js')).href);

const db = new PrismaClient({ log: [] });
try {
  const report = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
    return checkHomologation(tx, { orderName });
  });
  for (const check of report.checks) console.log(`${check.ok ? 'OK    ' : 'FALHA '} ${check.id}  ${check.detail}`);
  console.log(`\npedido: ${report.orderName}  encontrado: ${report.found}  fingerprint: ${report.fingerprint ?? '-'}`);
  console.log(report.pass ? 'RESULTADO: APROVADO' : 'RESULTADO: REPROVADO');
  process.exit(report.pass ? 0 : 2);
} finally {
  await db.$disconnect();
}
