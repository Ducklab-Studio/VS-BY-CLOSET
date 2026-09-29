import { Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { ValePassOrderStatus } from '@prisma/client';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireModule } from '../admin/require-module.decorator';
import { RequireRole } from '../admin/require-role.decorator';
import { ValePassOrdersService, type ValePassOrderItem, type ValePassOrderReconciliationReport } from './vale-pass-orders.service';

export const VALE_PASS_ORDER_STATUSES: readonly ValePassOrderStatus[] = ['PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELLED', 'DECLINED', 'REFUNDED'];

/**
 * Pedidos de Valle Pass (qualquer status). Listar é operação do dia a dia —
 * só o módulo VALLE_PASS, como a lista de vales. Forçar a reconciliação
 * agora (ela já roda sozinha) exige ADMIN e tem limite de chamadas.
 */
@Controller('admin/vale-pass/orders')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('VALLE_PASS')
export class ValePassOrdersController {
  constructor(private readonly orders: ValePassOrdersService) {}

  @Get()
  list(@Query('status') status?: string): Promise<ValePassOrderItem[]> {
    const parsed = status && (VALE_PASS_ORDER_STATUSES as readonly string[]).includes(status) ? (status as ValePassOrderStatus) : undefined;
    return this.orders.list({ status: parsed });
  }

  @Post('reconcile')
  @RequireRole('ADMIN')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  reconcile(): Promise<ValePassOrderReconciliationReport> {
    return this.orders.reconcile({ manual: true });
  }
}
