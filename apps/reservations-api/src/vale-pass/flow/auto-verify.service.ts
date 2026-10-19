import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { Prisma, type ValePassIssuanceHold, type ValePassOrder } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { ShopifyAdminClient } from '../../admin-panel/shopify-admin.client';
import { writeAdminAuditEvent } from '../../admin/admin-audit';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { financialIssueCodes } from '../vale-pass-lots.service';
import { autoVerifyEnabled, envFlowFlags, FLOW_FLAGS_TOKEN, paymentTimeOf, PAYMENT_TIME_UNKNOWN, type FlowFlags } from './flow-flags';
import { decideAutoVerification, nextAttemptAt } from './auto-verify-decision';
import { ValePassPaymentFlowService } from './payment-flow.service';

export const AUTO_VERIFY_BATCH = 10;
export const AUTO_SOURCE = 'ADMIN_API_TRANSACTION_AUTO';
const SYSTEM_ACTOR = { id: null, name: 'Sistema (verificação automática)' } as const;

export interface AutoVerifyReport {
  readonly enabled: boolean;
  readonly considered: number;
  readonly confirmed: number;
  /** Retomadas que emitiram vouchers / que foram reclassificadas pela validação financeira. */
  readonly issued: number;
  readonly reclassified: number;
  readonly held: { readonly orderName: string | null; readonly reason: string }[];
}

interface AutoEvidence {
  webhook?: { triggeredAt?: string | null; payloadUpdatedAt?: string | null };
  transaction?: Record<string, unknown>;
  auto?: { attempts?: number; lastAt?: string; lastReason?: string; nextAttemptAt?: string };
  [key: string]: unknown;
}
const asEvidence = (value: unknown): AutoEvidence => (value && typeof value === 'object' ? (value as AutoEvidence) : {});
const toDate = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Aborta a transação de confirmação (nada é gravado) com um motivo registrado depois como tentativa. */
class AutoAbort extends Error {
  constructor(readonly reason: string, readonly retryable = false) {
    super(reason);
  }
}

/**
 * Verificação financeira AUTOMÁTICA (Valle Pass 2027). Para retenções PAYMENT_TIME_UNKNOWN (e SÓ elas): consulta as transações do pedido na Shopify
 * (somente leitura, fora de transação de banco), decide com `decideAutoVerification` e, se tudo bate, confirma o horário e retoma a retenção pelo MESMO caminho
 * do ADMIN (`resumeOne`: validação financeira completa, capacidade, vouchers + fila de e-mail na mesma transação). Qualquer dúvida mantém a retenção.
 * Desligada por padrão (VALE_PASS_AUTO_VERIFY=on + VALE_PASS_TWO_VOUCHER_FLOW=on). Idempotente: sob o lock do pedido a transação revalida tudo.
 */
@Injectable()
export class ValePassAutoVerifyService {
  private readonly logger = new Logger(ValePassAutoVerifyService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(ShopifyAdminClient) private readonly shopify: ShopifyAdminClient | null = null,
    @Optional() @Inject(ValePassPaymentFlowService) private readonly flow: ValePassPaymentFlowService | null = null,
    @Optional() @Inject(FLOW_FLAGS_TOKEN) private readonly flags: FlowFlags = envFlowFlags(),
  ) {}

