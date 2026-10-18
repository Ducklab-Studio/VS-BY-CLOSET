import { ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ShopifyAdminClient } from '../../admin-panel/shopify-admin.client';
import { writeAdminAuditEvent } from '../../admin/admin-audit';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { financialIssueCodes } from '../vale-pass-lots.service';
import { envFlowFlags, FLOW_FLAGS_TOKEN, paymentTimeOf, PAYMENT_TIME_UNKNOWN, type FlowFlags } from './flow-flags';
import { PAYMENT_INSTANT_SKEW_MS, parseIsoInstant } from './payment-instant';
import { paymentInstantFromTransactions } from './payment-transactions';
import { decidePaymentTime, type WebhookSignal } from './payment-time-policy';

type Tx = Prisma.TransactionClient;

export interface PaymentTimeCandidate {
  readonly orderId: string;
  readonly orderName: string | null;
  readonly quantity: number;
  /** Sinais do webhook (candidatos; não confirmam nada sozinhos). */
  readonly webhookTriggeredAt: string | null;
  readonly webhookUpdatedAt: string | null;
  readonly webhookDeltaSeconds: number | null;
  /** O que a Admin API disse na última conferência (nulo = nunca conferido). */
  readonly transactionInstant: string | null;
  readonly transactionReason: string | null;
  readonly heldSince: string;
}

export type VerifyOutcome =
  | { readonly status: 'CONFIRMED'; readonly confirmedAt: string; readonly source: string }
  | { readonly status: 'ALREADY_CONFIRMED'; readonly confirmedAt: string }
  | { readonly status: 'UNKNOWN'; readonly reason: string; readonly transactionInstant: string | null; readonly webhookTriggeredAt: string | null };

interface Evidence {
  webhook?: { triggeredAt?: string | null; payloadUpdatedAt?: string | null; deltaSeconds?: number | null };
  transaction?: { instant: string | null; reason: string; checkedAt?: string; used?: number };
  manual?: Record<string, unknown>;
}

const asEvidence = (value: unknown): Evidence => (value && typeof value === 'object' ? (value as Evidence) : {});
const toDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/**
 * Resolução do HORÁRIO DO PAGAMENTO (Valle Pass 2027) — ações de ADMIN, sempre auditadas, nunca automáticas.
 *  - `verifyFromShopify`: lê as transações financeiras na Shopify Admin API (SOMENTE LEITURA, fora de transação de banco), aplica a política
 *    (`payment-time-policy.ts`) e só confirma se a fonte autoritativa afirma o horário e concorda com o webhook; divergência ou ausência = continua desconhecido.
 *  - `confirmManually`: o ADMIN informa o horário (conferido na Shopify), com justificativa; fica registrado como ADMIN_MANUAL com os candidatos à vista.
 * Depois de confirmar o horário, a retenção PAYMENT_TIME_UNKNOWN é liberada pela "Retomada" (que revalida o pagamento antes de emitir).
 */
@Injectable()
export class ValePassPaymentTimeService {
  private readonly logger = new Logger(ValePassPaymentTimeService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(ShopifyAdminClient) private readonly shopify: ShopifyAdminClient | null = null,
    @Optional() @Inject(FLOW_FLAGS_TOKEN) private readonly flags: FlowFlags = envFlowFlags(),
  ) {}

