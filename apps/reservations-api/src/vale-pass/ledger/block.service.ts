import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type ValePass, type ValePassBlockEvent } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { writeAdminAuditEvent } from '../../admin/admin-audit';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { maskCode } from '../email/email-mask';
import { ledgerRefusal } from './ledger-errors';
import { ValePassRedemptionService, type Actor, type Restriction } from './redemption.service';

type Tx = Prisma.TransactionClient;

export interface BlockEventView {
  readonly id: string;
  readonly seq: number;
  readonly kind: 'BLOCK' | 'UNBLOCK';
  /** Justificativa: só administradores a veem (pode citar suspeita de fraude). */
  readonly reason: string | null;
  readonly actorName: string | null;
  readonly createdAt: string;
  readonly balanceCents: number;
}

export interface BlockPreview {
  readonly canProceed: boolean;
  readonly problems: readonly { readonly code: string; readonly message: string }[];
  /** Só para desbloqueio: o que continuaria impedindo o resgate DEPOIS de desbloquear (desbloquear nunca reativa nada). */
  readonly stillRestricted: readonly { readonly code: Restriction; readonly message: string }[];
  readonly blocked: boolean;
  readonly status: ValePass['status'];
  readonly balanceCents: number;
  /** Identificador idempotente que a confirmação deve reenviar. */
  readonly operationId: string;
}

export interface BlockResult {
  readonly replayed: boolean;
  readonly event: BlockEventView;
  readonly blocked: boolean;
  /** Bloquear/desbloquear nunca muda status nem saldo: devolvidos para conferência. */
  readonly status: ValePass['status'];
  readonly balanceCents: number;
}

