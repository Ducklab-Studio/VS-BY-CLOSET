import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AdminRole } from '@prisma/client';
import { AdminAuthGuard } from '../../admin/admin-auth.guard';
import { AdminRoleGuard } from '../../admin/admin-role.guard';
import { RequireRole } from '../../admin/require-role.decorator';
import { RequireModule } from '../../admin/require-module.decorator';
import { ConfirmRedeemDto, ConfirmReverseDto, PrepareRedeemDto } from '../dto/voucher-balance.dto';
import { ValePassLedgerService, type LedgerProblem } from './ledger.service';
import { ValePassRedemptionService, type Actor, type LedgerEntryView, type OperationResult, type RedeemPreview, type VoucherBalanceView } from './redemption.service';

interface RequestWithAdminUser {
  adminUser?: { id: string; name: string; role: AdminRole };
}
const actorOf = (req: RequestWithAdminUser): Actor => ({ id: req.adminUser!.id, name: req.adminUser!.name, role: req.adminUser!.role });

/** Consulta: 60/min por IP (a mesma resposta para código inexistente e inválido; o limite barra a tentativa de enumerar códigos). */
const LOOKUP_LIMIT = { default: { limit: 60, ttl: 60_000 } };
/** Escrita: bem mais restrita. */
const WRITE_LIMIT = { default: { limit: 30, ttl: 60_000 } };

/**
 * Saldo, resgate parcial e reversão de vouchers do Valle Pass 2027 (Fase 3 / PR B). Todas as rotas exigem sessão administrativa e o módulo VALLE_PASS.
 * Consulta (saldo/histórico): qualquer usuário do módulo, com dados pessoais mascarados. Resgate e reversão (prévia e confirmação): somente ADMIN —
 * não há vínculo seguro operador↔empresa para liberar STAFF. Nenhum endpoint público. A segurança é do backend: a prévia nunca é confiada na confirmação.
 */
@Controller('admin/vale-pass')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('VALLE_PASS')
export class ValePassLedgerController {
  constructor(
    private readonly redemption: ValePassRedemptionService,
    private readonly ledger: ValePassLedgerService,
  ) {}

  /** Voucher + saldo + restrições + histórico (últimos 100 lançamentos). */
  @Get('vouchers/:code/balance')
  @Throttle(LOOKUP_LIMIT)
  balance(@Param('code') code: string, @Req() req: RequestWithAdminUser): Promise<VoucherBalanceView> {
    return this.redemption.lookup(code, actorOf(req));
  }

  @Get('vouchers/:code/ledger')
  @Throttle(LOOKUP_LIMIT)
  history(@Param('code') code: string): Promise<LedgerEntryView[]> {
    return this.redemption.history(code);
  }

  /** Prévia do resgate (nada é gravado). Devolve `operationId` e `expectedBalanceCents` para a confirmação. */
  @Post('vouchers/:code/redeem/prepare')
  @HttpCode(200)
  @RequireRole('ADMIN')
  @Throttle(WRITE_LIMIT)
  prepareRedeem(@Param('code') code: string, @Body() dto: PrepareRedeemDto, @Req() req: RequestWithAdminUser): Promise<RedeemPreview> {
    return this.redemption.prepareRedeem(code, dto, actorOf(req));
  }

  /** Confirma e grava o resgate. Repetir a mesma operação devolve o resultado original (`replayed: true`); mesma chave com outro conteúdo = 409. */
  @Post('vouchers/:code/redeem')
  @HttpCode(200)
  @RequireRole('ADMIN')
  @Throttle(WRITE_LIMIT)
  redeem(@Param('code') code: string, @Body() dto: ConfirmRedeemDto, @Req() req: RequestWithAdminUser): Promise<OperationResult> {
    return this.redemption.confirmRedeem(code, dto, actorOf(req));
  }

  @Post('vouchers/:code/ledger/:entryId/reverse/prepare')
  @HttpCode(200)
  @RequireRole('ADMIN')
  @Throttle(WRITE_LIMIT)
  prepareReverse(@Param('code') code: string, @Param('entryId') entryId: string, @Req() req: RequestWithAdminUser) {
    return this.redemption.prepareReverse(code, entryId, actorOf(req));
  }

  /** Reverte UM resgate (lançamento compensatório; o histórico nunca é apagado). Justificativa obrigatória. */
  @Post('vouchers/:code/ledger/:entryId/reverse')
  @HttpCode(200)
  @RequireRole('ADMIN')
  @Throttle(WRITE_LIMIT)
  reverse(@Param('code') code: string, @Param('entryId') entryId: string, @Body() dto: ConfirmReverseDto, @Req() req: RequestWithAdminUser): Promise<OperationResult> {
    return this.redemption.confirmReverse(code, entryId, dto, actorOf(req));
  }

  /** Conciliação livro-razão × saldo (somente leitura). Lista vazia = consistente. */
  @Get('ledger/reconcile')
  @RequireRole('ADMIN')
  reconcile(): Promise<LedgerProblem[]> {
    return this.ledger.reconcile();
  }
}
