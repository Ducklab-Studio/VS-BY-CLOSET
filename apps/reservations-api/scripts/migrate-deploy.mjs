// Aplica as migrations pendentes (`prisma migrate deploy`) pela conexão DIRETA do Neon, sem passar pelo pooler.
//   MIGRATE_DATABASE_URL  (obrigatória) URL direta (host sem "-pooler"). Sem ela, ou com URL de pooler, o script ABORTA antes de qualquer conexão.
// A DATABASE_URL de runtime (pooler) não é lida nem alterada: só o processo filho do Prisma recebe a URL direta, como DATABASE_URL.
// O advisory lock do Prisma continua HABILITADO (PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK é removida do ambiente do filho).
// Uso na Railway: preDeployCommand → `pnpm --filter @valle/reservations-api run db:migrate:deploy`. Local/CI seguem com `db:migrate`.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMigrateUrl } from './migrate-deploy-lib.mjs';

const apiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = validateMigrateUrl(process.env.MIGRATE_DATABASE_URL);
if (!check.ok) {
  console.error(`[migrate-deploy] ABORTADO (nenhuma conexão foi aberta): ${check.reason}`);
  process.exit(2);
}

const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
const env = { ...process.env, DATABASE_URL: check.url };
delete env.MIGRATE_DATABASE_URL;
delete env.PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK; // o advisory lock do Prisma fica sempre ligado

console.log('[migrate-deploy] prisma migrate deploy pela conexão direta (MIGRATE_DATABASE_URL); a DATABASE_URL de runtime não foi alterada.');
const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], { cwd: apiDir, stdio: 'inherit', env });
if (result.error) {
  console.error(`[migrate-deploy] não foi possível executar o Prisma: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
