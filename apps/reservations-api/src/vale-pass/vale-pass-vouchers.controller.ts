import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { ValePassStatus } from '@prisma/client';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
import { RequireModule } from '../admin/require-module.decorator';
import { ValePassVouchersService, type ValePassVoucherItem } from './vale-pass-vouchers.service';
import { CancelValePassDto } from './dto/cancel-vale-pass.dto';
import { RestoreValePassDto } from './dto/restore-vale-pass.dto';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string };
}

const VALID_STATUSES: readonly ValePassStatus[] = ['ACTIVE', 'USED', 'EXPIRED', 'CANCELLED'];

/**
 * "Listar, buscar, validar e marcar o Valle Pass como utilizado" —
 * operação do dia a dia (tipo caixa/atendimento), por isso só exige o
 * módulo VALLE_PASS (não ADMIN). "Cancelar" reverte um crédito já
 * vendido — exige ADMIN, mesmo padrão de campanhas.
 */
@Controller('admin/vale-pass/vouchers')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('VALLE_PASS')
export class ValePassVouchersController {
  constructor(private readonly vouchers: ValePassVouchersService) {}

  @Get()
  list(@Query('status') status?: string, @Query('campaignId') campaignId?: string, @Query('search') search?: string): Promise<ValePassVoucherItem[]> {
    const parsedStatus = status && (VALID_STATUSES as readonly string[]).includes(status) ? (status as ValePassStatus) : undefined;
    return this.vouchers.list({ status: parsedStatus, campaignId: campaignId || undefined, search: search || undefined });
  }

  @Get(':code')
  findByCode(@Param('code') code: string): Promise<ValePassVoucherItem> {
    return this.vouchers.findByCode(code);
  }

  @Post(':code/use')
  markUsed(@Param('code') code: string, @Req() req: RequestWithAdminUser): Promise<ValePassVoucherItem> {
    return this.vouchers.markUsed(code, req.adminUser!.id, req.adminUser!.name);
  }

  @Post(':code/cancel')
  @RequireRole('ADMIN')
  cancel(@Param('code') code: string, @Body() dto: CancelValePassDto, @Req() req: RequestWithAdminUser): Promise<ValePassVoucherItem> {
    return this.vouchers.cancel(code, dto.reason, req.adminUser!.id, req.adminUser!.name);
  }

  /** Reverte um cancelamento — reabre um crédito já vendido, mesma
   *  sensibilidade de `cancel`: exige ADMIN. */
  @Post(':code/restore')
  @RequireRole('ADMIN')
  restore(@Param('code') code: string, @Body() dto: RestoreValePassDto, @Req() req: RequestWithAdminUser): Promise<ValePassVoucherItem> {
    return this.vouchers.restore(code, dto.reason, req.adminUser!.id, req.adminUser!.name);
  }
}
