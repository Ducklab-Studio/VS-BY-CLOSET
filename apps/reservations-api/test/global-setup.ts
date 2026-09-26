import { assertSafeTestDatabase, readProductionUrlFromEnvFile, type SafeDatabaseInput } from './safe-database';

/**
 * Linha de base da suíte: loja aberta (sem data de início da operação).
 *
 * A migration grava a data inicial real da operação (dado de produção). A
 * maioria dos testes escolhe datas relativas a "hoje" e não é sobre essa
 * regra — com a data gravada, falhariam pelo motivo errado. Os testes da
 * regra definem a própria data e restauram `null` ao terminar.
 *
 * Ordem obrigatória: 1) `assertSafeTestDatabase` (aborta a suíte se o banco
 * não for explicitamente de teste — host local, host em
 * `TEST_DATABASE_ALLOWED_HOSTS` ou banco `TESTE`, nunca o host/banco do `.env`
 * de produção); 2) só então o baseline é aplicado. Por isso o baseline nunca
 * roda em produção: quem não passa na trava nem chega aqui.
 */
export async function applyRuleBaseline(): Promise<void> {
  // Import dinâmico e SÓ depois da trava: importar '@prisma/client' carrega o
  // `.env` em process.env, o que faria a checagem "definida explicitamente"
  // enxergar a URL de produção como se tivesse sido passada de propósito.
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRaw`
      UPDATE rental_rule_config
      SET min_advance_days = 15,
          prep_days = 3,
          cleaning_days = 2,
          operation_start_date = NULL,
          max_pieces = 6,
          pieces_to_days_table = '[{"upTo":2,"days":2},{"upTo":4,"days":3},{"upTo":6,"days":4}]'::jsonb,
          timezone = 'America/Santiago',
          blackout_start = NULL,
          blackout_end = NULL
      WHERE id = 'default'
    `;
  } finally {
    await prisma.$disconnect();
  }
}

/** Separado do `default` para poder ser testado sem banco (baseline injetado). */
export async function setupWith(input: SafeDatabaseInput, baseline: () => Promise<void>): Promise<void> {
  assertSafeTestDatabase(input);
  await baseline();
}

export default async function setup(): Promise<void> {
  await setupWith(
    {
      databaseUrl: process.env.DATABASE_URL,
      allowedHosts: process.env.TEST_DATABASE_ALLOWED_HOSTS,
      productionUrls: readProductionUrlFromEnvFile(),
    },
    applyRuleBaseline,
  );
}
