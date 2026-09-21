import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireModule } from '../admin/require-module.decorator';
import { RequireRole } from '../admin/require-role.decorator';
import { ReconcileShopifyOrdersDto } from './reconcile-shopify-orders.dto';
import { ShopifyReconciliationService, type ReconciliationReport } from './shopify-reconciliation.service';

const DEFAULT_DAYS = 30;

/**
 * Bearer do servidor + sessão administrativa válida + ADMIN com módulo
 * RESERVATIONS. O ator vem da sessão; nada administrativo vem do corpo.
 */
@Controller('admin/reconciliation/shopify-orders')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireRole('ADMIN')
@RequireModule('RESERVATIONS')
@Throttle({ default: { limit: 6, ttl: 60_000 } })
export class ShopifyReconciliationController {
  constructor(private readonly reconciliation: ShopifyReconciliationService) {}

  /** Só lê e compara. Não altera nada. */
  @Get()
  report(@Query() query: ReconcileShopifyOrdersDto): Promise<ReconciliationReport> {
    return this.reconciliation.reconcile({ days: query.days ?? DEFAULT_DAYS, apply: false });
  }

  /** Aplica o subconjunto seguro (cancelar, expirar, arquivar) pelas regras dos webhooks. */
  @Post('apply')
  @HttpCode(HttpStatus.OK)
  apply(@Body() dto: ReconcileShopifyOrdersDto, @Req() request: { adminUser: { id: string; name: string } }): Promise<ReconciliationReport> {
    return this.reconciliation.reconcile({ days: dto.days ?? DEFAULT_DAYS, apply: true, actor: { id: request.adminUser.id, name: request.adminUser.name } });
  }
}
