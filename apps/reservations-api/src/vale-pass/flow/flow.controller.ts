import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';
import { AdminAuthGuard } from '../../admin/admin-auth.guard';
import { AdminRoleGuard } from '../../admin/admin-role.guard';
import { RequireModule } from '../../admin/require-module.decorator';
import { RequireRole } from '../../admin/require-role.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { financialIssueCodes } from '../vale-pass-lots.service';
import { INTEGRATION_DISABLED } from './flow-flags';
import { MAX_RESUME_BATCH, ValePassPaymentFlowService, type FlowOverview, type RegularizeResult, type ResumeReport } from './payment-flow.service';
import { ValePassPaymentTimeService, type PaymentTimeCandidate, type VerifyOutcome } from './payment-time.service';
import { paymentTimeOf } from './flow-flags';
import { ValePassOperationalAlertsService } from './operational-alerts.service';
import type { OperationalSnapshot } from './operational-alerts';
import type { PaymentTimeConfig } from './payment-time-policy';

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

export class RegularizeOrderDto {
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  /** Id numérico do pedido na Shopify (como no registro). */
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  orderId!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(500)
  note!: string;
}

export class PaymentTimeVerifyDto {
  @IsOptional()
  @IsUUID()
  adminUserId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(40)
  orderId!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(500)
  note!: string;
}

export class PaymentTimeConfirmDto extends PaymentTimeVerifyDto {
  /** ISO 8601 com fuso. */
  @IsString()
  @MinLength(20)
  @MaxLength(40)
  confirmedAt!: string;
}

export interface FlowStatus extends FlowOverview {
  /** Política do horário do pagamento em vigor (estrita por padrão) e pedidos retidos por horário desconhecido, com os candidatos. */
  readonly paymentTimePolicy: PaymentTimeConfig;
  readonly paymentTimePending: readonly PaymentTimeCandidate[];
  /** Contador específico: pagamentos confirmados sem benefício, 48–72 h, prazo de 72 h vencido, e-mails vencidos. */
  readonly operational: OperationalSnapshot;
  /** Chaves lidas do ambiente do serviço (nunca valores de segredo). */
  readonly twoVoucherFlow: boolean;
  readonly unitRefunds: boolean;
  /** Retenções abertas feitas porque a integração estava desligada. */
  readonly heldByIntegration: number;
  /** Avisos sobre a combinação atual das chaves (sem efeito sobre o comportamento: só orientam a operação). */
  readonly notices: readonly string[];
}

/** Orientações sobre a combinação das duas chaves. Reembolso de pedido do modelo novo é SEMPRE por unidade, com qualquer combinação. */
export function flagNotices(flags: { twoVoucherFlow: boolean; unitRefunds: boolean }): string[] {
  const notices: string[] = [];
  if (!flags.twoVoucherFlow) notices.push('Emissão dos dois vouchers DESLIGADA: pagamentos de campanhas com benefícios ficam retidos (nenhum voucher é emitido). Cancelamentos e reembolsos continuam sendo tratados.');
  if (flags.twoVoucherFlow && !flags.unitRefunds) notices.push('Reembolso por unidade para campanhas sem benefícios está desligado; para pedidos dos dois vouchers o reembolso é SEMPRE por unidade (nada é cancelado sem decisão de um ADMIN).');
  if (!flags.twoVoucherFlow && flags.unitRefunds) notices.push('Reembolso por unidade LIGADO com a emissão dos dois vouchers desligada: reembolsos de pagamentos retidos são descontados na emissão futura.');
  return notices;
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
    private readonly paymentTime: ValePassPaymentTimeService,
    private readonly operationalAlerts: ValePassOperationalAlertsService,
  ) {}

  /** Contador específico (menu do ClosetAdmin) dos pagamentos confirmados sem benefício, retenções acima de 48 h e prazo de 72 h vencido. Leitura. */
  @Get('alerts')
  alerts(): Promise<OperationalSnapshot> {
    return this.operationalAlerts.snapshot();
  }

  @Get()
  async status(): Promise<FlowStatus> {
    const open = await this.prisma.valePassIssuanceHold.findMany({ where: { status: 'OPEN', reason: 'FINANCIAL_MISMATCH' }, select: { detail: true }, take: 500 });
    const flags = { twoVoucherFlow: this.flow.enabled(), unitRefunds: this.flow.unitRefundsEnabled() };
    return {
      ...flags,
      heldByIntegration: open.filter((hold) => financialIssueCodes(hold.detail).includes(INTEGRATION_DISABLED)).length,
      notices: flagNotices(flags),
      paymentTimePolicy: paymentTimeOf(this.flow.flagSet()),
      paymentTimePending: await this.paymentTime.candidates(),
      operational: await this.operationalAlerts.snapshot(),
      ...(await this.flow.overview()),
    };
  }

  /** Retoma, em lote e das mais antigas para as mais novas, as retenções feitas com a integração desligada. Só ADMIN; exige a chave LIGADA. */
  @Post('resume')
  @RequireRole('ADMIN')
  resume(@Body() dto: ResumeHeldPaymentsDto, @Req() req: RequestWithAdminUser): Promise<ResumeReport> {
    return this.flow.resumeHeldPayments({ id: req.adminUser!.id, name: req.adminUser!.name }, { limit: dto.limit, note: dto.note });
  }

  /** Confere o horário do pagamento na Shopify Admin API (somente leitura) e só o confirma se a transação financeira concordar com o webhook. Só ADMIN. */
  @Post('payment-time/verify')
  @RequireRole('ADMIN')
  verifyPaymentTime(@Body() dto: PaymentTimeVerifyDto, @Req() req: RequestWithAdminUser): Promise<VerifyOutcome> {
    return this.paymentTime.verifyFromShopify({ id: req.adminUser!.id, name: req.adminUser!.name }, { orderId: dto.orderId, note: dto.note });
  }

  /** O ADMIN informa o horário do pagamento (conferido na Shopify), com justificativa. Só ADMIN. */
  @Post('payment-time/confirm')
  @RequireRole('ADMIN')
  confirmPaymentTime(@Body() dto: PaymentTimeConfirmDto, @Req() req: RequestWithAdminUser): Promise<{ confirmedAt: string }> {
    return this.paymentTime.confirmManually({ id: req.adminUser!.id, name: req.adminUser!.name }, { orderId: dto.orderId, confirmedAt: dto.confirmedAt, note: dto.note });
  }

  /** Regulariza UM pedido pago com unidades sem voucher (acréscimo de compra, variante sem campanha agora cadastrada). Só ADMIN; revalida os fatos financeiros. */
  @Post('regularize')
  @RequireRole('ADMIN')
  regularize(@Body() dto: RegularizeOrderDto, @Req() req: RequestWithAdminUser): Promise<RegularizeResult> {
    return this.flow.regularizeOrder({ id: req.adminUser!.id, name: req.adminUser!.name }, { orderId: dto.orderId, note: dto.note });
  }
}
