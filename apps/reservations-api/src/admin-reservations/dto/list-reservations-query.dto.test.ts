import { describe, expect, test } from 'vitest';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { ListReservationsQueryDto } from './list-reservations-query.dto';
import { CalendarQueryDto } from '../../admin-panel/dto/calendar-query.dto';
import { AdminReservationsController } from '../admin-reservations.controller';
import { ReservationAttentionService } from '../reservation-attention.service';
import type { AdminReservationsService } from '../admin-reservations.service';

/** Mesmo pipe global de main.ts, aplicado como o Nest aplica em `@Query()`. */
const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
const parse = (query: Record<string, unknown>) => pipe.transform(query, { type: 'query', metatype: ListReservationsQueryDto });

describe('GET /admin/reservations — filtros validados antes do banco (400, não 503)', () => {
  test('os filtros que o painel envia continuam aceitos', async () => {
    await expect(
      parse({
        adminUserId: '3f2a8c1e-9b7d-4e21-8a5f-0c6d2e9b1a47',
        status: 'confirmed',
        source: 'manual_admin',
        from: '2026-10-01',
        to: '2026-10-31',
        customer: 'Maria',
        phone: '+56 9 1234',
        unitCode: 'VS-SOB',
        code: '3f2a8c1e',
        includeArchived: 'true',
        archivedOnly: 'false',
      }),
    ).resolves.toBeInstanceOf(ListReservationsQueryDto);
    await expect(parse({})).resolves.toBeInstanceOf(ListReservationsQueryDto);
  });

  test.each([
    ['status inexistente', { status: 'aprovada' }],
    ['status com injeção', { status: "confirmed'; DROP TABLE reservations;--" }],
    ['origem inexistente', { source: 'shopify' }],
    ['data inválida', { from: '31/10/2026' }],
    ['data com texto', { to: '2026-10-31 OR 1=1' }],
    ['parâmetro repetido (vira array)', { status: ['confirmed', 'cancelled'] }],
    ['código com curinga', { code: '%' }],
    ['texto gigante', { customer: 'x'.repeat(5000) }],
    ['booleano inválido', { includeArchived: 'sim' }],
    ['parâmetro desconhecido', { orderBy: 'id' }],
    ['adminUserId que não é UUID', { adminUserId: 'admin' }],
    ['data que não existe (31/02)', { from: '2026-02-31' }],
    ['mês 13', { to: '2026-13-01' }],
    ['data com hora', { from: '2026-10-01T00:00:00Z' }],
    ['data repetida (array)', { from: ['2026-10-01', '2026-10-02'] }],
    ['limit zero', { limit: '0' }],
    ['limit acima do teto', { limit: '301' }],
    ['limit texto', { limit: 'abc' }],
    ['limit repetido', { limit: ['10', '20'] }],
    ['offset negativo', { offset: '-1' }],
    ['offset fracionado', { offset: '1.5' }],
  ])('%s → 400', async (_label, query) => {
    await expect(parse(query)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('paginação e período da listagem', () => {
  test('limit/offset válidos chegam como número; sem eles, o padrão de sempre', async () => {
    const dto = (await parse({ limit: '50', offset: '100' })) as ListReservationsQueryDto;
    expect(dto).toMatchObject({ limit: 50, offset: 100 });
  });

  test('"from" depois de "to" → 400 antes de consultar', () => {
    const service = { listReservations: () => { throw new Error('não deveria consultar'); } } as unknown as AdminReservationsService;
    const controller = new AdminReservationsController(service, {} as unknown as ReservationAttentionService);
    expect(() => controller.list(Object.assign(new ListReservationsQueryDto(), { from: '2026-10-31', to: '2026-10-01' }))).toThrow(BadRequestException);
  });
});

describe('GET /admin/calendar — datas validadas (antes: 500)', () => {
  const parseCalendar = (query: Record<string, unknown>) => pipe.transform(query, { type: 'query', metatype: CalendarQueryDto });

  test('período válido passa', async () => {
    await expect(parseCalendar({ from: '2026-10-01', to: '2026-10-31' })).resolves.toBeInstanceOf(CalendarQueryDto);
  });

  test.each([
    ['sem datas', {}],
    ['sem to', { from: '2026-10-01' }],
    ['data inválida', { from: 'ontem', to: '2026-10-31' }],
    ['data impossível', { from: '2026-02-30', to: '2026-03-01' }],
    ['parâmetro desconhecido', { from: '2026-10-01', to: '2026-10-31', debug: '1' }],
  ])('%s → 400', async (_label, query) => {
    await expect(parseCalendar(query)).rejects.toBeInstanceOf(BadRequestException);
  });
});
