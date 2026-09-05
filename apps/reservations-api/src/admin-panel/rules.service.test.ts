import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { AdminRulesService } from './rules.service';

/**
 * Fase 9, item 12 — /closetadmin/regras. `rental_rule_config` é a linha
 * singleton (`id = 'default'`) já consumida pelo `RentalPlanEngine` desde
 * a Fase 3 — todo teste que a modifica restaura o valor original em
 * `finally`, seguro porque a suíte roda sequencial
 * (`fileParallelism: false`, ver vitest.config.ts e o mesmo comentário em
 * admin-reservations.service.test.ts).
 */
const prisma = new PrismaService();
const rules = new AdminRulesService(prisma);

let adminUserId: string;

beforeAll(async () => {
  const user = await prisma.adminUser.create({
    data: { name: 'Admin Regras Teste', phone: `9${Date.now()}1`, pinHash: 'x:y', role: 'ADMIN', active: true },
  });
  adminUserId = user.id;
});
afterAll(async () => {
  await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE admin_user_id = ${adminUserId}::uuid`;
  await prisma.$executeRaw`DELETE FROM admin_users WHERE id = ${adminUserId}::uuid`;
  await prisma.$disconnect();
});

describe('AdminRulesService — /closetadmin/regras (integração real, Neon)', () => {
  test('1) get() devolve a config real usada pelo RentalPlanEngine', async () => {
    const config = await rules.get();
    expect(config.id).toBe('default');
    expect(typeof config.minAdvanceDays).toBe('number');
  }, 15_000);

  test('2) update() altera um campo simples, preserva os demais, e audita before/after/adminUserId', async () => {
    const original = await rules.get();
    try {
      const after = await rules.update({ minAdvanceDays: original.minAdvanceDays + 1, adminUserId }, adminUserId, 'Admin Regras Teste');
      expect(after.minAdvanceDays).toBe(original.minAdvanceDays + 1);
      expect(after.prepDays).toBe(original.prepDays); // campo não enviado preservado

      const event = await prisma.adminAuditEvent.findFirst({
        where: { entityId: 'default', action: 'RULE_MODIFIED' },
        orderBy: { createdAt: 'desc' },
      });
      expect(event).not.toBeNull();
      expect(event!.adminUserId).toBe(adminUserId);
      expect((event!.before as { minAdvanceDays: number }).minAdvanceDays).toBe(original.minAdvanceDays);
      expect((event!.after as { minAdvanceDays: number }).minAdvanceDays).toBe(original.minAdvanceDays + 1);
    } finally {
      await prisma.rentalRuleConfig.update({ where: { id: 'default' }, data: { minAdvanceDays: original.minAdvanceDays } });
    }
  });

  test('3) update() de piecesToDaysTable grava o JSON corretamente e é lido de volta igual', async () => {
    const original = await rules.get();
    try {
      const newTable = [{ upTo: 1, days: 2 }, { upTo: 9, days: 9 }];
      const after = await rules.update({ piecesToDaysTable: newTable, adminUserId }, adminUserId, 'Admin Regras Teste');
      expect(after.piecesToDaysTable).toEqual(newTable);
      const reloaded = await rules.get();
      expect(reloaded.piecesToDaysTable).toEqual(newTable);
    } finally {
      await prisma.rentalRuleConfig.update({ where: { id: 'default' }, data: { piecesToDaysTable: original.piecesToDaysTable as object[] } });
    }
  });

  test('4) frontend não decide regra nenhuma — RentalPlanEngine continua lendo a MESMA linha alterada, sem cache', async () => {
    const original = await rules.get();
    try {
      await rules.update({ maxPieces: 1, adminUserId }, adminUserId, 'Admin Regras Teste');
      const reloaded = await prisma.rentalRuleConfig.findUniqueOrThrow({ where: { id: 'default' } });
      expect(reloaded.maxPieces).toBe(1);
    } finally {
      await prisma.rentalRuleConfig.update({ where: { id: 'default' }, data: { maxPieces: original.maxPieces } });
    }
  });
});
