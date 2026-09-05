import { SetMetadata } from '@nestjs/common';
import type { AdminRole } from '@prisma/client';

export const REQUIRE_ROLE_KEY = 'requireAdminRole';

/** Marca uma rota como exigindo um role específico (ex.: 'ADMIN'). Sem
 *  este decorator, `AdminRoleGuard` só exige um AdminUser ativo válido
 *  (qualquer role) — item 15: STAFF acessa o que é comum, ADMIN acessa
 *  regras/peças/bloqueios/auditoria completa. */
export const RequireRole = (role: AdminRole) => SetMetadata(REQUIRE_ROLE_KEY, role);
