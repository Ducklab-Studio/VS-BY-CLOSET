import { describe, expect, test, vi } from 'vitest';
import { AvailabilityService } from './availability.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';

/**
 * FAIL CLOSED: "banco indisponível" nunca pode virar "disponível" pro
 * cliente. Isto não é testável com o banco real ligado (não vou derrubar
 * o Neon de propósito pra provar isso) — por isso injeta dependências
 * falsas que simulam a falha, em vez de um flag de "simular erro" na API
 * pública (que seria, ele mesmo, um risco de segurança desnecessário).
 */

function brokenPrisma(): PrismaService {
  return {
    rentalUnit: { findMany: vi.fn().mockRejectedValue(new Error('connection refused')) },
    $queryRaw: vi.fn().mockRejectedValue(new Error('connection refused')),
  } as unknown as PrismaService;
}

function workingConfig(): RentalRuleConfigService {
  return { load: vi.fn().mockResolvedValue(DEFAULT_RENTAL_RULE_CONFIG) } as unknown as RentalRuleConfigService;
}

function brokenConfig(): RentalRuleConfigService {
  return { load: vi.fn().mockRejectedValue(new Error('connection refused')) } as unknown as RentalRuleConfigService;
}

describe('AvailabilityService — FAIL CLOSED quando o banco falha', () => {
  test('rental_rule_config indisponível → 503, nunca disponibilidade inventada', async () => {
    const service = new AvailabilityService(brokenPrisma(), brokenConfig());
    await expect(service.getAvailability({ shopifyVariantId: 'x', countedPieces: 1 })).rejects.toMatchObject({
      status: 503,
    });
  });

  test('consulta de rental_units falha → 503, nunca "nenhuma unidade" nem disponibilidade fake', async () => {
    const service = new AvailabilityService(brokenPrisma(), workingConfig());
    await expect(service.getAvailability({ shopifyVariantId: 'x', countedPieces: 1 })).rejects.toMatchObject({
      status: 503,
    });
  });

  test('consulta de reservation_items falha → 503, nunca "tudo livre" por padrão', async () => {
    const prisma = {
      rentalUnit: {
        findMany: vi.fn().mockResolvedValue([{ id: 'unit-1', reservableOnline: true }]),
      },
      $queryRaw: vi.fn().mockRejectedValue(new Error('connection refused')),
    } as unknown as PrismaService;

    const service = new AvailabilityService(prisma, workingConfig());
    await expect(service.getAvailability({ shopifyVariantId: 'x', countedPieces: 1 })).rejects.toMatchObject({
      status: 503,
    });
  });

  test('a mensagem de erro devolvida ao cliente não vaza detalhe de infraestrutura', async () => {
    const service = new AvailabilityService(brokenPrisma(), brokenConfig());
    try {
      await service.getAvailability({ shopifyVariantId: 'x', countedPieces: 1 });
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      const message = (err as { message?: string }).message ?? '';
      // Nunca stack trace, nunca a string de conexão, nunca o erro
      // original do driver — só a mensagem genérica pro cliente.
      expect(message).not.toMatch(/postgres|connection refused|at\s+\w+\.\w+\s+\(/i);
    }
  });
});
