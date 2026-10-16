import 'reflect-metadata';
import { describe, expect, test } from 'vitest';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { REQUIRE_MODULE_KEY } from '../admin/require-module.decorator';
import { AdminReservationsController } from './admin-reservations.controller';
import type { PaymentAlertsService } from './payment-alerts.service';

/**
 * A rota usa a MESMA autenticação/autorização das outras rotas do módulo: sessão de equipe validada
 * (AdminAuthGuard, na classe) + módulo RESERVATIONS (AdminRoleGuard). Nenhuma rota pública.
 */
describe('GET /admin/reservations/payment-alerts — proteção', () => {
  const handler = AdminReservationsController.prototype.listPaymentAlerts;

  test('exige sessão de equipe (guard da classe), AdminRoleGuard e o módulo RESERVATIONS', () => {
    expect(Reflect.getMetadata('__guards__', AdminReservationsController)).toContain(AdminAuthGuard);
    expect(Reflect.getMetadata('__guards__', handler)).toContain(AdminRoleGuard);
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, handler)).toBe('RESERVATIONS');
  });

  test('é GET em "payment-alerts", rota fixa (declarada antes de ":id")', () => {
    expect(Reflect.getMetadata('method', handler)).toBe(0); // RequestMethod.GET
    expect(Reflect.getMetadata('path', handler)).toBe('payment-alerts');
    // O Nest registra as rotas na ordem de declaração: ":id" (parâmetro) precisa vir depois das rotas fixas.
    const paths = Object.getOwnPropertyNames(AdminReservationsController.prototype)
      .filter((name) => name !== 'constructor')
      .map((name) => Reflect.getMetadata('path', (AdminReservationsController.prototype as unknown as Record<string, object>)[name]) as string | undefined);
    const fixed = paths.indexOf('payment-alerts');
    const byId = paths.indexOf(':id');
    expect(fixed).toBeGreaterThanOrEqual(0);
    expect(byId).toBeGreaterThan(fixed);
  });

  test('delega ao serviço de leitura e devolve o resultado sem transformar', async () => {
    const result = { count: 1, alerts: [] };
    const controller = new AdminReservationsController({} as never, {} as never, { list: async () => result } as unknown as PaymentAlertsService);
    await expect(controller.listPaymentAlerts()).resolves.toBe(result);
  });
});
