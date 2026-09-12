#!/usr/bin/env node
// Aplica migrations SÓ em banco de desenvolvimento/staging — nunca em
// produção. Não decide sozinho "isto é produção?" (não temos como saber
// com certeza a partir da própria DATABASE_URL) — em vez disso, exige
// uma confirmação explícita, separada da variável de conexão, pra nunca
// rodar por engano contra o banco errado só porque DATABASE_URL estava
// setada na sessão do terminal.
//
// Uso:
//   DATABASE_URL="<url de DEV/staging>" MIGRATE_CONFIRM_NON_PRODUCTION=yes \
//     pnpm --filter @valle/reservations-api run db:migrate:dev-safe
import { spawnSync } from 'node:child_process';

const databaseUrl = process.env.DATABASE_URL;
const confirmed = process.env.MIGRATE_CONFIRM_NON_PRODUCTION === 'yes';

if (!databaseUrl) {
  console.error('Bloqueado: DATABASE_URL não está definida. Aponte explicitamente para o banco de DEV/staging antes de rodar este comando.');
  process.exit(1);
}

if (!confirmed) {
  console.error(
    'Bloqueado: defina MIGRATE_CONFIRM_NON_PRODUCTION=yes explicitamente para confirmar que a DATABASE_URL atual ' +
      'NÃO é produção. Este comando nunca assume isso sozinho — nem a ausência desta variável, nem o valor de ' +
      'DATABASE_URL, provam por si só que é seguro.',
  );
  process.exit(1);
}

console.log('Confirmado como não-produção — aplicando migrations pendentes...');
const result = spawnSync('npx', ['prisma', 'migrate', 'deploy'], { stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);