  async runOnce(now: Date = new Date()): Promise<AutoVerifyReport> {
    const report = { enabled: autoVerifyEnabled(this.flags), considered: 0, confirmed: 0, issued: 0, reclassified: 0, held: [] as { orderName: string | null; reason: string }[] };
    if (!report.enabled || !this.shopify || !this.flow) return report;

    const open = await this.prisma.valePassIssuanceHold.findMany({ where: { status: 'OPEN', reason: 'FINANCIAL_MISMATCH' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 500 });
    // Só retenções cujo ÚNICO problema é o horário desconhecido: qualquer outro motivo é decisão do ADMIN.
    const candidates = open.filter((hold) => {
      const codes = financialIssueCodes(hold.detail);
      return codes.length > 0 && codes.every((code) => code === PAYMENT_TIME_UNKNOWN);
    });
    for (const hold of candidates) {
      if (report.considered >= AUTO_VERIFY_BATCH) break;
      const outcome = await this.processOne(hold, now);
      if (outcome.kind === 'NOT_DUE') continue;
      report.considered++;
      if (outcome.kind === 'ISSUED') {
        report.confirmed++;
        report.issued++;
      } else if (outcome.kind === 'RECLASSIFIED') {
        report.confirmed++;
        report.reclassified++;
      } else if (outcome.kind === 'HELD') report.held.push({ orderName: outcome.orderName, reason: outcome.reason });
    }
    return report;
  }

  private async processOne(
    hold: ValePassIssuanceHold,
    now: Date,
  ): Promise<{ kind: 'NOT_DUE' | 'ISSUED' | 'RECLASSIFIED' | 'SKIPPED' } | { kind: 'HELD'; orderName: string | null; reason: string }> {
    const registry = await this.prisma.valePassOrder.findUnique({ where: { shopifyOrderId: hold.shopifyOrderId } });
    if (!registry || registry.paymentConfirmedAt || registry.status !== 'CONFIRMED' || registry.deletedInShopifyAt) return { kind: 'SKIPPED' };
    const evidence = asEvidence(registry.paymentTimeEvidence);
    const due = toDate(evidence.auto?.nextAttemptAt);
    if (due && due.getTime() > now.getTime()) return { kind: 'NOT_DUE' };
    const held = (reason: string) => ({ kind: 'HELD' as const, orderName: registry.shopifyOrderName, reason });

    const campaign = await this.prisma.valePassCampaign.findUnique({ where: { id: hold.campaignId } });
    const gid = registry.shopifyOrderGid ?? (/^\d+$/.test(registry.shopifyOrderId) ? `gid://shopify/Order/${registry.shopifyOrderId}` : null);
    if (!campaign || !gid) {
      await this.recordAttempt(registry, now, !campaign ? 'CAMPAIGN_NOT_FOUND' : 'ORDER_GID_UNKNOWN', false, null);
      return held(!campaign ? 'CAMPAIGN_NOT_FOUND' : 'ORDER_GID_UNKNOWN');
    }

    // REDE FORA de qualquer transação de banco: somente leitura.
    let fetched: Awaited<ReturnType<ShopifyAdminClient['getOrderPaymentTransactions']>>;
    try {
      fetched = await (this.shopify as ShopifyAdminClient).getOrderPaymentTransactions(gid);
    } catch (err) {
      this.logger.warn(`Verificação automática: consulta do pedido ${registry.shopifyOrderId} falhou (${err instanceof Error ? err.name : 'unknown'}).`);
      await this.recordAttempt(registry, now, 'SHOPIFY_UNAVAILABLE', true, null);
      return held('SHOPIFY_UNAVAILABLE');
    }
    if (!fetched) {
      await this.recordAttempt(registry, now, 'ORDER_NOT_RETURNED', false, null);
      return held('ORDER_NOT_RETURNED');
    }

    const decision = decideAutoVerification({
      fetched,
      expectedOrderGid: gid,
      unitPriceCents: campaign.amountCents,
      quantity: registry.quantity,
      webhook: { triggered: toDate(evidence.webhook?.triggeredAt), updated: toDate(evidence.webhook?.payloadUpdatedAt) },
      orderCreatedAt: registry.orderCreatedAt,
      config: paymentTimeOf(this.flags),
      now,
    });
    if (!decision.confirm) {
      await this.recordAttempt(registry, now, decision.reason, decision.retryable, decision.instant);
      return held(decision.reason);
    }

    try {
      const result = await this.prisma.$transaction((tx) => this.confirmAndResume(tx, hold, registry, decision.instant, decision.used, now), { timeout: 30_000, maxWait: 10_000 });
      return { kind: result };
    } catch (err) {
      if (err instanceof AutoAbort) {
        await this.recordAttempt(registry, now, err.reason, err.retryable, decision.instant);
        return held(err.reason);
      }
      this.logger.error(`Verificação automática: falha ao confirmar/retomar o pedido ${registry.shopifyOrderId}: ${err instanceof Error ? err.name : 'unknown'}`);
      await this.recordAttempt(registry, now, 'RESUME_FAILED', true, decision.instant).catch(() => undefined);
      return held('RESUME_FAILED');
    }
  }

  /** Sob o lock do pedido: revalida TUDO e, só então, confirma o horário e retoma. Falhou qualquer coisa → AutoAbort e nada é gravado. */
  private async confirmAndResume(tx: Prisma.TransactionClient, hold: ValePassIssuanceHold, seen: ValePassOrder, instant: Date, used: number, now: Date): Promise<'ISSUED' | 'RECLASSIFIED'> {
    await lockShopifyOrder(tx, seen.shopifyOrderId);
    const current = await tx.valePassOrder.findUnique({ where: { shopifyOrderId: seen.shopifyOrderId } });
    if (!current || current.paymentConfirmedAt) throw new AutoAbort('ALREADY_HANDLED');
    if (current.status !== 'CONFIRMED' || current.deletedInShopifyAt) throw new AutoAbort('ORDER_NOT_PAID_ANYMORE');
    // O pedido mudou (quantidade, qualquer atualização) enquanto a Shopify era consultada: a verificação não vale mais; tenta de novo do zero.
    if (current.quantity !== seen.quantity || current.shopifyUpdatedAt?.getTime() !== seen.shopifyUpdatedAt?.getTime()) throw new AutoAbort('ORDER_CHANGED_DURING_CHECK', true);
    if (await tx.valePassOrderCancellation.findUnique({ where: { shopifyOrderId: seen.shopifyOrderId } })) throw new AutoAbort('ORDER_CANCELLED');
    const live = await tx.valePassIssuanceHold.findUnique({ where: { id: hold.id } });
    if (!live || live.status !== 'OPEN') throw new AutoAbort('HOLD_NOT_OPEN');
    const codes = financialIssueCodes(live.detail);
    if (codes.length === 0 || !codes.every((code) => code === PAYMENT_TIME_UNKNOWN)) throw new AutoAbort('HOLD_CHANGED');

    const evidence = asEvidence(current.paymentTimeEvidence);
    const merged: AutoEvidence = {
      ...evidence,
      transaction: { instant: instant.toISOString(), reason: 'OK', checkedAt: now.toISOString(), used },
      auto: { attempts: (evidence.auto?.attempts ?? 0) + 1, lastAt: now.toISOString(), lastReason: 'CONFIRMED' },
    };
    await tx.valePassOrder.update({ where: { id: current.id }, data: { paymentConfirmedAt: instant, paymentConfirmedSource: AUTO_SOURCE, paymentTimeEvidence: merged as unknown as Prisma.InputJsonValue } });
    await tx.valePassOrderEvent.create({ data: { valePassOrderId: current.id, type: 'PAYMENT_TIME_CONFIRMED', detail: { source: AUTO_SOURCE, auto: true } as Prisma.InputJsonValue } });

    const result = await (this.flow as ValePassPaymentFlowService).resumeOne(tx, live, SYSTEM_ACTOR);
    if (result.kind === 'SKIPPED') throw new AutoAbort('RESUME_SKIPPED', true); // reverte também o horário: nada fica confirmado sem a retomada ter rodado
    await writeAdminAuditEvent(tx, {
      adminUserId: null,
      adminUserName: SYSTEM_ACTOR.name,
      action: 'VALE_PASS_PAYMENT_TIME_AUTO_CONFIRMED',
      entityType: 'ValePassOrder',
      entityId: current.id,
      before: { paymentConfirmedAt: null },
      after: { paymentConfirmedAt: instant.toISOString(), source: AUTO_SOURCE, outcome: result.kind },
      detail: { orderId: seen.shopifyOrderId, transactionsUsed: used },
    });
    return result.kind;
  }

  /** Registra a tentativa (sem emitir nada) para a lista do ADMIN e para o intervalo da próxima. Sob o lock; não mexe em pedido já tratado. */
  private async recordAttempt(registry: ValePassOrder, now: Date, reason: string, retryable: boolean, instant: Date | null): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockShopifyOrder(tx, registry.shopifyOrderId);
      const current = await tx.valePassOrder.findUnique({ where: { shopifyOrderId: registry.shopifyOrderId } });
      if (!current || current.paymentConfirmedAt) return;
      const evidence = asEvidence(current.paymentTimeEvidence);
      const attempts = (evidence.auto?.attempts ?? 0) + 1;
      const merged: AutoEvidence = {
        ...evidence,
        transaction: { instant: instant?.toISOString() ?? null, reason, checkedAt: now.toISOString() },
        auto: { attempts, lastAt: now.toISOString(), lastReason: reason, nextAttemptAt: nextAttemptAt(now, attempts, retryable).toISOString() },
      };
      await tx.valePassOrder.update({ where: { id: current.id }, data: { paymentTimeEvidence: merged as unknown as Prisma.InputJsonValue } });
    });
  }
}

