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

export default async function setup(): Promise<void> {
  if (!LOCAL_TEST_DATABASE.test(process.env.DATABASE_URL ?? '')) return;
  const prisma = new PrismaClient();
  try {
    await prisma.$executeRaw`UPDATE rental_rule_config SET operation_start_date = NULL WHERE id = 'default'`;
  } finally {
    await prisma.$disconnect();
  }
}
