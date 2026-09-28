import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { HoldsService } from './holds.service';
import { HOLD_BUSY_MESSAGE, HOLD_CLIENT_LIMIT_MESSAGE, HOLD_LIMITS, holdClient, maxHeldPieces } from './hold-client';
import { type CivilDate, addDays, civilDateToISO, isSunday } from '../rental-rules/civil-date';
import { calculateReturnDate, isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import type { CreateHoldDto } from './dto/create-hold.dto';

/**
 * Limites de HOLD por navegador, por rede e global (hold-client.ts). Postgres
 * de teste real; nenhum pedido/pagamento — só HOLDs de fixture, apagados no fim.
 */
const prisma = new PrismaService();
const service = new HoldsService(prisma, new RentalRuleConfigService(prisma));
const CFG = DEFAULT_RENTAL_RULE_CONFIG;
const PREFIX = `HOLD-CLIENT-${Date.now()}`;
const VARIANT = `${PREFIX}-sobretudo`;
const UNITS = 16;

function pickupSafe(date: CivilDate): CivilDate {
  let d = date;
  for (let i = 0; i < 400 && (!isOnlineReservationAllowed(d, CFG) || isSunday(d)); i++) d = addDays(d, 1);
  return d;
}
/** Duração pela tabela de faixas (2 peças → 2 dias, 4 → 3, 6 → 4). */
function durationFor(pieces: number): number {
  return CFG.piecesToDaysTable.find((row) => pieces <= row.upTo)?.days ?? CFG.piecesToDaysTable[CFG.piecesToDaysTable.length - 1].days;
}
/** Retirada válida cuja devolução, para ESTA quantidade de peças, não cai no domingo. */
function pickup(daysFromToday: number, pieces: number): CivilDate {
  let d = pickupSafe(addDays(engineToday(CFG), daysFromToday));
  for (let i = 0; i < 400 && isSunday(calculateReturnDate(d, durationFor(pieces))); i++) d = pickupSafe(addDays(d, 1));
  return d;
}

let day = 30;
const dto = (quantity = 1): CreateHoldDto => ({ items: [{ shopifyVariantId: VARIANT, quantity }], pickupDate: civilDateToISO(pickup((day += 9), quantity)), termsAccepted: true });
let net = 0;
/** Uma rede (IP) nova para cada cenário; navegadores são ids aleatórios dentro dela. */
const newNetwork = () => `203.0.113.${++net}`;
const status = (err: unknown) => (err instanceof HttpException ? err.getStatus() : null);
const tryHold = (client: ReturnType<typeof holdClient>, quantity = 1) => service.createHold(dto(quantity), undefined, client).catch((e: unknown) => e);

async function fixtureReservationIds() {
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri
    JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${PREFIX + '%'}
  `;
  return rows.map((r) => r.id);
}

async function cleanup() {
  const ids = await fixtureReservationIds();
  if (ids.length) {
    await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM hold_idempotency_keys WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${ids}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM reservation_events WHERE type = 'HOLD_CLIENT' AND detail ->> 'synthetic' = ${PREFIX}`;
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
}

beforeAll(async () => {
  await cleanup();
  await prisma.rentalUnit.createMany({
    data: Array.from({ length: UNITS }, (_, i) => ({
      code: `${PREFIX}-u${i}`,
      name: `Sobretudo ${i}`,
      shopifyVariantId: VARIANT,
      active: true,
      reservableOnline: true,
      countsTowardRentalDuration: true,
    })),
  });
});
// Cada cenário começa sem HOLDs ativos desta suíte contando (inclusive no
// disjuntor global): os HOLDs de um teste não podem mudar o resultado do próximo.
afterEach(async () => {
  const ids = await fixtureReservationIds();
  if (ids.length) await prisma.$executeRaw`UPDATE reservations SET status = 'expired' WHERE id = ANY(${ids}::uuid[]) AND status = 'hold'`;
  if (ids.length) await prisma.$executeRaw`DELETE FROM reservation_events WHERE type = 'HOLD_CLIENT' AND reservation_id = ANY(${ids}::uuid[])`;
  await prisma.$executeRaw`DELETE FROM reservation_events WHERE type = 'HOLD_CLIENT' AND detail ->> 'synthetic' = ${PREFIX}`;
});
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('identidade de quem pede HOLD', () => {
  test('só hashes; mesma rede → mesma networkKey; navegadores diferentes → browserKeys diferentes; id inválido vira "anon"', () => {
    const a = holdClient('198.51.100.7', randomUUID());
    const b = holdClient('198.51.100.7', randomUUID());
    expect(a.networkKey).toBe(b.networkKey);
    expect(a.browserKey).not.toBe(b.browserKey);
    expect(`${a.networkKey}${a.browserKey}`).not.toContain('198.51');
    expect(holdClient('198.51.100.7', 'nao-e-uuid').browserKey).toBe(holdClient('198.51.100.7', undefined).browserKey);
    // O mesmo id de navegador em outra rede é outro cliente (o id não atravessa IPs).
    const id = randomUUID();
    expect(holdClient('198.51.100.7', id).browserKey).not.toBe(holdClient('198.51.100.8', id).browserKey);
  });
});

describe('HOLDs por navegador, por rede e global (Postgres de teste)', () => {
  test('duas pessoas legítimas na MESMA rede: cada uma cria as suas, ninguém é barrado', async () => {
    const ip = newNetwork();
    const maria = holdClient(ip, randomUUID());
    const joao = holdClient(ip, randomUUID());
    for (let i = 0; i < HOLD_LIMITS.perBrowser.holds; i++) {
      expect(await tryHold(maria)).toMatchObject({ status: 'hold' });
      expect(await tryHold(joao)).toMatchObject({ status: 'hold' });
    }
  }, 60_000);

  test('o MESMO navegador não passa de 2 HOLDs ativos; outra pessoa da rede segue normal', async () => {
    const ip = newNetwork();
    const abuser = holdClient(ip, randomUUID());
    for (let i = 0; i < HOLD_LIMITS.perBrowser.holds; i++) expect(await tryHold(abuser)).toMatchObject({ status: 'hold' });
    const blocked = await tryHold(abuser);
    expect(status(blocked)).toBe(429);
    expect((blocked as Error).message).toBe(HOLD_CLIENT_LIMIT_MESSAGE);
    expect(await tryHold(holdClient(ip, randomUUID()))).toMatchObject({ status: 'hold' });
  }, 60_000);

  test(`trocar o id do navegador na mesma rede não burla: a rede para em ${HOLD_LIMITS.perNetwork.holds}`, async () => {
    const ip = newNetwork();
    for (let i = 0; i < HOLD_LIMITS.perNetwork.holds; i++) expect(await tryHold(holdClient(ip, randomUUID()))).toMatchObject({ status: 'hold' });
    expect(status(await tryHold(holdClient(ip, randomUUID())))).toBe(429);
    // Outra rede não é afetada.
    expect(await tryHold(holdClient(newNetwork(), randomUUID()))).toMatchObject({ status: 'hold' });
  }, 120_000);

  test(`peças presas por rede têm teto (${maxHeldPieces('perNetwork', CFG.maxPieces)}), mesmo com poucos HOLDs`, async () => {
    const ip = newNetwork();
    const perHold = CFG.maxPieces;
    const holdsToFill = maxHeldPieces('perNetwork', CFG.maxPieces) / perHold;
    for (let i = 0; i < holdsToFill; i++) expect(await tryHold(holdClient(ip, randomUUID()), perHold)).toMatchObject({ status: 'hold' });
    expect(holdsToFill).toBeLessThan(HOLD_LIMITS.perNetwork.holds); // barrado pelas PEÇAS, não pela contagem de HOLDs
    expect(status(await tryHold(holdClient(ip, randomUUID()), 1))).toBe(429);
  }, 90_000);

  test('ataque distribuído (muitas redes): o disjuntor global segura; passada a janela, volta ao normal', async () => {
    const recent = await prisma.reservationEvent.count({
      where: { type: 'HOLD_CLIENT', createdAt: { gt: new Date(Date.now() - HOLD_LIMITS.global.windowMinutes * 60_000) } },
    });
    const missing = Math.max(0, HOLD_LIMITS.global.holds - recent);
    // Simula HOLDs recentes vindos de muitas redes diferentes.
    await prisma.reservationEvent.createMany({
      data: Array.from({ length: missing }, (_, i) => ({ type: 'HOLD_CLIENT', detail: { networkKey: `rede-${i}`, browserKey: `nav-${i}`, synthetic: PREFIX } })),
    });

    const blocked = await tryHold(holdClient(newNetwork(), randomUUID()));
    expect(status(blocked)).toBe(429);
    expect((blocked as Error).message).toBe(HOLD_BUSY_MESSAGE);

    // Janela passou: os eventos simulados envelhecem e o HOLD volta a passar.
    const past = new Date(Date.now() - (HOLD_LIMITS.global.windowMinutes + 1) * 60_000);
    await prisma.$executeRaw`UPDATE reservation_events SET created_at = ${past} WHERE type = 'HOLD_CLIENT' AND detail ->> 'synthetic' = ${PREFIX}`;
    expect(await tryHold(holdClient(newNetwork(), randomUUID()))).toMatchObject({ status: 'hold' });
  }, 60_000);

  test('reenvio com a MESMA Idempotency-Key devolve o HOLD existente — nunca é barrado', async () => {
    const client = holdClient(newNetwork(), randomUUID());
    const request = dto();
    const key = `${PREFIX}-idem-${randomUUID()}`;
    const first = await service.createHold(request, key, client);
    await tryHold(client);
    expect(status(await tryHold(client))).toBe(429); // no limite
    const again = await service.createHold(request, key, client);
    expect(again.reservationId).toBe(first.reservationId);
  }, 60_000);

  test('HOLD vencido não conta: o navegador volta a poder reservar', async () => {
    const client = holdClient(newNetwork(), randomUUID());
    const first = await service.createHold(dto(), undefined, client);
    await tryHold(client);
    expect(status(await tryHold(client))).toBe(429);
    await prisma.$executeRaw`UPDATE reservations SET expires_at = now() - interval '1 minute' WHERE id = ${first.reservationId}::uuid`;
    expect(await tryHold(client)).toMatchObject({ status: 'hold' });
  }, 60_000);

  test('rajada simultânea do mesmo navegador: exatamente 2 passam', async () => {
    const client = holdClient(newNetwork(), randomUUID());
    const results = await Promise.all(Array.from({ length: 6 }, () => tryHold(client)));
    expect(results.filter((r) => !(r instanceof Error))).toHaveLength(HOLD_LIMITS.perBrowser.holds);
    expect(results.filter((r) => status(r) === 429)).toHaveLength(6 - HOLD_LIMITS.perBrowser.holds);
  }, 90_000);

  test('chamada interna sem cliente (fluxo antigo/testes) continua sem limite por cliente', async () => {
    for (let i = 0; i < HOLD_LIMITS.perBrowser.holds + 1; i++) await expect(service.createHold(dto())).resolves.toMatchObject({ status: 'hold' });
  }, 60_000);
});
