import { BadRequestException, ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type AdminRole, type ValePass, type ValePassLedgerEntry } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { writeAdminAuditEvent } from '../../admin/admin-audit';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { maskCode, maskEmail } from '../email/email-mask';
import { ledgerRefusal } from './ledger-errors';
import { formatBRL, parsePositiveCents } from './money';
import { activeCompanies, authorizeCompany } from './operator-scope.service';
import { decideCompanyAccess, describeOperatorAccess, operableCompanies, type OperatorCompany } from './operator-scope';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

export interface Actor {
  readonly id: string;
  readonly name: string;
  readonly role: AdminRole;
}

/** Por que um voucher não pode ser resgatado agora (todos verificados no servidor, e de novo pelo banco). */
export type Restriction = 'LEGACY_NO_BALANCE' | 'CANCELLED' | 'EXPIRED' | 'NOT_YET_VALID' | 'BLOCKED' | 'USED_UP' | 'REFUND_UNDER_REVIEW' | 'ORDER_CANCELLED';

const RESTRICTION_TEXT: Record<Restriction, string> = {
  LEGACY_NO_BALANCE: 'Voucher legado: não tem controle de saldo.',
  CANCELLED: 'Voucher cancelado.',
  EXPIRED: 'Voucher fora da validade.',
  NOT_YET_VALID: 'Voucher ainda não está no período de uso.',
  BLOCKED: 'Voucher bloqueado administrativamente.',
  USED_UP: 'Voucher sem saldo (utilizado por inteiro).',
  REFUND_UNDER_REVIEW: 'Pedido com reembolso aguardando decisão de um administrador: resgate bloqueado até a decisão.',
  ORDER_CANCELLED: 'O pedido deste voucher foi cancelado ou reembolsado.',
};

export interface LedgerEntryView {
  readonly id: string;
  readonly seq: number;
  readonly kind: 'REDEEM' | 'REVERSAL' | 'ADJUSTMENT' | 'REFUND_WRITEOFF';
  readonly company: 'VALLE_SHOWROOM' | 'VS_BY_CLOSET' | null;
  /** Centavos com sinal: resgate negativo, reversão positiva. */
  readonly deltaCents: number;
  readonly balanceAfterCents: number;
  readonly reference: string | null;
  readonly reason: string | null;
  readonly actorName: string | null;
  readonly createdAt: string;
  readonly reversesEntryId: string | null;
  /** Só REDEEM: já foi revertido (por isso não pode ser revertido de novo). */
  readonly reversed: boolean;
}

export interface VoucherBalanceView {
  readonly code: string;
  readonly company: 'VALLE_SHOWROOM' | 'VS_BY_CLOSET' | null;
  readonly benefitLabel: string | null;
  readonly status: ValePass['status'];
  readonly amountCents: number;
  readonly balanceCents: number;
  readonly usedCents: number;
  readonly validFrom: string | null;
  readonly expiresAt: string;
  readonly blockedAt: string | null;
  /** Motivo do bloqueio atual: só administrador. */
  readonly blockedReason: string | null;
  /** Histórico de bloqueios/desbloqueios (justificativa só para administrador). */
  readonly blockHistory: readonly { readonly id: string; readonly seq: number; readonly kind: 'BLOCK' | 'UNBLOCK'; readonly reason: string | null; readonly actorName: string | null; readonly createdAt: string }[];
  readonly orderName: string | null;
  /** Dados pessoais mascarados (o nome completo só para administrador). Sem telefone/e-mail completos. */
  readonly holder: { readonly name: string | null; readonly phoneMasked: string | null; readonly emailMasked: string | null };
  readonly redeemable: boolean;
  /** O que ESTE operador pode fazer com ESTE voucher (a decisão final é sempre do servidor, a cada operação). */
  readonly operatorAccess: { readonly canOperate: boolean; readonly message: string | null; readonly summary: string; readonly companies: readonly OperatorCompany[] };
  readonly restrictions: readonly { readonly code: Restriction; readonly message: string }[];
  readonly entries: readonly LedgerEntryView[];
}