const intervalSeconds = (env: Record<string, string | undefined> = process.env): number => {
  const raw = Number(env.VALE_PASS_AUTO_VERIFY_INTERVAL_SECONDS);
  return Number.isInteger(raw) && raw >= 20 && raw <= 900 ? raw : 60;
};

@Injectable()
export class ValePassAutoVerifyScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ValePassAutoVerifyScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @Inject(ValePassAutoVerifyService) private readonly service: ValePassAutoVerifyService,
    @Optional() @Inject(FLOW_FLAGS_TOKEN) private readonly flags: FlowFlags = envFlowFlags(),
  ) {}

  onModuleInit(): void {
    if (!autoVerifyEnabled(this.flags)) {
      this.logger.log('Verificação automática do pagamento do Valle Pass DESLIGADA (VALE_PASS_AUTO_VERIFY).');
      return;
    }
    this.logger.log(`Verificação automática do pagamento do Valle Pass ATIVA a cada ${intervalSeconds()} s.`);
    this.timer = setInterval(() => void this.runOnce(), intervalSeconds() * 1000);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Nunca sobrepõe execuções e nunca derruba o processo. */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.service.runOnce();
    } catch (err) {
      this.logger.error(`Verificação automática falhou: ${err instanceof Error ? err.name : 'unknown'}`);
    } finally {
      this.running = false;
    }
  }
}
