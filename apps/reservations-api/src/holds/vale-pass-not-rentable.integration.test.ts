import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AvailabilityService } from '../availability/availability.service';
import { HoldsService } from './holds.service';
import { KNOWN_VALE_PASS_VARIANT_ID } from '../vale-pass/vale-pass-order-status';
import { type CivilDate, addDays, civilDateToISO, isSunday } from '../rental-rules/civil-date';
import { calculateReturnDate, isOnlineReservationAllowed, today as engineToday } from '../rental-rules/rental-engine';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';

/**
 * Valle Pass é compra direta e NUNCA entra no aluguel — nem se alguém cadastrar uma peça (RentalUnit) para a variante dele (a produção chegou a ter
 * a unidade "01" ligada à variante do passe). Disponibilidade e HOLD tratam a variante como "sem unidade", no servidor; o controle prova que uma
 * variante comum com a mesma configuração funciona. PostgreSQL LOCAL descartável; nenhum pedido/pagamento.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const rules = new RentalRuleConfigService(prisma);
const availability = new AvailabilityService(prisma, rules);
const holds = new HoldsService(prisma, rules);
const CFG = DEFAULT_RENTAL_RULE_CONFIG;
const PREFIX = `VPNR-${Date.now()}`;
const NORMAL_VARIANT = `${PREFIX}-sobretudo`;
const PASS_GID = `gid://shopify/ProductVariant/${KNOWN_VALE_PASS_VARIANT_ID}`;
const CAMPAIGN_VARIANT = `9${Date.now()}`; // só dígitos: é o formato real das variantes da Shopify
const campaignIds: string[] = [];

function pickup(): CivilDate {
  let d = addDays(engineToday(CFG), 40);
  for (let i = 0; i < 400; i++) {
    if (isOnlineReservationAllowed(d, CFG) && !isSunday(d) && !isSunday(calculateReturnDate(d, 2))) return d;
    d = addDays(d, 1);
  }
  return d;
}

async function cleanup() {
  const ids = (await prisma.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT ri.reservation_id AS id FROM reservation_items ri JOIN rental_units ru ON ru.id = ri.rental_unit_id WHERE ru.code LIKE ${PREFIX + '%'}
  `).map((r) => r.id);
  if (ids.length) {
    await prisma.$executeRaw`DELETE FROM reservation_events WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM hold_idempotency_keys WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservation_items WHERE reservation_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM reservations WHERE id = ANY(${ids}::uuid[])`;
  }
  await prisma.$executeRaw`DELETE FROM rental_units WHERE code LIKE ${PREFIX + '%'}`;
  if (campaignIds.length) await prisma.valePassCampaign.deleteMany({ where: { id: { in: campaignIds } } });
}

const unit = (suffix: string, shopifyVariantId: string) => ({ code: `${PREFIX}-${suffix}`, name: `Peça ${suffix}`, shopifyVariantId, active: true, reservableOnline: true, countsTowardRentalDuration: true });
const hold = (shopifyVariantId: string) => holds.createHold({ items: [{ shopifyVariantId, quantity: 1 }], pickupDate: civilDateToISO(pickup()), termsAccepted: true }).catch((e: unknown) => e);

localDescribe('Valle Pass nunca é alugável (servidor)', () => {
  beforeAll(async () => {
    await cleanup();
    const campaign = await prisma.valePassCampaign.create({ data: { name: `${PREFIX}-camp`, amountCents: 35_000, validityDays: 30, shopifyVariantId: CAMPAIGN_VARIANT } });
    campaignIds.push(campaign.id);
    await prisma.rentalUnit.createMany({
      data: [unit('normal', NORMAL_VARIANT), unit('passe-conhecido', PASS_GID), unit('passe-campanha', `gid://shopify/ProductVariant/${CAMPAIGN_VARIANT}`)],
    });
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  test('controle: variante comum com unidade ativa tem disponibilidade e aceita HOLD', async () => {
    const res = await availability.getAvailability({ shopifyVariantId: NORMAL_VARIANT, countedPieces: 1 });
    expect(res.unitsTotal).toBe(1);
    const created = await hold(NORMAL_VARIANT);
    expect(created instanceof Error).toBe(false);
  });

  test('variante do Valle Pass (conhecida) com unidade cadastrada: disponibilidade responde "sem unidade" (404) e HOLD é recusado (422)', async () => {
    await expect(availability.getAvailability({ shopifyVariantId: PASS_GID, countedPieces: 1 })).rejects.toMatchObject({ status: 404 });
    const rejected = await hold(PASS_GID);
    expect(rejected).toBeInstanceOf(HttpException);
    expect((rejected as HttpException).getStatus()).toBe(422);
  });

  test('variante de uma campanha de Valle Pass também nunca é alugável', async () => {
    const gid = `gid://shopify/ProductVariant/${CAMPAIGN_VARIANT}`;
    await expect(availability.getAvailability({ shopifyVariantId: gid, countedPieces: 1 })).rejects.toMatchObject({ status: 404 });
    const rejected = await hold(gid);
    expect(rejected).toBeInstanceOf(HttpException);
    expect((rejected as HttpException).getStatus()).toBe(422);
  });
});
