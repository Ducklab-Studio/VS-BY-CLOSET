import 'reflect-metadata';
import { describe, expect, test } from 'vitest';
import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { AdminEmployeesController } from './admin-employees/admin-employees.controller';
import { AdminPiecesController } from './admin-panel/pieces.controller';
import { AdminBlocksController } from './admin-panel/blocks.controller';
import { AdminReservationsController } from './admin-reservations/admin-reservations.controller';
import { AdminPdfController } from './pdf/pdf.controller';
import { ReservationArchiveController } from './reservation-archive/reservation-archive.controller';
import { ValePassCampaignsController } from './vale-pass/vale-pass-campaigns.controller';

/**
 * Todo `:id`/`:itemId` das rotas administrativas passa por ParseUUIDPipe ANTES
 * do serviço. Achado real: `PATCH /admin/pieces/:id` respondia 503 e ativar
 * campanha do Valle Pass respondia 500 com um id inválido — o valor chegava ao
 * Postgres como uuid. Este teste lê os metadados reais das rotas: uma rota
 * nova que esquecer a validação falha aqui.
 */
const CONTROLLERS = [
  AdminEmployeesController,
  AdminPiecesController,
  AdminBlocksController,
  AdminReservationsController,
  AdminPdfController,
  ReservationArchiveController,
  ValePassCampaignsController,
];

type RouteArg = { index: number; data?: unknown; pipes?: unknown[] };

function idParams() {
  const found: { route: string; param: string; validated: boolean }[] = [];
  for (const controller of CONTROLLERS) {
    for (const method of Object.getOwnPropertyNames(controller.prototype)) {
      if (method === 'constructor') continue;
      const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller, method) ?? {}) as Record<string, RouteArg>;
      for (const arg of Object.values(args)) {
        if (arg.data !== 'id' && arg.data !== 'itemId') continue;
        const validated = (arg.pipes ?? []).some((pipe) => pipe === ParseUUIDPipe || pipe instanceof ParseUUIDPipe);
        found.push({ route: `${controller.name}.${method}`, param: String(arg.data), validated });
      }
    }
  }
  return found;
}

describe('ids nas rotas administrativas', () => {
  test('todo :id/:itemId é validado como UUID antes do serviço', () => {
    const params = idParams();
    expect(params.length).toBeGreaterThanOrEqual(20);
    expect(params.filter((p) => !p.validated)).toEqual([]);
  });

  test.each(['nao-e-uuid', '../../admin/employees', '..%2F..%2Fadmin', "1' OR '1'='1", '', '3f2a8c1e-9b7d-4e21-8a5f-0c6d2e9b1a47/extra'])(
    'valor malicioso "%s" → 400 antes de chegar ao banco',
    async (value) => {
      await expect(new ParseUUIDPipe().transform(value, { type: 'param', data: 'id' })).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  test('UUID legítimo passa intacto', async () => {
    const id = '3f2a8c1e-9b7d-4e21-8a5f-0c6d2e9b1a47';
    await expect(new ParseUUIDPipe().transform(id, { type: 'param', data: 'id' })).resolves.toBe(id);
  });
});
