/**
 * Prova empírica da trava anti-double-booking, atualizada pra Fase 5 —
 * não é um teste de unidade com mock, é uma tentativa real de furar a
 * constraint que hoje protege o fluxo de HOLD.
 *
 * A versão original (Fase 1) testava `reservations_no_overlap_per_sku`
 * inserindo direto em `product_references`/`reservations` com sku como
 * chave. Essas tabelas não existem mais desde a Fase 4
 * (`product_references` virou `rental_units`; a trava real hoje é
 * `reservation_items_no_overlap_per_unit`, em `reservation_items`) — o
 * script antigo não rodaria mais contra o schema atual. Este é o mesmo
 * experimento, reescrito pro schema novo: dois clientes tentam ocupar a
 * MESMA RentalUnit para datas sobrepostas, ao mesmo tempo, e o teste
 * confirma que é o Postgres — não o código da aplicação — quem rejeita
 * um dos dois.
 *
 * Isto é o experimento de MAIS BAIXO NÍVEL (INSERT direto, sem passar
 * por HoldsService) — prova a garantia de ÚLTIMA instância isoladamente.
 * A prova de que o desenho completo (FOR UPDATE + retry + idempotência)
 * se comporta certo sob concorrência real está em
 * src/holds/holds.concurrency.integration.test.ts (`pnpm test`).
 *
 * Uso: pnpm --filter @valle/reservations-api test:concurrency
 * Requer DATABASE_URL apontando pra um Postgres real (ver .env.example).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const STORE_ID = 'concurrency-manual-test-store';
const VARIANT_ID = 'concurrency-manual-test-variant';
const UNIT_CODE = 'CONCURRENCY-MANUAL-TEST-UNIT';

async function cleanup(): Promise<void> {
  await prisma.$executeRaw`DELETE FROM reservation_items WHERE rental_unit_id IN (SELECT id FROM rental_units WHERE code = ${UNIT_CODE})`;
  await prisma.$executeRaw`DELETE FROM reservations WHERE origin_store_id = ${STORE_ID}`;
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code = ${UNIT_CODE}`;
  await prisma.$executeRaw`DELETE FROM stores WHERE id = ${STORE_ID}`;
}

async function setup(): Promise<string> {
  await cleanup();

  await prisma.$executeRaw`
    INSERT INTO stores (id, shopify_domain, currency) VALUES (${STORE_ID}, 'concurrency-manual-test.myshopify.com', 'CLP')
  `;
  const [{ id: unitId }] = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO rental_units (id, code, name, shopify_variant_id, active, reservable_online, counts_toward_rental_duration)
    VALUES (gen_random_uuid(), ${UNIT_CODE}, 'Peça de teste — concorrência manual', ${VARIANT_ID}, true, true, true)
    RETURNING id
  `;
  return unitId;
}

function insertReservationItem(unitId: string, orderTag: string) {
  // Datas sobrepostas de propósito: 2027-07-10 a 2027-07-15 nos dois casos.
  return prisma.$transaction(async (tx) => {
    const [{ id: reservationId }] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO reservations (id, status, origin_store_id, pickup_date, return_date)
      VALUES (gen_random_uuid(), 'confirmed', ${STORE_ID}, '2027-07-10', '2027-07-15')
      RETURNING id
    `;
    await tx.$executeRaw`
      INSERT INTO reservation_items (id, reservation_id, rental_unit_id, status, blocked_range)
      VALUES (
        gen_random_uuid(), ${reservationId}::uuid, ${unitId}::uuid, 'confirmed',
        daterange('2027-07-10', '2027-07-15', '[]')
      )
    `;
    return `${orderTag}:${reservationId}`;
  });
}

async function main() {
  const unitId = await setup();

  const [resultA, resultB] = await Promise.allSettled([insertReservationItem(unitId, 'A'), insertReservationItem(unitId, 'B')]);

  const succeeded = [resultA, resultB].filter((r) => r.status === 'fulfilled');
  const failed = [resultA, resultB].filter((r) => r.status === 'rejected');

  console.log('A:', resultA.status);
  console.log('B:', resultB.status);

  if (failed.length === 1 && succeeded.length === 1) {
    const rejection = failed[0] as PromiseRejectedResult;
    const message = String(rejection.reason?.message ?? rejection.reason);
    const isExclusionViolation = message.includes('reservation_items_no_overlap_per_unit');
    console.log(
      isExclusionViolation
        ? '\n✅ PASSOU: o Postgres rejeitou o ReservationItem sobreposto pela constraint EXCLUDE (reservation_items_no_overlap_per_unit).'
        : `\n⚠️  Uma inserção falhou, mas não pela constraint esperada. Erro: ${message}`,
    );
    process.exitCode = isExclusionViolation ? 0 : 1;
  } else if (succeeded.length === 2) {
    console.log('\n❌ FALHOU: as duas reservas sobrepostas foram aceitas — double-booking real. A constraint não está ativa.');
    process.exitCode = 1;
  } else {
    console.log('\n❌ FALHOU: as duas inserções foram rejeitadas — algo além da constraint de overlap está errado (setup?).');
    console.log((resultA as PromiseRejectedResult).reason);
    console.log((resultB as PromiseRejectedResult).reason);
    process.exitCode = 1;
  }

  await cleanup();
}

main()
  .catch((err) => {
    console.error('Erro inesperado no teste:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
