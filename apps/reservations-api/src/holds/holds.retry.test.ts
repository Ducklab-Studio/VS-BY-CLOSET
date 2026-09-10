import { describe, expect, test, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { HoldsService, type AttemptContext, type HoldResponse } from './holds.service';
import type { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import type { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_RENTAL_RULE_CONFIG } from '../rental-rules/rental-rule-config';
import { addDays, isSunday } from '../rental-rules/civil-date';
import { isOnlineReservationAllowed, today as engineToday, calculateReturnDate } from '../rental-rules/rental-engine';
import type { CreateHoldDto } from './dto/create-hold.dto';

/**
 * Cobre os itens 10, 11, 21 e 22 da lista de concorrência da Fase 5 —
 * exatamente os quatro que exigem uma falha NO MEIO de uma transação já
 * em andamento (conflito de EXCLUDE depois do FOR UPDATE já ter
 * liberado, ou uma queda de conexão entre dois INSERTs). O desenho real
 * (FOR UPDATE serializando por variante, provado nos 7 cenários de
 * holds.concurrency.integration.test.ts) torna isso deliberadamente raro
 * de reproduzir por timing — não existe um jeito confiável de forçar o
 * Postgres real a errar exatamente ali. Aqui a falha é INJETADA: o que
 * se prova não é "o banco se comporta assim" (isso é garantia do próprio
 * Postgres/Prisma — uma transação interativa que lança erro sempre dá
 * ROLLBACK completo, documentado e não é responsabilidade deste código
 * reimplementar), e sim que HOLDSSERVICE REAGE certo quando isso
 * acontece: retenta o que deve ser retentado, desiste do que não deve, e
 * nunca engole um erro no meio do laço de INSERTs.
 */

type TestableHoldsService = Omit<HoldsService, 'attemptCreateHold'> & {
  attemptCreateHold: (tx: Prisma.TransactionClient, ctx: AttemptContext) => Promise<HoldResponse>;
};

function fakeConfigService(): RentalRuleConfigService {
  return { load: vi.fn().mockResolvedValue(DEFAULT_RENTAL_RULE_CONFIG) } as unknown as RentalRuleConfigService;
}

function fakePrisma(): PrismaService {
  return { $transaction: vi.fn((cb: (tx: undefined) => unknown) => cb(undefined)) } as unknown as PrismaService;
}

function validDto(variantId: string): CreateHoldDto {
  return { items: [{ shopifyVariantId: variantId, quantity: 1 }], pickupDate: '2027-11-10', termsAccepted: true };
}

const EXCLUDE_ERROR = new Error(
  'ERROR: conflicting key value violates exclusion constraint "reservation_items_no_overlap_per_unit"',
);

describe('HoldsService — retry e rollback (fault injection, item 10/11/21 da Fase 5)', () => {
  test('10) conflito de EXCLUDE na 1ª tentativa, sucesso na 2ª → devolve o resultado da tentativa que teve sucesso', async () => {
    const service = new HoldsService(fakePrisma(), fakeConfigService());
    const testable = service as unknown as TestableHoldsService;
    const successResponse: HoldResponse = {
      reservationId: 'r-success',
      status: 'hold',
      holdToken: 'fake-token-for-test',
      expiresAt: new Date().toISOString(),
      pickupDate: '2027-11-10',
      calculatedReturnDate: '2027-11-12',
      effectiveReturnDate: '2027-11-12',
      durationDays: 2,
      items: [{ shopifyVariantId: 'v', quantity: 1 }],
    };
    const attemptMock = vi.fn().mockRejectedValueOnce(EXCLUDE_ERROR).mockResolvedValueOnce(successResponse);
    testable.attemptCreateHold = attemptMock;

    const res = await service.createHold(validDto('v'));
    expect(res.reservationId).toBe('r-success');
    expect(attemptMock).toHaveBeenCalledTimes(2);
  });

  test('11) conflito de EXCLUDE esgota as tentativas → 409, número de tentativas é o limite explícito (3), nunca infinito', async () => {
    const service = new HoldsService(fakePrisma(), fakeConfigService());
    const testable = service as unknown as TestableHoldsService;
    const attemptMock = vi.fn().mockRejectedValue(EXCLUDE_ERROR);
    testable.attemptCreateHold = attemptMock;

    await expect(service.createHold(validDto('v'))).rejects.toMatchObject({ status: 409 });
    expect(attemptMock).toHaveBeenCalledTimes(3);
  });

  test('capacidade insuficiente NÃO é retentada (diferente de conflito de EXCLUDE) — só 1 tentativa', async () => {
    const service = new HoldsService(fakePrisma(), fakeConfigService());
    const testable = service as unknown as TestableHoldsService;
    // Importa a classe de erro real (não uma string genérica) — é o que
    // o service de fato lança antes de qualquer INSERT quando a conta de
    // unidades livres não fecha.
    const { InsufficientCapacityError } = await import('./holds.errors');
    const attemptMock = vi.fn().mockRejectedValue(new InsufficientCapacityError(['v']));
    testable.attemptCreateHold = attemptMock;

    await expect(service.createHold(validDto('v'))).rejects.toMatchObject({ status: 409 });
    expect(attemptMock).toHaveBeenCalledTimes(1); // retentar não mudaria o resultado
  });

  test('21) erro de banco genérico no meio da tentativa → 503, uma única tentativa, mensagem ao cliente não vaza detalhe interno', async () => {
    const service = new HoldsService(fakePrisma(), fakeConfigService());
    const testable = service as unknown as TestableHoldsService;
    const rawDbError = new Error('connection terminated unexpectedly (socket hang up) — internal host 10.0.4.12');
    const attemptMock = vi.fn().mockRejectedValue(rawDbError);
    testable.attemptCreateHold = attemptMock;

    let caught: unknown;
    try {
      await service.createHold(validDto('v'));
    } catch (err) {
      caught = err;
    }
    expect(caught).toMatchObject({ status: 503 });
    expect(attemptMock).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(caught)).not.toContain('10.0.4.12');
    expect(JSON.stringify(caught)).not.toContain('socket hang up');
  });

  test('22) erro ao inserir o SEGUNDO ReservationItem → attemptCreateHold rejeita sem engolir o erro (o 1º insert não fica "esquecido" num sucesso parcial)', async () => {
    const variant = 'retry-second-item-variant';
    const service = new HoldsService(fakePrisma(), fakeConfigService());
    const testable = service as unknown as TestableHoldsService;

    let executeRawCalls = 0;
    const secondInsertError = new Error('erro simulado no 2º INSERT de reservation_items');
    const fakeTx = {
      store: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          id: 'dev-store',
          shopifyDomain: 'dev-store.myshopify.com',
          currency: 'CLP',
        }),
      },
      $executeRaw: vi.fn(async (sql: TemplateStringsArray) => {
        if (!sql.join('').includes('INSERT INTO reservation_items')) return 1;
        executeRawCalls += 1;
        // Count item inserts only; lock/expiry statements are independent.
        if (executeRawCalls === 2) throw secondInsertError;
        return 1;
      }),
      $queryRaw: vi
        .fn()
        .mockResolvedValueOnce([{ shopifyVariantId: variant, reservableOnline: true, countsTowardRentalDuration: true, unitCount: 2 }])
        .mockResolvedValueOnce([
          { id: 'unit-1', shopifyVariantId: variant },
          { id: 'unit-2', shopifyVariantId: variant },
        ])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'resv-1', expiresAt: new Date() }]),
    } as unknown as Prisma.TransactionClient;

    const pickupDate = pickupSafeFarFuture();
    const ctx: AttemptContext = {
      normalizedItems: [{ shopifyVariantId: variant, quantity: 2 }],
      pickupDate,
      sundayReturnOption: null,
      config: DEFAULT_RENTAL_RULE_CONFIG,
      today: engineToday(DEFAULT_RENTAL_RULE_CONFIG),
      store: { id: 'dev-store', shopifyDomain: 'dev-store.myshopify.com', currency: 'CLP' },
      termsVersion: 'v1',
      idempotencyKey: undefined,
      requestHash: null,
      holdToken: 'fake-token-for-test',
      holdTokenHash: 'fake-hash-for-test',
    };

    await expect(testable.attemptCreateHold(fakeTx, ctx)).rejects.toBe(secondInsertError);
    // As DUAS inserções de item foram tentadas (não parou depois da 1ª
    // silenciosamente) — a exceção da 2ª propagou sem ser capturada por
    // nenhum catch-and-continue no laço. É essa propagação, combinada
    // com a garantia real do Prisma ($transaction dá ROLLBACK completo
    // quando o callback lança), que impede o 1º item de "sobrar" sozinho
    // no banco de verdade.
    expect(executeRawCalls).toBe(2);
  });
});

function pickupSafeFarFuture() {
  const cfg = DEFAULT_RENTAL_RULE_CONFIG;
  let d = addDays(engineToday(cfg), 60);
  // Este cenário pede 2 peças, portanto a duração real é 2 dias. O teste
  // precisa evitar domingo usando a mesma duração que o motor vai calcular;
  // usar 3 aqui deixava o resultado dependente do dia em que a suíte rodava.
  for (let i = 0; i < 400 && (!isOnlineReservationAllowed(d, cfg) || isSunday(d) || isSunday(calculateReturnDate(d, 2))); i++) {
    d = addDays(d, 1);
  }
  return d;
}
