import { afterAll, describe, expect, test, vi } from 'vitest';
import { RentalPlanService } from './rental-plan.service';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';

/**
 * Integração real contra o Neon pra confirmar que a duração devolvida
 * é EXATAMENTE a mesma tabela que `rental-engine.test.ts` já prova —
 * não uma cópia. Não precisa de fixture nenhum: só lê a config
 * singleton que já existe desde a Fase 4.
 */
const prisma = new PrismaService();
const service = new RentalPlanService(new RentalRuleConfigService(prisma));

afterAll(() => prisma.$disconnect());

describe('RentalPlanService — integração real (Neon)', () => {
  const cases: [number, number][] = [
    [1, 2],
    [2, 2],
    [3, 3],
    [4, 3],
    [5, 4],
    [6, 4],
  ];

  for (const [pieces, days] of cases) {
    test(`${pieces} peça(s) → ${days} dias (config real do banco)`, async () => {
      const result = await service.getDuration(pieces);
      expect(result).toEqual({ countedPieces: pieces, durationDays: days });
    });
  }
});

describe('RentalPlanService — fail closed', () => {
  test('rental_rule_config indisponível → 503', async () => {
    const brokenConfig = { load: vi.fn().mockRejectedValue(new Error('connection refused')) } as unknown as RentalRuleConfigService;
    const brokenService = new RentalPlanService(brokenConfig);
    await expect(brokenService.getDuration(2)).rejects.toMatchObject({ status: 503 });
  });
});