const TX_OPTIONS = { timeout: 15_000, maxWait: 8_000 } as const;
const CODE_SHAPE = /^[A-Za-z0-9-]{4,40}$/;
const hashOf = (parts: Record<string, string>): string => createHash('sha256').update(JSON.stringify(Object.entries(parts).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
const conflict = (code: string, message: string, extra: Record<string, unknown> = {}) => new ConflictException({ statusCode: 409, error: 'Conflict', code, message, ...extra });
const isAdmin = (actor: Actor) => actor.role === 'ADMIN' || actor.role === 'SUPER_ADMIN';

/**
 * Bloqueio e desbloqueio administrativo de vouchers (Fase 3 / PR C1). Somente ADMIN/SUPER_ADMIN, em duas etapas (prévia + confirmação com o código redigitado),
 * com justificativa obrigatória (10–500), idempotência por operação, histórico imutável e auditoria crítica. Mesmas travas do resgate (pedido → linha do voucher);
 * os gatilhos do banco são a rede de baixo.
 *
 * Bloquear NÃO muda status, saldo, validade nem histórico, e não cancela nada. Desbloquear NÃO reativa nada: cancelado continua cancelado (o desbloqueio é recusado),
 * expirado continua expirado, e voucher com reembolso em revisão não é desbloqueado até a decisão. Voucher bloqueado não é resgatado nem revertido, por nenhum endpoint.
 */
@Injectable()
export class ValePassBlockService {
  private readonly logger = new Logger(ValePassBlockService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ValePassRedemptionService) private readonly redemption: ValePassRedemptionService,
  ) {}

  async prepareBlock(code: string, actor: Actor): Promise<BlockPreview> {
    this.requireAdmin(actor);
    const voucher = await this.requireByCode(code);
    const problems = voucher.blockedAt ? [{ code: 'ALREADY_BLOCKED', message: 'Este voucher já está bloqueado.' }] : [];
    return { canProceed: problems.length === 0, problems, stillRestricted: [], blocked: voucher.blockedAt !== null, status: voucher.status, balanceCents: voucher.balanceCents, operationId: `op-${randomUUID()}` };
  }

  async confirmBlock(code: string, input: { reason: string; operationId: string; confirmCode: string }, actor: Actor): Promise<BlockResult> {
    return this.confirm('BLOCK', code, input, actor);
  }

  async prepareUnblock(code: string, actor: Actor): Promise<BlockPreview> {
    this.requireAdmin(actor);
    const voucher = await this.requireByCode(code);
    const problems = await this.unblockProblems(this.prisma, voucher);
    const restrictions = await this.redemption.restrictionsOf(this.prisma, voucher);
    return {
      canProceed: problems.length === 0,
      problems,
      stillRestricted: restrictions.filter((r) => r !== 'BLOCKED').map((r) => ({ code: r, message: RESTRICTION_AFTER[r] })),
      blocked: voucher.blockedAt !== null,
      status: voucher.status,
      balanceCents: voucher.balanceCents,
      operationId: `op-${randomUUID()}`,
    };
  }

  async confirmUnblock(code: string, input: { reason: string; operationId: string; confirmCode: string }, actor: Actor): Promise<BlockResult> {
    return this.confirm('UNBLOCK', code, input, actor);
  }

  /** Histórico de bloqueios do voucher (justificativa só para administrador). */
  async history(voucherId: string, actor: Actor): Promise<BlockEventView[]> {
    const rows = await this.prisma.valePassBlockEvent.findMany({ where: { valePassId: voucherId }, orderBy: { seq: 'desc' }, take: 50 });
    return rows.map((row) => this.toView(row, isAdmin(actor)));
  }

  // ─── Internos ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  private requireAdmin(actor: Actor): void {
    if (!isAdmin(actor)) throw new ForbiddenException('Bloquear e desbloquear voucher exige um administrador.');
  }

  private async requireByCode(raw: string): Promise<ValePass> {
    const code = (raw ?? '').trim().toUpperCase();
    const row = CODE_SHAPE.test(code) ? await this.prisma.valePass.findUnique({ where: { code } }) : null;
    if (!row) throw new NotFoundException('Voucher não encontrado.');
    return row;
  }

  private async unblockProblems(db: Tx | PrismaService, voucher: ValePass): Promise<{ code: string; message: string }[]> {
    const problems: { code: string; message: string }[] = [];
    if (!voucher.blockedAt) problems.push({ code: 'NOT_BLOCKED', message: 'Este voucher não está bloqueado.' });
    if (voucher.status === 'CANCELLED') problems.push({ code: 'CANCELLED', message: 'Voucher cancelado não é desbloqueado: o cancelamento continua valendo.' });
    const restrictions = await this.redemption.restrictionsOf(db, voucher);
    if (restrictions.includes('REFUND_UNDER_REVIEW')) problems.push({ code: 'REFUND_UNDER_REVIEW', message: RESTRICTION_AFTER.REFUND_UNDER_REVIEW });
    if (restrictions.includes('ORDER_CANCELLED')) problems.push({ code: 'ORDER_CANCELLED', message: RESTRICTION_AFTER.ORDER_CANCELLED });
    return problems;
  }

  private async confirm(kind: 'BLOCK' | 'UNBLOCK', code: string, input: { reason: string; operationId: string; confirmCode: string }, actor: Actor): Promise<BlockResult> {
    this.requireAdmin(actor);
    const reason = (input.reason ?? '').trim();
    if (reason.length < 10 || reason.length > 500) throw new BadRequestException('Informe a justificativa (de 10 a 500 caracteres).');
    const located = await this.requireByCode(code);
    if ((input.confirmCode ?? '').trim().toUpperCase() !== located.code) throw new BadRequestException('A confirmação não confere: digite novamente o código do voucher.');
    const requestHash = hashOf({ voucher: located.id, kind, reason });

    try {
      return await this.prisma.$transaction(async (tx) => {
        if (located.shopifyOrderId) await lockShopifyOrder(tx, located.shopifyOrderId);
        await tx.$executeRaw`SELECT 1 FROM vale_passes WHERE id = ${located.id}::uuid FOR UPDATE`;
        const voucher = await tx.valePass.findUniqueOrThrow({ where: { id: located.id } });

        const existing = await tx.valePassBlockEvent.findUnique({ where: { valePassId_idempotencyKey: { valePassId: voucher.id, idempotencyKey: input.operationId } } });
        if (existing) {
          if (existing.requestHash !== requestHash || existing.kind !== kind) throw conflict('IDEMPOTENCY_CONFLICT', 'Este identificador de operação já foi usado com outro conteúdo. Gere uma nova prévia.');
          return this.result(voucher, existing, true, actor);
        }
        if (kind === 'BLOCK' && voucher.blockedAt) throw conflict('ALREADY_BLOCKED', 'Este voucher já está bloqueado.');
        if (kind === 'UNBLOCK') {
          const problems = await this.unblockProblems(tx, voucher);
          if (problems.length > 0) throw conflict(problems[0].code, problems[0].message, { problems });
        }
        const event = await tx.valePassBlockEvent.create({
          data: { valePassId: voucher.id, seq: 1, kind, reason, actorAdminId: actor.id, actorName: actor.name, idempotencyKey: input.operationId, requestHash },
        });
        await tx.valePassEvent.create({ data: { valePassId: voucher.id, type: kind === 'BLOCK' ? 'BLOCKED' : 'UNBLOCKED', detail: { blockEventId: event.id, actorId: actor.id } as Prisma.InputJsonValue } });
        await writeAdminAuditEvent(tx, {
          adminUserId: actor.id,
          adminUserName: actor.name,
          action: kind === 'BLOCK' ? 'VALE_PASS_BLOCKED' : 'VALE_PASS_UNBLOCKED',
          entityType: 'ValePass',
          entityId: voucher.id,
          before: { blocked: voucher.blockedAt !== null },
          after: { blocked: kind === 'BLOCK' },
          detail: { blockEventId: event.id, company: voucher.company, code: maskCode(voucher.code), orderName: voucher.shopifyOrderName, reason },
        });
        const fresh = await tx.valePass.findUniqueOrThrow({ where: { id: voucher.id } });
        return this.result(fresh, event, false, actor);
      }, TX_OPTIONS);
    } catch (err) {
      const refusal = ledgerRefusal(err);
      if (refusal) throw refusal;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw conflict('OPERATION_IN_PROGRESS', 'Esta operação já está sendo processada. Consulte o voucher para ver o resultado.');
      if (err instanceof HttpException) throw err;
      this.logger.error(`Falha em ${kind} do voucher ${maskCode(located.code)}: ${err instanceof Error ? err.name : 'unknown'}`);
      throw new ServiceUnavailableException('Não foi possível concluir a operação agora. Nada foi alterado: consulte o voucher e tente de novo.');
    }
  }

  private result(voucher: ValePass, event: ValePassBlockEvent, replayed: boolean, actor: Actor): BlockResult {
    return { replayed, event: this.toView(event, isAdmin(actor)), blocked: voucher.blockedAt !== null, status: voucher.status, balanceCents: voucher.balanceCents };
  }

  toView(event: ValePassBlockEvent, withReason: boolean): BlockEventView {
    return { id: event.id, seq: event.seq, kind: event.kind, reason: withReason ? event.reason : null, actorName: event.actorName, createdAt: event.createdAt.toISOString(), balanceCents: event.balanceCents };
  }
}

/** O que continua valendo DEPOIS de desbloquear (o desbloqueio nunca reativa cancelado, expirado, usado nem voucher em revisão). */
const RESTRICTION_AFTER: Record<Restriction, string> = {
  LEGACY_NO_BALANCE: 'Voucher legado: não tem controle de saldo.',
  CANCELLED: 'Continuará cancelado.',
  EXPIRED: 'Continuará fora da validade.',
  NOT_YET_VALID: 'Continuará fora do período de uso até o início da validade.',
  BLOCKED: 'Bloqueado.',
  USED_UP: 'Continuará sem saldo.',
  REFUND_UNDER_REVIEW: 'Pedido com reembolso aguardando decisão de um administrador: o desbloqueio e o resgate esperam a decisão.',
  ORDER_CANCELLED: 'O pedido deste voucher foi cancelado ou reembolsado: o voucher não é desbloqueado.',
  TEST_CAMPAIGN: 'Voucher da campanha de TESTE: o resgate continua bloqueado (sem valor comercial).',
};
