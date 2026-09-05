import 'reflect-metadata';
import { describe, expect, test } from 'vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { REQUIRE_ROLE_KEY } from '../admin/require-role.decorator';
import { AdminPdfController } from './pdf.controller';

/**
 * Fase 10, item 6/8 — "somente usuário autenticado pode gerar PDF" /
 * "respeitar RBAC" / "usuário sem sessão → bloqueado" / "STAFF/ADMIN
 * conforme permissão". Os guards aplicados aqui (`AdminAuthGuard`,
 * `AdminRoleGuard`) são os MESMOS já exaustivamente testados
 * (admin-token.test.ts, admin-role.guard.test.ts) — nenhuma lógica de
 * autorização nova foi escrita pro PDF. Este teste confirma a FORMA do
 * contrato (que o controller de fato declara esses guards, na classe
 * inteira, sem `@RequireRole` em nenhuma rota — ou seja, aberto a
 * qualquer admin ativo, STAFF incluso, igual à tela de detalhe de
 * reserva/calendário) em vez de reimplementar o comportamento do guard.
 */
describe('AdminPdfController — guards de segurança', () => {
  test('1) a classe inteira exige AdminAuthGuard (bearer) + AdminRoleGuard (sessão/role revalidada)', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, AdminPdfController) as unknown[];
    expect(guards).toContain(AdminAuthGuard);
    expect(guards).toContain(AdminRoleGuard);
  });

  test('2) nenhuma rota exige @RequireRole("ADMIN") — STAFF e ADMIN ativos podem gerar (mesmo nível de acesso de ver reserva/calendário)', () => {
    const prototype = AdminPdfController.prototype;
    for (const method of ['reservationPdfRoute', 'periodReportRoute', 'operationalReportRoute'] as const) {
      const role = Reflect.getMetadata(REQUIRE_ROLE_KEY, prototype[method]);
      expect(role).toBeUndefined();
    }
  });
});