  /** Pedidos pagos retidos por horário desconhecido, com os candidatos que o sistema já tem. Sem dados pessoais. */
  async candidates(limit = 50): Promise<PaymentTimeCandidate[]> {
    const holds = await this.prisma.valePassIssuanceHold.findMany({ where: { status: 'OPEN', reason: 'FINANCIAL_MISMATCH' }, orderBy: { createdAt: 'asc' }, take: 500 });
    const pending = holds.filter((hold) => financialIssueCodes(hold.detail).includes(PAYMENT_TIME_UNKNOWN)).slice(0, limit);
    const orders = await this.prisma.valePassOrder.findMany({ where: { shopifyOrderId: { in: pending.map((hold) => hold.shopifyOrderId) } } });
    const byId = new Map(orders.map((order) => [order.shopifyOrderId, order]));
    const fromHolds = pending.flatMap((hold) => {
      const order = byId.get(hold.shopifyOrderId);
      if (!order || order.paymentConfirmedAt) return [];
      return [{ order, since: hold.createdAt }];
    });
    // Pedidos pagos SEM voucher e SEM retenção (ex.: variante sem campanha, cadastrada depois) também precisam do horário para serem regularizados.
    const heldIds = new Set(pending.map((hold) => hold.shopifyOrderId));
    const bare = await this.prisma.valePassOrder.findMany({
      where: { status: 'CONFIRMED', deletedInShopifyAt: null, paymentConfirmedAt: null, paymentTimeEvidence: { not: Prisma.DbNull }, shopifyOrderId: { notIn: [...heldIds] } },
      orderBy: { statusChangedAt: 'asc' },
      take: 200,
    });
    const withVouchers = new Set((await this.prisma.valePass.findMany({ where: { shopifyOrderId: { in: bare.map((order) => order.shopifyOrderId) } }, select: { shopifyOrderId: true }, distinct: ['shopifyOrderId'] })).map((row) => row.shopifyOrderId));
    const cancelled = new Set((await this.prisma.valePassOrderCancellation.findMany({ where: { shopifyOrderId: { in: bare.map((order) => order.shopifyOrderId) } }, select: { shopifyOrderId: true } })).map((row) => row.shopifyOrderId));
    const fromBare = bare.filter((order) => !withVouchers.has(order.shopifyOrderId) && !cancelled.has(order.shopifyOrderId) && order.quantity > 0).map((order) => ({ order, since: order.statusChangedAt }));
    return [...fromHolds, ...fromBare].slice(0, limit).flatMap(({ order, since }) => {
      const evidence = asEvidence(order.paymentTimeEvidence);
      return [
        {
          orderId: order.shopifyOrderId,
          orderName: order.shopifyOrderName,
          quantity: order.quantity,
          webhookTriggeredAt: evidence.webhook?.triggeredAt ?? null,
          webhookUpdatedAt: evidence.webhook?.payloadUpdatedAt ?? null,
          webhookDeltaSeconds: evidence.webhook?.deltaSeconds ?? null,
          transactionInstant: evidence.transaction?.instant ?? null,
          transactionReason: evidence.transaction?.reason ?? null,
          heldSince: since.toISOString(),
        },
      ];
    });
  }

