import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { AdminRulesService } from './rules.service';

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

describe('AdminRulesService — /closetadmin/regras', () => {
  test('1) get() devolve a config real usada pelo motor', async () => {
    const config = await rules.get();
    expect(config.id).toBe('default');
    expect(typeof config.minAdvanceDays).toBe('number');
  }, 15_000);

  test('2) update() altera campo, preserva os demais e audita before/after', async () => {
    const original = await rules.get();
    try {
      const after = await rules.update(
        { minAdvanceDays: original.minAdvanceDays + 1, adminUserId },
        adminUserId,
        'Admin Regras Teste',
      );
      expect(after.minAdvanceDays).toBe(original.minAdvanceDays + 1);
      expect(after.prepDays).toBe(original.prepDays);

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

  test('3) update() grava piecesToDaysTable válida e lê de volta igual', async () => {
    const original = await rules.get();
    try {
      const newTable = [{ upTo: 1, days: 2 }, { upTo: 9, days: 9 }];
      const after = await rules.update(
        { maxPieces: Math.min(original.maxPieces, 9), piecesToDaysTable: newTable, adminUserId },
        adminUserId,
        'Admin Regras Teste',
      );
      expect(after.piecesToDaysTable).toEqual(newTable);
      const reloaded = await rules.get();
      expect(reloaded.piecesToDaysTable).toEqual(newTable);
    } finally {
      await prisma.rentalRuleConfig.update({
        where: { id: 'default' },
        data: { maxPieces: original.maxPieces, piecesToDaysTable: original.piecesToDaysTable as object[] },
      });
    }
  });

  test('4) maxPieces continua vindo da mesma linha do banco, sem cache', async () => {
    const original = await rules.get();
    try {
      const table = [{ upTo: 1, days: 2 }];
      await rules.update({ maxPieces: 1, piecesToDaysTable: table, adminUserId }, adminUserId, 'Admin Regras Teste');
      const reloaded = await prisma.rentalRuleConfig.findUniqueOrThrow({ where: { id: 'default' } });
      expect(reloaded.maxPieces).toBe(1);
    } finally {
      await prisma.rentalRuleConfig.update({
        where: { id: 'default' },
        data: { maxPieces: original.maxPieces, piecesToDaysTable: original.piecesToDaysTable as object[] },
      });
    }
  });

  test('5) rejeita tabela que não cobre o maxPieces e não persiste nada', async () => {
    const original = await rules.get();
    await expect(
      rules.update(
        { maxPieces: 4, piecesToDaysTable: [{ upTo: 2, days: 2 }], adminUserId },
        adminUserId,
        'Admin Regras Teste',
      ),
    ).rejects.toMatchObject({ status: 422 });

    const reloaded = await rules.get();
    expect(reloaded.maxPieces).toBe(original.maxPieces);
    expect(reloaded.piecesToDaysTable).toEqual(original.piecesToDaysTable);
  });

  test('6) rejeita faixas fora de ordem, mas não exige dias crescentes', async () => {
    const original = await rules.get();

    await expect(
      rules.update(
        {
          maxPieces: 4,
          piecesToDaysTable: [{ upTo: 4, days: 2 }, { upTo: 2, days: 5 }],
          adminUserId,
        },
        adminUserId,
        'Admin Regras Teste',
      ),
    ).rejects.toMatchObject({ status: 422 });

    try {
      const validNonMonotonicDays = [{ upTo: 2, days: 5 }, { upTo: 4, days: 2 }];
      const after = await rules.update(
        { maxPieces: 4, piecesToDaysTable: validNonMonotonicDays, adminUserId },
        adminUserId,
        'Admin Regras Teste',
      );
      expect(after.piecesToDaysTable).toEqual(validNonMonotonicDays);
    } finally {
      await prisma.rentalRuleConfig.update({
        where: { id: 'default' },
        data: { maxPieces: original.maxPieces, piecesToDaysTable: original.piecesToDaysTable as object[] },
      });
    }
  });

  test('7) regra e auditoria são atômicas: falha no audit faz rollback da regra', async () => {
    const original = await rules.get();
    const invalidAdminUserId = '00000000-0000-0000-0000-000000000001';
    const nextAdvance = original.minAdvanceDays === 365 ? 364 : original.minAdvanceDays + 1;

    await expect(
      rules.update(
        { minAdvanceDays: nextAdvance, adminUserId: invalidAdminUserId },
        invalidAdminUserId,
        'Admin inexistente',
      ),
    ).rejects.toMatchObject({ status: 503 });

    const reloaded = await rules.get();
    expect(reloaded.minAdvanceDays).toBe(original.minAdvanceDays);
  });
});
