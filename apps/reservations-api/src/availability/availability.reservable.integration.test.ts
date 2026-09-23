import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RentalRuleConfigService } from '../rental-rule-config/rental-rule-config.service';
import { AvailabilityService } from './availability.service';
import { AvailabilityController } from './availability.controller';
import { ReservableVariantsQueryDto } from './dto/reservable-variants-query.dto';

/**
 * Correção do bug reportado: uma variante sem NENHUMA peça física ativa e
 * reservável continuava aparecendo disponível no site (o catálogo/página
 * pública nunca consultava peça física nenhuma). `getReservableVariants`
 * é a checagem em lote, sem data, que o frontend público passa a usar.
 *
 * Banco Postgres local/efêmero, dados sintéticos com prefixo próprio.
 * Nenhum HOLD, reserva ou pedido real — só leitura (SELECT).
 */
const prisma = new PrismaService();
const rules = new RentalRuleConfigService(prisma);
const service = new AvailabilityService(prisma, rules);
const controller = new AvailabilityController(service);

const PREFIX = `avail-reservable-${Date.now()}`;
let unitCounter = 0;

async function createUnit(opts: { variantId: string; active?: boolean; reservableOnline?: boolean }) {
  const code = `${PREFIX}-u${unitCounter++}`;
  return prisma.rentalUnit.create({
    data: {
      code,
      name: 'Peça de teste',
      shopifyVariantId: opts.variantId,
      active: opts.active ?? true,
      reservableOnline: opts.reservableOnline ?? true,
      countsTowardRentalDuration: true,
    },
  });
}

async function cleanup() {
  await prisma.rentalUnit.deleteMany({ where: { code: { startsWith: PREFIX } } });
}

describe('AvailabilityService.getReservableVariants — variante sem peça física não aparece como reservável (PostgreSQL isolado)', () => {
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  }, 60_000);

  test('1) variante com peça ativa e reservável aparece na lista', async () => {
    const variantId = `${PREFIX}-active`;
    await createUnit({ variantId });
    const { reservable } = await service.getReservableVariants([variantId]);
    expect(reservable).toEqual([variantId]);
  });

  test('2/3) variante sem nenhuma peça ativa não aparece — nem no lote, nem em /availability (404, não reserváel)', async () => {
    const variantId = `${PREFIX}-deactivated`;
    await createUnit({ variantId, active: false });
    const { reservable } = await service.getReservableVariants([variantId]);
    expect(reservable).not.toContain(variantId);

    await expect(service.getAvailability({ shopifyVariantId: variantId, countedPieces: 1 })).rejects.toBeInstanceOf(NotFoundException);
  });

  test('variante nunca cadastrada (nenhuma RentalUnit) também não aparece — sem erro, só ausente', async () => {
    const { reservable } = await service.getReservableVariants([`${PREFIX}-never-linked`]);
    expect(reservable).toEqual([]);
  });

  test('4) variante com uma peça desativada e outra ainda ativa continua reservável', async () => {
    const variantId = `${PREFIX}-mixed`;
    const keepActive = await createUnit({ variantId });
    await createUnit({ variantId, active: false });

    const { reservable } = await service.getReservableVariants([variantId]);
    expect(reservable).toEqual([variantId]);

    const availability = await service.getAvailability({ shopifyVariantId: variantId, countedPieces: 1 });
    expect(availability.unitsTotal).toBe(1); // só a unidade ainda ativa conta
    expect(keepActive.active).toBe(true);
  });

  test('peça ativa mas só em loja (reservableOnline=false) não conta como reservável online', async () => {
    const variantId = `${PREFIX}-store-only`;
    await createUnit({ variantId, reservableOnline: false });
    const { reservable } = await service.getReservableVariants([variantId]);
    expect(reservable).not.toContain(variantId);
  });

  test('consulta em lote: cada variante avaliada independentemente, sem vazar estado entre elas', async () => {
    const ok = `${PREFIX}-batch-ok`;
    const off = `${PREFIX}-batch-off`;
    await createUnit({ variantId: ok });
    await createUnit({ variantId: off, active: false });

    const { reservable } = await service.getReservableVariants([ok, off, `${PREFIX}-batch-unknown`]);
    expect(reservable).toEqual([ok]);
  });

  test('lista vazia não bate no banco e devolve vazio', async () => {
    expect(await service.getReservableVariants([])).toEqual({ reservable: [] });
  });

  test('controller: GET /availability/reservable aplica o DTO (string separada por vírgula, dedup e trim)', async () => {
    const variantId = `${PREFIX}-controller`;
    await createUnit({ variantId });
    const dto = new ReservableVariantsQueryDto();
    dto.shopifyVariantIds = [` ${variantId} `, variantId, variantId].map((v) => v.trim());
    const result = await controller.reservable({ shopifyVariantIds: [...new Set(dto.shopifyVariantIds)] });
    expect(result.reservable).toEqual([variantId]);
  });

  test('lote grande demais (>100) é rejeitado pelo DTO antes de chegar ao serviço', async () => {
    const raw = Array.from({ length: 101 }, (_, i) => `v${i}`).join(',');
    const { validate } = await import('class-validator');
    const { plainToInstance } = await import('class-transformer');
    const dto = plainToInstance(ReservableVariantsQueryDto, { shopifyVariantIds: raw });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});