export interface RedeemPreview {
  readonly canRedeem: boolean;
  readonly problems: readonly { readonly code: string; readonly message: string }[];
  readonly company: string;
  readonly amountCents: number;
  readonly balanceBeforeCents: number;
  readonly balanceAfterCents: number | null;
  /** Identificador idempotente que a confirmação deve reenviar. Gerado a cada prévia. */
  readonly operationId: string;
  /** Reenviar na confirmação: se o saldo mudar até lá, a operação é recusada. */
  readonly expectedBalanceCents: number;
}

export interface OperationResult {
  /** `true` = a mesma operação (mesma chave e mesmo conteúdo) já tinha sido feita: nada foi descontado de novo. */
  readonly replayed: boolean;
  readonly entry: LedgerEntryView;
  readonly balanceCents: number;
  readonly usedCents: number;
  readonly status: ValePass['status'];
}

const TX_OPTIONS = { timeout: 15_000, maxWait: 8_000 } as const;
const HISTORY_LIMIT = 100;
const CODE_SHAPE = /^[A-Za-z0-9-]{4,40}$/;

const canOperate = (role: AdminRole) => role === 'ADMIN' || role === 'SUPER_ADMIN';
const hashOf = (parts: Record<string, string | number>): string => createHash('sha256').update(JSON.stringify(Object.entries(parts).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');

function maskName(name: string | null): string | null {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0]}.`;
}
function maskPhone(phone: string | null): string | null {
  const digits = phone?.replace(/\D/g, '') ?? '';
  return digits.length >= 4 ? `***${digits.slice(-2)}` : phone ? '***' : null;
}

const conflict = (code: string, message: string, extra: Record<string, unknown> = {}) => new ConflictException({ statusCode: 409, error: 'Conflict', code, message, ...extra });

/**
 * Resgate parcial de voucher (Fase 3 / PR B). A segurança vive no BACKEND (e, por baixo, nos gatilhos do banco): empresa do voucher, saldo, validade,
 * bloqueio, revisão de reembolso, idempotência e reversão única são validados DENTRO da transação, sob o lock do pedido e a trava da linha do voucher
 * (mesma ordem de locks do restante do módulo: pedido → voucher). A prévia (`prepare*`) é só conferência: a confirmação revalida TUDO.
 *
 * Autorização por ESTABELECIMENTO (backend, dentro da transação, sob o lock do voucher): o operador só resgata/reverte vouchers da empresa em que está
 * explicitamente autorizado (`vale_pass_operator_scopes`). Sem autorização nenhuma, STAFF não opera; ADMIN sem autorização explícita mantém o acesso administrativo
 * atual até a política de migração ser definida; SUPER_ADMIN opera as duas. Ver `operator-scope.ts`. STAFF só consulta, com dados mascarados.
 * Nenhum endpoint público; conhecer o código do voucher não dá acesso a nada.
 */
@Injectable()
export class ValePassRedemptionService {
  private readonly logger = new Logger(ValePassRedemptionService.name);

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  // ─── Consulta ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  async lookup(code: string, actor: Actor): Promise<VoucherBalanceView> {
    const voucher = await this.requireByCode(code);
    return this.view(this.prisma, voucher, actor);
  }

  async history(code: string): Promise<LedgerEntryView[]> {
    const voucher = await this.requireByCode(code);
    return this.entriesOf(this.prisma, voucher.id);
  }

  // ─── Resgate ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  async prepareRedeem(code: string, input: { company: string; amountCents: number; reference: string }, actor: Actor): Promise<RedeemPreview> {
    await this.requireAnyAuthorization(actor);
    const amount = parsePositiveCents(input.amountCents);
    const voucher = await this.requireByCode(code);
    await this.authorizeVoucher(this.prisma, actor, voucher);
    const problems = await this.redeemProblems(this.prisma, voucher, input.company, amount);
    return {
      canRedeem: problems.length === 0,
      problems,
      company: voucher.company ?? '',
      amountCents: amount,
      balanceBeforeCents: voucher.balanceCents,
      balanceAfterCents: problems.length === 0 ? voucher.balanceCents - amount : null,
      operationId: randomUUID(),
      expectedBalanceCents: voucher.balanceCents,
    };
  }

  async confirmRedeem(
    code: string,
    input: { company: string; amountCents: number; reference: string; operationId: string; expectedBalanceCents: number; confirmAmountCents: number },
    actor: Actor,
  ): Promise<OperationResult> {
    await this.requireAnyAuthorization(actor);
    const amount = parsePositiveCents(input.amountCents);
    if (input.confirmAmountCents !== amount) throw new BadRequestException('A confirmação não confere com o valor do resgate. Digite novamente o valor em centavos.');
    const reference = input.reference.trim();
    if (reference.length < 3) throw new BadRequestException('Informe a referência da utilização.');
    const located = await this.requireByCode(code);
    const requestHash = hashOf({ voucher: located.id, kind: 'REDEEM', amount, company: input.company, reference });

    return this.run(located, async (tx, voucher) => {
      // Autorização revalidada DENTRO da transação (sob o lock): revogar o vínculo vale na hora, e a prévia nunca é confiada.
      const basis = await this.authorizeVoucher(tx, actor, voucher);
      const replay = await this.replayOf(tx, voucher, input.operationId, requestHash, 'REDEEM');
      if (replay) return replay;
      // Prévia antiga primeiro: se o saldo mudou, o operador precisa rever o voucher antes de qualquer outra coisa.
      if (voucher.balanceCents !== input.expectedBalanceCents) {
        throw conflict('BALANCE_CHANGED', `O saldo mudou desde a prévia (agora ${formatBRL(voucher.balanceCents)}). Confira e tente de novo.`, { balanceCents: voucher.balanceCents });
      }
      const problems = await this.redeemProblems(tx, voucher, input.company, amount);
      if (problems.length > 0) throw conflict(problems[0].code, problems[0].message, { balanceCents: voucher.balanceCents, problems });
      const entry = await this.post(tx, voucher, { kind: 'REDEEM', deltaCents: -amount, operationId: input.operationId, requestHash, reference, reason: null, actor });
      await this.record(tx, voucher, entry, 'VALE_PASS_REDEEMED', 'REDEEMED', actor, { reference, accessBasis: basis });
      return this.result(tx, voucher.id, entry, false);
    });
  }

  // ─── Reversão ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  async prepareReverse(code: string, entryId: string, actor: Actor): Promise<{ canReverse: boolean; problems: { code: string; message: string }[]; entry: LedgerEntryView | null; balanceBeforeCents: number; balanceAfterCents: number | null; operationId: string; expectedBalanceCents: number }> {
    await this.requireAnyAuthorization(actor);
    const voucher = await this.requireByCode(code);
    await this.authorizeVoucher(this.prisma, actor, voucher);
    const { problems, entry } = await this.reverseProblems(this.prisma, voucher, entryId);
    return {
      canReverse: problems.length === 0,
      problems,
      entry: entry ? this.toEntryView(entry, new Set()) : null,
      balanceBeforeCents: voucher.balanceCents,
      balanceAfterCents: problems.length === 0 && entry ? voucher.balanceCents - entry.deltaCents : null,
      operationId: randomUUID(),
      expectedBalanceCents: voucher.balanceCents,
    };
  }

  async confirmReverse(
    code: string,
    entryId: string,
    input: { reason: string; operationId: string; expectedBalanceCents: number; confirmAmountCents: number },
    actor: Actor,
  ): Promise<OperationResult> {
    await this.requireAnyAuthorization(actor);
    const reason = input.reason.trim();
    if (reason.length < 10) throw new BadRequestException('Informe a justificativa da reversão (mínimo de 10 caracteres).');
    const located = await this.requireByCode(code);
    const requestHash = hashOf({ voucher: located.id, kind: 'REVERSAL', entry: entryId, reason });

    return this.run(located, async (tx, voucher) => {
      const basis = await this.authorizeVoucher(tx, actor, voucher);
      const replay = await this.replayOf(tx, voucher, input.operationId, requestHash, 'REVERSAL');
      if (replay) return replay;
      const { problems, entry: original } = await this.reverseProblems(tx, voucher, entryId);
      if (problems.length > 0 || !original) throw conflict(problems[0]?.code ?? 'ENTRY_NOT_FOUND', problems[0]?.message ?? 'Lançamento não encontrado.', { balanceCents: voucher.balanceCents });
      if (-original.deltaCents !== input.confirmAmountCents) throw new BadRequestException('A confirmação não confere com o valor do resgate revertido. Digite novamente o valor em centavos.');
      if (voucher.balanceCents !== input.expectedBalanceCents) {
        throw conflict('BALANCE_CHANGED', `O saldo mudou desde a prévia (agora ${formatBRL(voucher.balanceCents)}). Confira e tente de novo.`, { balanceCents: voucher.balanceCents });
      }
      const entry = await this.post(tx, voucher, { kind: 'REVERSAL', deltaCents: -original.deltaCents, operationId: input.operationId, requestHash, reference: original.reference, reason, reversesEntryId: original.id, actor });
      await this.record(tx, voucher, entry, 'VALE_PASS_REDEMPTION_REVERSED', 'REDEMPTION_REVERSED', actor, { reversesEntryId: original.id, reason, accessBasis: basis });
      return this.result(tx, voucher.id, entry, false);
    });
  }

  // ─── Internos ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Barreira rápida ANTES de procurar o voucher (não revela se o código existe a quem não opera nada): STAFF sem nenhum estabelecimento autorizado não opera.
   * A decisão de verdade, por empresa, é `authorizeVoucher` (dentro da transação).
   */
  private async requireAnyAuthorization(actor: Actor): Promise<void> {
    if (actor.role === 'STAFF' && (await activeCompanies(this.prisma, actor.id)).length === 0) {
      throw new ForbiddenException({ statusCode: 403, error: 'Forbidden', code: 'NO_COMPANY_AUTHORIZED', message: 'Seu usuário não está autorizado a resgatar vouchers de nenhum estabelecimento. Peça ao proprietário.' });
    }
  }

  /** Autoriza o operador para a empresa DESTE voucher. Voucher legado (sem empresa) não tem estabelecimento: segue exigindo ADMIN, como sempre. */
  private async authorizeVoucher(db: Db, actor: Actor, voucher: ValePass): Promise<'OWNER' | 'LEGACY_ADMIN' | 'SCOPE' | 'LEGACY_VOUCHER'> {
    if (voucher.company === null) {
      if (!canOperate(actor.role)) throw new ForbiddenException('Resgate e reversão exigem um administrador.');
      return 'LEGACY_VOUCHER';
    }
    return authorizeCompany(db, actor, voucher.company);
  }

  private async requireByCode(raw: string): Promise<ValePass> {
    const code = (raw ?? '').trim().toUpperCase();
    // Resposta única para "não existe" e "formato inválido": nenhuma pista para enumerar códigos.
    const row = CODE_SHAPE.test(code) ? await this.prisma.valePass.findUnique({ where: { code } }) : null;
    if (!row) throw new NotFoundException('Voucher não encontrado.');
    return row;
  }

  /** Pedido → voucher (mesma ordem de locks do restante do módulo), tudo relido sob o lock. */
  private async run(located: ValePass, work: (tx: Tx, voucher: ValePass) => Promise<OperationResult>): Promise<OperationResult> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (located.shopifyOrderId) await lockShopifyOrder(tx, located.shopifyOrderId);
        await tx.$executeRaw`SELECT 1 FROM vale_passes WHERE id = ${located.id}::uuid FOR UPDATE`;
        const voucher = await tx.valePass.findUniqueOrThrow({ where: { id: located.id } });
        return work(tx, voucher);
      }, TX_OPTIONS);
    } catch (err) {
      const refusal = ledgerRefusal(err);
      if (refusal) throw refusal;
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Duas confirmações com a MESMA chave chegaram juntas (o lock normalmente impede): trata como repetição segura.
        throw conflict('OPERATION_IN_PROGRESS', 'Esta operação já está sendo processada. Recarregue o voucher para ver o resultado.');
      }
      if (err instanceof HttpException) throw err;
      this.logger.error(`Falha em operação de saldo do voucher ${maskCode(located.code)}: ${err instanceof Error ? err.name : 'unknown'}`);
      throw new ServiceUnavailableException('Não foi possível concluir a operação agora. Nada foi alterado: confira o saldo e tente de novo.');
    }
  }

  /** Mesma chave: mesma operação ⇒ resultado original, sem descontar de novo; conteúdo diferente ⇒ 409. */
  private async replayOf(tx: Tx, voucher: ValePass, operationId: string, requestHash: string, kind: 'REDEEM' | 'REVERSAL'): Promise<OperationResult | null> {
    const existing = await tx.valePassLedgerEntry.findUnique({ where: { valePassId_idempotencyKey: { valePassId: voucher.id, idempotencyKey: operationId } } });
    if (!existing) return null;
    if (existing.requestHash !== requestHash || existing.kind !== kind) {
      throw conflict('IDEMPOTENCY_CONFLICT', 'Este identificador de operação já foi usado com outro conteúdo. Gere uma nova prévia.');
    }
    return this.result(tx, voucher.id, existing, true);
  }

  private async post(
    tx: Tx,
    voucher: ValePass,
    entry: { kind: 'REDEEM' | 'REVERSAL'; deltaCents: number; operationId: string; requestHash: string; reference: string | null; reason: string | null; reversesEntryId?: string; actor: Actor },
  ): Promise<ValePassLedgerEntry> {
    return tx.valePassLedgerEntry.create({
      data: {
        valePassId: voucher.id, seq: 1, balanceAfterCents: 0, // seq e saldo resultante são calculados pelo gatilho do banco
        kind: entry.kind, deltaCents: entry.deltaCents, actorAdminId: entry.actor.id, actorName: entry.actor.name, reason: entry.reason, reference: entry.reference,
        idempotencyKey: entry.operationId, requestHash: entry.requestHash, reversesEntryId: entry.reversesEntryId ?? null,
      },
    });
  }

  private async record(tx: Tx, voucher: ValePass, entry: ValePassLedgerEntry, action: 'VALE_PASS_REDEEMED' | 'VALE_PASS_REDEMPTION_REVERSED', eventType: string, actor: Actor, extra: Record<string, unknown>): Promise<void> {
    await tx.valePassEvent.create({ data: { valePassId: voucher.id, type: eventType, detail: { ledgerEntryId: entry.id, deltaCents: entry.deltaCents, balanceAfterCents: entry.balanceAfterCents, actorId: actor.id, ...extra } as Prisma.InputJsonValue } });
    await writeAdminAuditEvent(tx, {
      adminUserId: actor.id,
      adminUserName: actor.name,
      action,
      entityType: 'ValePass',
      entityId: voucher.id,
      before: { balanceCents: voucher.balanceCents },
      after: { balanceCents: entry.balanceAfterCents },
      detail: { ledgerEntryId: entry.id, deltaCents: entry.deltaCents, company: voucher.company, code: maskCode(voucher.code), orderName: voucher.shopifyOrderName, ...extra },
    });
  }

  private async result(db: Db, voucherId: string, entry: ValePassLedgerEntry, replayed: boolean): Promise<OperationResult> {
    const voucher = await db.valePass.findUniqueOrThrow({ where: { id: voucherId } });
    const reversal = entry.kind === 'REDEEM' ? await db.valePassLedgerEntry.findUnique({ where: { reversesEntryId: entry.id }, select: { id: true } }) : null;
    return { replayed, entry: this.toEntryView(entry, new Set(reversal ? [entry.id] : [])), balanceCents: voucher.balanceCents, usedCents: voucher.amountCents - voucher.balanceCents, status: voucher.status };
  }

  // ─── Regras de elegibilidade (as mesmas na prévia e na confirmação) ──────────────────────────────────────────────────────────────────────────────

  async restrictionsOf(db: Db, voucher: ValePass, now: Date = new Date()): Promise<Restriction[]> {
    const out: Restriction[] = [];
    if (voucher.company === null) out.push('LEGACY_NO_BALANCE');
    if (voucher.status === 'CANCELLED') out.push('CANCELLED');
    if (voucher.status === 'EXPIRED' || (voucher.status === 'ACTIVE' && voucher.expiresAt.getTime() <= now.getTime())) out.push('EXPIRED');
    if (voucher.status === 'USED' || (voucher.company !== null && voucher.balanceCents <= 0 && voucher.status !== 'CANCELLED')) out.push('USED_UP');
    if (voucher.validFrom && voucher.validFrom.getTime() > now.getTime()) out.push('NOT_YET_VALID');
    if (voucher.blockedAt) out.push('BLOCKED');
    if (voucher.shopifyOrderId) {
      if (await db.valePassOrderCancellation.findUnique({ where: { shopifyOrderId: voucher.shopifyOrderId }, select: { shopifyOrderId: true } })) out.push('ORDER_CANCELLED');
      if (voucher.groupId) {
        // Mesma regra do gatilho do banco: revisão NEEDS_REVIEW do pedido cuja lista de unidades contém esta OU está vazia.
        const blocking = await db.$queryRaw<{ id: string }[]>`
          SELECT id FROM vale_pass_refund_applications
          WHERE shopify_order_id = ${voucher.shopifyOrderId} AND status = 'NEEDS_REVIEW'
            AND (detail->'reviewGroupIds' @> to_jsonb(${voucher.groupId}::text) OR jsonb_array_length(coalesce(detail->'reviewGroupIds', '[]'::jsonb)) = 0)
          LIMIT 1`;
        if (blocking.length > 0) out.push('REFUND_UNDER_REVIEW');
      }
    }
    return out;
  }

  private async redeemProblems(db: Db, voucher: ValePass, company: string, amount: number): Promise<{ code: string; message: string }[]> {
    const problems: { code: string; message: string }[] = [];
    if (voucher.company !== null && company !== voucher.company) {
      problems.push({ code: 'COMPANY_MISMATCH', message: 'Este voucher é de outra empresa: o saldo de uma empresa nunca é usado na outra.' });
    }
    for (const code of await this.restrictionsOf(db, voucher)) problems.push({ code, message: RESTRICTION_TEXT[code] });
    if (voucher.company !== null && amount > voucher.balanceCents && !problems.some((p) => p.code === 'USED_UP')) {
      problems.push({ code: 'INSUFFICIENT_BALANCE', message: `Saldo insuficiente: disponível ${formatBRL(voucher.balanceCents)}, solicitado ${formatBRL(amount)}.` });
    }
    return problems;
  }

  private async reverseProblems(db: Db, voucher: ValePass, entryId: string): Promise<{ problems: { code: string; message: string }[]; entry: ValePassLedgerEntry | null }> {
    const problems: { code: string; message: string }[] = [];
    const entry = /^[0-9a-f-]{36}$/i.test(entryId) ? await db.valePassLedgerEntry.findUnique({ where: { id: entryId } }) : null;
    if (!entry || entry.valePassId !== voucher.id) {
      problems.push({ code: 'ENTRY_NOT_FOUND', message: 'Lançamento não encontrado neste voucher.' });
      return { problems, entry: null };
    }
    if (voucher.blockedAt) problems.push({ code: 'BLOCKED', message: RESTRICTION_TEXT.BLOCKED });
    if (entry.kind !== 'REDEEM') problems.push({ code: 'NOT_A_REDEMPTION', message: 'Só um resgate pode ser revertido.' });
    if (await db.valePassLedgerEntry.findUnique({ where: { reversesEntryId: entry.id }, select: { id: true } })) problems.push({ code: 'ALREADY_REVERSED', message: 'Este resgate já foi revertido.' });
    if (entry.kind === 'REDEEM' && voucher.balanceCents - entry.deltaCents > voucher.amountCents) problems.push({ code: 'OVER_CREDIT', message: 'A reversão deixaria o saldo acima do crédito emitido.' });
    return { problems, entry };
  }

  // ─── Visões ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

  private toEntryView(entry: ValePassLedgerEntry, reversedIds: ReadonlySet<string>): LedgerEntryView {
    return {
      id: entry.id, seq: entry.seq, kind: entry.kind, company: entry.company, deltaCents: entry.deltaCents, balanceAfterCents: entry.balanceAfterCents,
      reference: entry.reference, reason: entry.reason, actorName: entry.actorName, createdAt: entry.createdAt.toISOString(), reversesEntryId: entry.reversesEntryId, reversed: reversedIds.has(entry.id),
    };
  }

  private async entriesOf(db: Db, voucherId: string): Promise<LedgerEntryView[]> {
    const rows = await db.valePassLedgerEntry.findMany({ where: { valePassId: voucherId }, orderBy: { seq: 'desc' }, take: HISTORY_LIMIT });
    const reversed = new Set(rows.filter((r) => r.reversesEntryId).map((r) => r.reversesEntryId as string));
    return rows.map((row) => this.toEntryView(row, reversed));
  }

  private async view(db: Db, voucher: ValePass, actor: Actor): Promise<VoucherBalanceView> {
    const restrictions = await this.restrictionsOf(db, voucher);
    const scopes = await activeCompanies(db, actor.id);
    const decision = voucher.company === null ? null : decideCompanyAccess(actor.role, scopes, voucher.company);
    const benefit = voucher.benefitId ? await db.valePassCampaignBenefit.findUnique({ where: { id: voucher.benefitId }, select: { label: true } }) : null;
    return {
      code: voucher.code,
      company: voucher.company,
      benefitLabel: benefit?.label ?? null,
      status: voucher.status,
      amountCents: voucher.amountCents,
      balanceCents: voucher.balanceCents,
      usedCents: voucher.amountCents - voucher.balanceCents,
      validFrom: voucher.validFrom?.toISOString() ?? null,
      expiresAt: voucher.expiresAt.toISOString(),
      blockedAt: voucher.blockedAt?.toISOString() ?? null,
      blockedReason: canOperate(actor.role) ? voucher.blockReason : null,
      blockHistory: (await db.valePassBlockEvent.findMany({ where: { valePassId: voucher.id }, orderBy: { seq: 'desc' }, take: 50 })).map((e) => ({ id: e.id, seq: e.seq, kind: e.kind, reason: canOperate(actor.role) ? e.reason : null, actorName: e.actorName, createdAt: e.createdAt.toISOString() })),
      orderName: voucher.shopifyOrderName,
      holder: {
        name: canOperate(actor.role) ? voucher.customerName : maskName(voucher.customerName),
        phoneMasked: maskPhone(voucher.customerPhone),
        emailMasked: voucher.customerEmail ? maskEmail(voucher.customerEmail) : null,
      },
      redeemable: restrictions.length === 0,
      operatorAccess: {
        canOperate: decision === null ? canOperate(actor.role) : decision.allowed,
        message: decision !== null && !decision.allowed ? decision.message : null,
        summary: describeOperatorAccess(actor.role, scopes),
        companies: operableCompanies(actor.role, scopes),
      },
      restrictions: restrictions.map((code) => ({ code, message: RESTRICTION_TEXT[code] })),
      entries: await this.entriesOf(db, voucher.id),
    };
  }
}