  async verifyFromShopify(actor: { id: string; name: string }, input: { orderId: string; note: string }): Promise<VerifyOutcome> {
    const note = this.requireNote(input.note);
    await this.requireAdmin(this.prisma, actor.id);
    const registry = await this.prisma.valePassOrder.findUnique({ where: { shopifyOrderId: input.orderId } });
    if (!registry) throw new NotFoundException('Pedido não encontrado no registro do Valle Pass.');
    if (registry.paymentConfirmedAt) return { status: 'ALREADY_CONFIRMED', confirmedAt: registry.paymentConfirmedAt.toISOString() };
    this.requirePaid(registry);
    if (!this.shopify) throw new ConflictException('A Shopify Admin API não está configurada neste ambiente: confirme o horário manualmente.');

    // REDE FORA da transação: a consulta é somente leitura e pode demorar.
    const gid = registry.shopifyOrderGid ?? (/^\d+$/.test(input.orderId) ? `gid://shopify/Order/${input.orderId}` : null);
    if (!gid) throw new ConflictException('Pedido sem identificador da Shopify: confirme o horário manualmente.');
    let fetched: Awaited<ReturnType<ShopifyAdminClient['getOrderPaymentTransactions']>>;
    try {
      fetched = await this.shopify.getOrderPaymentTransactions(gid);
    } catch (err) {
      if (err instanceof HttpException && /não configurada/i.test(err.message)) throw new ConflictException('A Shopify Admin API não está configurada neste ambiente: confirme o horário manualmente.');
      this.logger.warn(`Consulta das transações do pedido ${input.orderId} falhou: ${err instanceof Error ? err.name : 'unknown'}`);
      throw new ServiceUnavailableException('Não foi possível consultar a Shopify agora. Nada foi alterado: tente de novo ou confirme o horário manualmente.');
    }
    if (!fetched) throw new ConflictException('A Shopify não devolveu o pedido (fora da janela de acesso da API ou sem permissão): confirme o horário manualmente.');
    const verdict = paymentInstantFromTransactions(fetched, { allowTest: process.env.VALE_PASS_PAYMENT_TIME_ALLOW_TEST_TRANSACTIONS?.trim().toLowerCase() === 'on' });

    return this.prisma.$transaction(
      async (tx) => {
        await lockShopifyOrder(tx, input.orderId);
        await this.requireAdmin(tx, actor.id);
        const current = await tx.valePassOrder.findUniqueOrThrow({ where: { shopifyOrderId: input.orderId } });
        if (current.paymentConfirmedAt) return { status: 'ALREADY_CONFIRMED' as const, confirmedAt: current.paymentConfirmedAt.toISOString() };
        this.requirePaid(current);
        const evidence = asEvidence(current.paymentTimeEvidence);
        const signal: WebhookSignal = { triggered: toDate(evidence.webhook?.triggeredAt), updated: toDate(evidence.webhook?.payloadUpdatedAt) };
        const decision = decidePaymentTime({ config: paymentTimeOf(this.flags), webhook: signal, transaction: { instant: verdict.instant, reason: verdict.reason } });
        const merged: Evidence = { ...evidence, transaction: { instant: verdict.instant?.toISOString() ?? null, reason: verdict.reason, checkedAt: new Date().toISOString(), used: verdict.used } };
        const data: Prisma.ValePassOrderUpdateInput = { paymentTimeEvidence: merged as unknown as Prisma.InputJsonValue };
        if (decision.trusted) {
          data.paymentConfirmedAt = decision.trusted;
          data.paymentConfirmedSource = decision.source;
        }
        await tx.valePassOrder.update({ where: { id: current.id }, data });
        await tx.valePassOrderEvent.create({
          data: { valePassOrderId: current.id, type: decision.trusted ? 'PAYMENT_TIME_CONFIRMED' : 'PAYMENT_TIME_CHECKED', detail: { source: decision.source, reason: decision.reason, actorId: actor.id, transactionReason: verdict.reason } as Prisma.InputJsonValue },
        });
        await writeAdminAuditEvent(tx, {
          adminUserId: actor.id,
          adminUserName: actor.name,
          action: decision.trusted ? 'VALE_PASS_PAYMENT_TIME_CONFIRMED' : 'VALE_PASS_PAYMENT_TIME_CHECKED',
          entityType: 'ValePassOrder',
          entityId: current.id,
          before: { paymentConfirmedAt: null },
          after: { paymentConfirmedAt: decision.trusted?.toISOString() ?? null, source: decision.source, reason: decision.reason },
          detail: { orderId: input.orderId, note, webhookTriggeredAt: evidence.webhook?.triggeredAt ?? null, transactionReason: verdict.reason },
        });
        if (decision.trusted) return { status: 'CONFIRMED' as const, confirmedAt: decision.trusted.toISOString(), source: decision.source };
        return { status: 'UNKNOWN' as const, reason: decision.reason === 'TRANSACTION_UNAVAILABLE' ? verdict.reason : decision.reason, transactionInstant: verdict.instant?.toISOString() ?? null, webhookTriggeredAt: evidence.webhook?.triggeredAt ?? null };
      },
      { timeout: 20_000, maxWait: 10_000 },
    );
  }

