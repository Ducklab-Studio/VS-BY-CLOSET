import { PrismaClient } from '@prisma/client';

/**
 * Linha de base da suíte: loja aberta (sem data de início da operação).
 *
 * A migration grava a data inicial real da operação (dado de produção). A
 * maioria dos testes escolhe datas relativas a "hoje" e não é sobre essa
 * regra — com a data gravada, falhariam pelo motivo errado. Os testes da
 * regra definem a própria data e restauram `null` ao terminar.
 *
 * Só mexe em banco LOCAL de teste (mesma checagem das suítes de integração);
 * em qualquer outro banco não faz nada.
 */
const LOCAL_TEST_DATABASE = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i;

function isApprovedTestDatabase(raw: string): boolean {
  if (LOCAL_TEST_DATABASE.test(raw)) return true;
  try {
    const databaseName = decodeURIComponent(new URL(raw).pathname.replace(/^\//, ''));
    return databaseName.toUpperCase() === 'TESTE';
  } catch {
    return false;
  }
}

export default async function setup(): Promise<void> {
  if (!isApprovedTestDatabase(process.env.DATABASE_URL ?? '')) return;
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
