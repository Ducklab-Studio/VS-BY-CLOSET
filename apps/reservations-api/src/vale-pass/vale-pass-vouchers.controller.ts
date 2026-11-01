import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { AdminRole, ValePassStatus } from '@prisma/client';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { RequireRole } from '../admin/require-role.decorator';
import { RequireModule } from '../admin/require-module.decorator';
import { ValePassVouchersService, type ValePassVoucherItem } from './vale-pass-vouchers.service';
import { CancelValePassDto } from './dto/cancel-vale-pass.dto';
import { RestoreValePassDto } from './dto/restore-vale-pass.dto';
import { canSeeCustomerData, forListRole, forRole } from './vale-pass-voucher-privacy';
import { isIdentityConfirmed } from './vale-pass-identity-confirmation';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string; role: AdminRole };
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
  async list(@Req() req: RequestWithAdminUser, @Query('status') status?: string, @Query('campaignId') campaignId?: string, @Query('search') search?: string): Promise<ValePassVoucherItem[]> {
    const parsedStatus = status && (VALID_STATUSES as readonly string[]).includes(status) ? (status as ValePassStatus) : undefined;
    // Quem não é administrador consulta a lista SEM os códigos completos e só encontra voucher por código exato (ver ValePassVouchersService.list).
    const items = await this.vouchers.list({ status: parsedStatus, campaignId: campaignId || undefined, search: search || undefined }, { restricted: !canSeeCustomerData(req.adminUser!.role) });
    return items.map((item) => forListRole(item, req.adminUser!.role));
  }

  @Get(':code')
  async findByCode(@Param('code') code: string, @Req() req: RequestWithAdminUser): Promise<ValePassVoucherItem> {
    return forRole(await this.vouchers.findByCode(code), req.adminUser!.role);
  }

  @Post(':code/use')
  async markUsed(@Param('code') code: string, @Req() req: RequestWithAdminUser, @Body('identityChecked') identityChecked?: unknown): Promise<ValePassVoucherItem> {
    // Voucher com empresa: o "usado" por inteiro também exige o registro da conferência de identidade (o serviço aplica; legado sem empresa não tem esse conceito).
    return forRole(
      await this.vouchers.markUsed(code, req.adminUser!.id, req.adminUser!.name, { role: req.adminUser!.role, requireIdentity: true, identityChecked: isIdentityConfirmed(identityChecked) }),
      req.adminUser!.role,
    );
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
