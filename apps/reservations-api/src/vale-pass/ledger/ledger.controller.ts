import { Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AdminRole } from '@prisma/client';
import { AdminAuthGuard } from '../../admin/admin-auth.guard';
import { AdminRoleGuard } from '../../admin/admin-role.guard';
import { RequireRole } from '../../admin/require-role.decorator';
import { RequireModule } from '../../admin/require-module.decorator';
import { ConfirmBlockDto, ConfirmRedeemDto, ConfirmReverseDto, PrepareRedeemDto } from '../dto/voucher-balance.dto';
import { ValePassBlockService, type BlockPreview, type BlockResult } from './block.service';
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
 * Consulta (saldo/histórico): qualquer usuário do módulo, com dados pessoais mascarados. Resgate (prévia e confirmação): ADMIN/SUPER_ADMIN e STAFF — este
 * SÓ nas empresas vinculadas a ele pelo proprietário (decidido no serviço, por voucher). Reversão, bloqueio/desbloqueio e conciliação: somente ADMIN.
 * Nenhum endpoint público. A segurança é do backend: a prévia nunca é confiada na confirmação.
 */
@Controller('admin/vale-pass')
@UseGuards(AdminAuthGuard, AdminRoleGuard)
@RequireModule('VALLE_PASS')
export class ValePassLedgerController {
  constructor(
    private readonly redemption: ValePassRedemptionService,
    private readonly ledger: ValePassLedgerService,
    private readonly blocks: ValePassBlockService,
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
  @Throttle(WRITE_LIMIT)
  prepareRedeem(@Param('code') code: string, @Body() dto: PrepareRedeemDto, @Req() req: RequestWithAdminUser): Promise<RedeemPreview> {
    return this.redemption.prepareRedeem(code, dto, actorOf(req));
  }

  /** Confirma e grava o resgate. Repetir a mesma operação devolve o resultado original (`replayed: true`); mesma chave com outro conteúdo = 409. */
  @Post('vouchers/:code/redeem')
  @HttpCode(200)
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

  /** Prévia do bloqueio (nada é gravado). */
  @Post('vouchers/:code/block/prepare')
  @HttpCode(200)
  @RequireRole('ADMIN')
  @Throttle(WRITE_LIMIT)
  prepareBlock(@Param('code') code: string, @Req() req: RequestWithAdminUser): Promise<BlockPreview> {
    return this.blocks.prepareBlock(code, actorOf(req));
  }

  /** Bloqueia o voucher (não altera status nem saldo; histórico imutável; justificativa obrigatória; idempotente). */
  @Post('vouchers/:code/block')
  @HttpCode(200)
  @RequireRole('ADMIN')
  @Throttle(WRITE_LIMIT)
  block(@Param('code') code: string, @Body() dto: ConfirmBlockDto, @Req() req: RequestWithAdminUser): Promise<BlockResult> {
    return this.blocks.confirmBlock(code, dto, actorOf(req));
  }

  @Post('vouchers/:code/unblock/prepare')
  @HttpCode(200)
  @RequireRole('ADMIN')
  @Throttle(WRITE_LIMIT)
  prepareUnblock(@Param('code') code: string, @Req() req: RequestWithAdminUser): Promise<BlockPreview> {
    return this.blocks.prepareUnblock(code, actorOf(req));
  }

  /** Desbloqueia (nunca reativa cancelado/expirado/usado nem ignora reembolso em revisão). */
  @Post('vouchers/:code/unblock')
  @HttpCode(200)
  @RequireRole('ADMIN')
  @Throttle(WRITE_LIMIT)
  unblock(@Param('code') code: string, @Body() dto: ConfirmBlockDto, @Req() req: RequestWithAdminUser): Promise<BlockResult> {
    return this.blocks.confirmUnblock(code, dto, actorOf(req));
  }

  /** Conciliação livro-razão × saldo (somente leitura). Lista vazia = consistente. */
  @Get('ledger/reconcile')
  @RequireRole('ADMIN')
  reconcile(): Promise<LedgerProblem[]> {
    return this.ledger.reconcile();
  }
}
