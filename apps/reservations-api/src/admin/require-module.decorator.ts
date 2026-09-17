import { SetMetadata } from '@nestjs/common';
import type { AdminModule } from '@prisma/client';

export const REQUIRE_MODULE_KEY = 'requireAdminModule';

/** Marca uma rota como exigindo acesso a um módulo específico (ex.:
 *  'RULES'). SUPER_ADMIN sempre passa, sem consultar `moduleAccess`
 *  (acesso total by design). ADMIN/STAFF só passam se o módulo estiver
 *  na lista `AdminUser.moduleAccess` da conta — concedida pelo
 *  SUPER_ADMIN ao criar/editar o funcionário, nunca implícita no papel.
 *  Ver AdminRoleGuard. */
export const RequireModule = (module: AdminModule) => SetMetadata(REQUIRE_MODULE_KEY, module);