  /** O ADMIN informa o horário (conferido na Shopify). Fica ADMIN_MANUAL, com justificativa e os candidatos do sistema registrados. */
  async confirmManually(actor: { id: string; name: string }, input: { orderId: string; confirmedAt: string; note: string }): Promise<{ confirmedAt: string }> {
    const note = this.requireNote(input.note);
    const parsed = parseIsoInstant(input.confirmedAt);
    if (!parsed) throw new UnprocessableEntityException('Informe o horário em formato ISO 8601 com fuso (ex.: 2026-10-18T14:30:00-03:00).');
    return this.prisma.$transaction(
      async (tx) => {
        await lockShopifyOrder(tx, input.orderId);
        await this.requireAdmin(tx, actor.id);
        const current = await tx.valePassOrder.findUnique({ where: { shopifyOrderId: input.orderId } });
        if (!current) throw new NotFoundException('Pedido não encontrado no registro do Valle Pass.');
        this.requirePaid(current);
        if (current.paymentConfirmedAt) throw new ConflictException('O horário do pagamento deste pedido já está confirmado.');
        const now = Date.now();
        if (parsed.getTime() > now + PAYMENT_INSTANT_SKEW_MS) throw new UnprocessableEntityException('O horário informado está no futuro.');
        if (current.orderCreatedAt && parsed.getTime() < current.orderCreatedAt.getTime() - PAYMENT_INSTANT_SKEW_MS) throw new UnprocessableEntityException('O horário informado é anterior à criação do pedido.');
        const evidence = asEvidence(current.paymentTimeEvidence);
        const merged: Evidence = { ...evidence, manual: { instant: parsed.toISOString(), by: actor.id, at: new Date().toISOString() } };
        await tx.valePassOrder.update({ where: { id: current.id }, data: { paymentConfirmedAt: parsed, paymentConfirmedSource: 'ADMIN_MANUAL', paymentTimeEvidence: merged as unknown as Prisma.InputJsonValue } });
        await tx.valePassOrderEvent.create({ data: { valePassOrderId: current.id, type: 'PAYMENT_TIME_CONFIRMED', detail: { source: 'ADMIN_MANUAL', actorId: actor.id } as Prisma.InputJsonValue } });
        await writeAdminAuditEvent(tx, {
          adminUserId: actor.id,
          adminUserName: actor.name,
          action: 'VALE_PASS_PAYMENT_TIME_CONFIRMED',
          entityType: 'ValePassOrder',
          entityId: current.id,
          before: { paymentConfirmedAt: null },
          after: { paymentConfirmedAt: parsed.toISOString(), source: 'ADMIN_MANUAL' },
          detail: { orderId: input.orderId, note, webhookTriggeredAt: evidence.webhook?.triggeredAt ?? null, transactionInstant: evidence.transaction?.instant ?? null },
        });
        this.logger.warn(`Horário do pagamento do pedido ${input.orderId} confirmado manualmente por um administrador.`);
        return { confirmedAt: parsed.toISOString() };
      },
      { timeout: 20_000, maxWait: 10_000 },
    );
  }

  private requireNote(raw: string): string {
    const note = (raw ?? '').trim();
    if (note.length < 10) throw new UnprocessableEntityException('Informe a justificativa (mínimo de 10 caracteres).');
    return note;
  }

  private requirePaid(order: { status: string; deletedInShopifyAt: Date | null }): void {
    if (order.status !== 'CONFIRMED' || order.deletedInShopifyAt) throw new ConflictException('O pedido não está pago/ativo: não há horário de pagamento a confirmar.');
  }

  private async requireAdmin(db: Pick<Tx, 'adminUser'>, id: string): Promise<void> {
    const admin = await db.adminUser.findUnique({ where: { id }, select: { role: true, active: true } });
    if (!admin || !admin.active || admin.role !== 'ADMIN') throw new ForbiddenException('Somente um administrador ativo pode confirmar o horário do pagamento.');
  }
}
