import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AdminAuthGuard } from '../../admin/admin-auth.guard';
import { AdminRoleGuard } from '../../admin/admin-role.guard';
import { RequireModule } from '../../admin/require-module.decorator';
import { RequireRole } from '../../admin/require-role.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { financialIssueCodes } from '../vale-pass-lots.service';
import { INTEGRATION_DISABLED } from './flow-flags';
import { MAX_RESUME_BATCH, ValePassPaymentFlowService, type ResumeReport } from './payment-flow.service';

export class ResumeHeldPaymentsDto {
  // O guard de sessão lê `adminUserId` do body.
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_RESUME_BATCH)
  limit?: number;

  @IsString()
  @MinLength(10)
  @MaxLength(500)
  note!: string;
}

export interface FlowStatus {
  /** Chaves lidas do ambiente do serviço (nunca valores de segredo). */
  readonly twoVoucherFlow: boolean;
  readonly unitRefunds: boolean;
  /** Retenções abertas feitas porque a integração estava desligada. */
  readonly heldByIntegration: number;
}

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string };
}

@Controller('admin/vale-pass/flow')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('VALLE_PASS')
export class ValePassFlowController {
  constructor(
    private readonly flow: ValePassPaymentFlowService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async status(): Promise<FlowStatus> {
    const open = await this.prisma.valePassIssuanceHold.findMany({ where: { status: 'OPEN', reason: 'FINANCIAL_MISMATCH' }, select: { detail: true }, take: 500 });
    return {
      twoVoucherFlow: this.flow.enabled(),
      unitRefunds: this.flow.unitRefundsEnabled(),
      heldByIntegration: open.filter((hold) => financialIssueCodes(hold.detail).includes(INTEGRATION_DISABLED)).length,
    };
  }

  /** Retoma, em lote e das mais antigas para as mais novas, as retenções feitas com a integração desligada. Só ADMIN; exige a chave LIGADA. */
  @Post('resume')
  @RequireRole('ADMIN')
  resume(@Body() dto: ResumeHeldPaymentsDto, @Req() req: RequestWithAdminUser): Promise<ResumeReport> {
    return this.flow.resumeHeldPayments({ id: req.adminUser!.id, name: req.adminUser!.name }, { limit: dto.limit, note: dto.note });
  }
}
