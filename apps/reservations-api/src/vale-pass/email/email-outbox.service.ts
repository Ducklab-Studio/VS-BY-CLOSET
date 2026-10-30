import { ConflictException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ValePass, ValePassCampaignBenefit, ValePassEmailOutbox, ValePassEmailStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { writeAdminAuditEvent } from '../../admin/admin-audit';
import { lockShopifyOrder } from '../../webhooks/shopify-order-lock';
import { EMAIL_CONFIG_TOKEN } from './email-tokens';
import { DELIVERY_DEADLINE_DAYS, publicEmailStatus, recipientAllowed, recipientsUnrestricted, senderAddress, type EmailConfig } from './email-config';
import { renderVoucherEmail } from './email-template';
import { isTestCampaign } from '../vale-pass-test-campaign';
import { maskCode, maskCodeFully, maskEmail } from './email-mask';

type Tx = Prisma.TransactionClient;
type Db = Tx | PrismaService;

const EMAIL_SHAPE = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
export const MAX_MANUAL_RESENDS = 5;
export const MIN_RESEND_NOTE = 10;
const DAY_MS = 86_400_000;

export const isValidRecipient = (value: string | null | undefined): value is string => Boolean(value && value.length <= 320 && EMAIL_SHAPE.test(value.trim()));

/** Estados em que a mensagem ainda pode sair por conta própria (ou está saindo). */
export const IN_FLIGHT_STATUSES: readonly ValePassEmailStatus[] = ['QUEUED', 'SENDING', 'UNKNOWN'];
/** "Entregue ao cliente" para fins do prazo: a Resend aceitou a mensagem. */
export const SATISFIED_STATUSES: readonly ValePassEmailStatus[] = ['ACCEPTED', 'DELIVERED'];

export type GroupVerdict =
  | { readonly ok: true; readonly order: { readonly orderId: string; readonly orderName: string | null; readonly customerName: string | null; readonly customerEmail: string | null; readonly confirmedAt: Date; readonly paymentConfirmedAt: Date | null }; readonly vouchers: readonly (ValePass & { benefit: ValePassCampaignBenefit | null })[]; readonly unit: { readonly index: number; readonly total: number }; readonly testCampaign: boolean }
  | { readonly ok: false; readonly outcome: 'CANCELLED' | 'NEEDS_ATTENTION' | 'WAIT'; readonly reason: string };

/**
 * Pode sair um e-mail com os códigos desta unidade? SIM somente se, AGORA: o pedido está pago (CONFIRMED), não foi excluído, cancelado nem
 * reembolsado; a unidade tem exatamente os vouchers ativos da campanha (emissão completa) e todos estão ACTIVE.
 */
export async function evaluateGroup(db: Db, orderId: string, groupId: string): Promise<GroupVerdict> {
  const order = await db.valePassOrder.findUnique({ where: { shopifyOrderId: orderId } });
  if (!order) return { ok: false, outcome: 'CANCELLED', reason: 'order_missing' };
  if (order.deletedInShopifyAt) return { ok: false, outcome: 'CANCELLED', reason: 'order_deleted' };
  const cancelled = await db.valePassOrderCancellation.findUnique({ where: { shopifyOrderId: orderId } });
  if (cancelled || order.status !== 'CONFIRMED') return { ok: false, outcome: 'CANCELLED', reason: 'order_not_paid' };
  // Reembolso do pedido aguardando decisão do ADMIN: os vouchers seguem ACTIVE (bloqueados para uso), mas NÃO se entrega o código ao cliente até a revisão ser resolvida.
  if ((await db.valePassRefundApplication.count({ where: { shopifyOrderId: orderId, status: 'NEEDS_REVIEW' } })) > 0) return { ok: false, outcome: 'NEEDS_ATTENTION', reason: 'refund_under_review' };

  const vouchers = await db.valePass.findMany({ where: { shopifyOrderId: orderId, groupId }, include: { benefit: true }, orderBy: { createdAt: 'asc' } });
  if (vouchers.length === 0) return { ok: false, outcome: 'NEEDS_ATTENTION', reason: 'group_missing' };
  if (vouchers.some((voucher) => voucher.blockedAt !== null)) return { ok: false, outcome: 'NEEDS_ATTENTION', reason: 'voucher_blocked' };
  if (vouchers.some((voucher) => voucher.status === 'CANCELLED' || voucher.status === 'EXPIRED')) return { ok: false, outcome: 'CANCELLED', reason: 'voucher_not_active' };
  if (vouchers.some((voucher) => voucher.status === 'USED' || (voucher.company !== null && voucher.balanceCents < voucher.amountCents))) return { ok: false, outcome: 'NEEDS_ATTENTION', reason: 'voucher_already_used' };

  const campaignId = vouchers[0].campaignId;
  const campaignRow = await db.valePassCampaign.findUnique({ where: { id: campaignId }, select: { id: true, shopifyVariantId: true } });
  const expected = await db.valePassCampaignBenefit.findMany({ where: { campaignId, active: true, kind: 'VOUCHER' }, select: { id: true } });
  const present = new Set(vouchers.map((voucher) => voucher.benefitId));
  if (expected.length === 0 || expected.some((benefit) => !present.has(benefit.id))) return { ok: false, outcome: 'WAIT', reason: 'group_incomplete' };

  const groups = await db.valePass.groupBy({ by: ['groupId'], where: { shopifyOrderId: orderId, campaignId, groupId: { not: null } }, _min: { createdAt: true } });
  const ordered = groups.map((group) => ({ id: group.groupId as string, at: group._min.createdAt as Date })).sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
  return {
    ok: true,
    order: { orderId, orderName: order.shopifyOrderName, customerName: order.customerName, customerEmail: order.customerEmail, confirmedAt: order.statusChangedAt, paymentConfirmedAt: order.paymentConfirmedAt },
    vouchers,
    unit: { index: Math.max(1, ordered.findIndex((group) => group.id === groupId) + 1), total: Math.max(1, ordered.length) },
    testCampaign: campaignRow !== null && isTestCampaign(campaignRow),
  };
}

export interface EnqueueResult {
  readonly enqueued: number;
  readonly alreadyQueued: number;
  readonly notEligible: number;
}

export interface EmailListItem {
  readonly id: string;
  readonly orderId: string;
  readonly orderName: string | null;
  readonly kind: 'INITIAL' | 'RESEND';
  readonly status: ValePassEmailStatus;
  readonly toMasked: string;
  readonly codesMasked: readonly string[];
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: string;
  readonly lastError: string | null;
  readonly deadlineAt: string;
  /** Prazo de 3 dias vencido sem a Resend ter aceitado a mensagem (nem um reenvio dela). */
  readonly overdue: boolean;
  readonly createdAt: string;
  readonly acceptedAt: string | null;
  readonly deliveredAt: string | null;
  readonly failedAt: string | null;
  readonly resendOfId: string | null;
}

export interface EmailSummary {
  readonly config: ReturnType<typeof publicEmailStatus>;
  readonly counts: Readonly<Record<ValePassEmailStatus, number>>;
  readonly overdue: number;
  readonly atRisk: number;
  readonly acceptedLast24h: number;
  readonly dailyLimit: number;
  readonly alerts: readonly { readonly code: string; readonly severity: 'critical' | 'warning' | 'info'; readonly message: string }[];
}

const ALL_STATUSES: readonly ValePassEmailStatus[] = ['QUEUED', 'SENDING', 'UNKNOWN', 'ACCEPTED', 'DELIVERED', 'FAILED', 'NEEDS_ATTENTION', 'CANCELLED'];

@Injectable()
export class ValePassEmailOutboxService {
  private readonly logger = new Logger(ValePassEmailOutboxService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EMAIL_CONFIG_TOKEN) private readonly config: EmailConfig,
  ) {}

  /** Registra um fato na linha do tempo (sem código de voucher nem e-mail completo). */
  async recordEvent(db: Db, outboxId: string, type: string, detail?: Record<string, unknown>): Promise<void> {
    await db.valePassEmailEvent.create({ data: { outboxId, type, detail: (detail ?? Prisma.JsonNull) as Prisma.InputJsonValue } });
  }

  /**
   * Enfileira UM e-mail inicial por unidade comercial COMPLETA e paga do pedido. Chamar na MESMA transação (e sob o lock do pedido) em que as
   * unidades são emitidas/completadas — ou pelo reconciliador. Idempotente: a segunda chamada não cria nada (\`dedupe_key\` único).
   * Não envia: só grava na caixa de saída. Pedido não pago/cancelado/reembolsado e unidade incompleta nunca entram.
   */
  async enqueueForOrder(tx: Tx, orderId: string, now: Date = new Date(), options: { fallbackConfirmedAt?: Date | null } = {}): Promise<EnqueueResult> {
    const withGroups = await tx.valePass.findMany({
      where: { shopifyOrderId: orderId, groupId: { not: null } },
      select: { groupId: true, campaignId: true },
      distinct: ['groupId'],
    });
    let enqueued = 0;
    let alreadyQueued = 0;
    let notEligible = 0;
    for (const { groupId, campaignId } of withGroups) {
      if (!groupId) continue;
      const verdict = await evaluateGroup(tx, orderId, groupId);
      if (!verdict.ok) {
        notEligible++;
        continue;
      }
      const recipient = verdict.order.customerEmail?.trim() ?? '';
      const valid = isValidRecipient(recipient);
      const id = randomUUID();
      // O prazo de 3 dias conta do PAGAMENTO real (X-Shopify-Triggered-At do orders/paid). Sem ele, o chamador pode indicar o único instante real que o sistema
      // conhece (ex.: quando a retenção foi aberta); por último, a mudança de status do registro. A base usada fica na linha do tempo da mensagem.
      const paymentAt = verdict.order.paymentConfirmedAt;
      const deadlineBasis = paymentAt ? 'PAYMENT' : options.fallbackConfirmedAt ? 'HOLD_OPENED' : 'STATUS_CHANGED';
      const deadlineFrom = paymentAt ?? options.fallbackConfirmedAt ?? verdict.order.confirmedAt;
      const deadlineAt = new Date(deadlineFrom.getTime() + DELIVERY_DEADLINE_DAYS * DAY_MS);
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO vale_pass_email_outbox (id, shopify_order_id, campaign_id, group_id, kind, dedupe_key, to_email, recipient_name, status, next_attempt_at, idempotency_key, last_error, deadline_at, updated_at)
        VALUES (${id}::uuid, ${orderId}, ${campaignId}::uuid, ${groupId}::uuid, 'INITIAL', ${`initial:${groupId}`}, ${valid ? recipient : ''}, ${verdict.order.customerName},
                ${valid ? 'QUEUED' : 'NEEDS_ATTENTION'}::vale_pass_email_status, ${now}, ${`vpe-${id}`}, ${valid ? null : 'no_recipient'}, ${deadlineAt}, ${now})
        ON CONFLICT (dedupe_key) DO NOTHING
        RETURNING id::text AS id`;
      if (inserted.length === 0) {
        alreadyQueued++;
        continue;
      }
      enqueued++;
      await this.recordEvent(tx, id, valid ? 'ENQUEUED' : 'ENQUEUED_NO_RECIPIENT', { unit: verdict.unit, deadlineAt: deadlineAt.toISOString(), deadlineBasis });
    }
    return { enqueued, alreadyQueued, notEligible };
  }

  /** Rede de segurança: unidades completas e pagas sem mensagem na caixa de saída (ex.: emissão feita por resolução administrativa). */
  async enqueueMissing(now: Date = new Date(), limit = 50): Promise<EnqueueResult> {
    const rows = await this.prisma.$queryRaw<{ orderId: string }[]>`
      SELECT DISTINCT v.shopify_order_id AS "orderId" FROM vale_passes v
      WHERE v.group_id IS NOT NULL AND v.shopify_order_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM vale_pass_email_outbox o WHERE o.group_id = v.group_id AND o.kind = 'INITIAL')
      LIMIT ${limit}`;
    let total: EnqueueResult = { enqueued: 0, alreadyQueued: 0, notEligible: 0 };
    for (const { orderId } of rows) {
      const result = await this.prisma.$transaction(
        async (tx) => {
          await lockShopifyOrder(tx, orderId);
          return this.enqueueForOrder(tx, orderId, now);
        },
        { timeout: 20_000, maxWait: 5_000 },
      );
      total = { enqueued: total.enqueued + result.enqueued, alreadyQueued: total.alreadyQueued + result.alreadyQueued, notEligible: total.notEligible + result.notEligible };
    }
    return total;
  }

  async list(options: { status?: ValePassEmailStatus; limit?: number; now?: Date } = {}): Promise<EmailListItem[]> {
    const now = options.now ?? new Date();
    const rows = await this.prisma.valePassEmailOutbox.findMany({
      where: options.status ? { status: options.status } : {},
      orderBy: [{ createdAt: 'desc' }],
      take: Math.min(options.limit ?? 100, 200),
    });
    if (rows.length === 0) return [];
    const orders = await this.prisma.valePassOrder.findMany({
      where: { shopifyOrderId: { in: [...new Set(rows.map((row) => row.shopifyOrderId))] } },
      select: { shopifyOrderId: true, shopifyOrderName: true },
    });
    const orderNames = new Map(orders.map((order) => [order.shopifyOrderId, order.shopifyOrderName]));
    const vouchers = await this.prisma.valePass.findMany({ where: { groupId: { in: rows.map((row) => row.groupId) } }, select: { groupId: true, code: true, company: true }, orderBy: { company: 'asc' } });
    const codes = new Map<string, string[]>();
    for (const voucher of vouchers) codes.set(voucher.groupId as string, [...(codes.get(voucher.groupId as string) ?? []), maskCode(voucher.code)]);
    const satisfiedGroups = new Set(
      (await this.prisma.valePassEmailOutbox.findMany({ where: { groupId: { in: rows.map((row) => row.groupId) }, status: { in: [...SATISFIED_STATUSES] } }, select: { groupId: true } })).map((row) => row.groupId),
    );
    return rows.map((row) => this.toItem(row, orderNames.get(row.shopifyOrderId) ?? null, codes.get(row.groupId) ?? [], satisfiedGroups.has(row.groupId), now));
  }

  private toItem(row: ValePassEmailOutbox, orderName: string | null, codesMasked: string[], groupSatisfied: boolean, now: Date): EmailListItem {
    return {
      id: row.id,
      orderId: row.shopifyOrderId,
      orderName,
      kind: row.kind,
      status: row.status,
      toMasked: maskEmail(row.toEmail),
      codesMasked,
      attempts: row.attempts,
      maxAttempts: this.config.maxAttempts,
      nextAttemptAt: row.nextAttemptAt.toISOString(),
      lastError: row.lastError,
      deadlineAt: row.deadlineAt.toISOString(),
      overdue: row.kind === 'INITIAL' && !groupSatisfied && row.status !== 'CANCELLED' && row.deadlineAt.getTime() < now.getTime(),
      createdAt: row.createdAt.toISOString(),
      acceptedAt: row.acceptedAt?.toISOString() ?? null,
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
      failedAt: row.failedAt?.toISOString() ?? null,
      resendOfId: row.resendOfId,
    };
  }

  async events(id: string): Promise<{ type: string; detail: unknown; createdAt: string }[]> {
    const exists = await this.prisma.valePassEmailOutbox.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Mensagem não encontrada.');
    const rows = await this.prisma.valePassEmailEvent.findMany({ where: { outboxId: id }, orderBy: { createdAt: 'asc' }, take: 200 });
    return rows.map((row) => ({ type: row.type, detail: row.detail, createdAt: row.createdAt.toISOString() }));
  }

  /** Painel de acompanhamento e alertas do prazo de 3 dias. */
  async summary(now: Date = new Date()): Promise<EmailSummary> {
    const grouped = await this.prisma.valePassEmailOutbox.groupBy({ by: ['status'], _count: { _all: true } });
    const counts = Object.fromEntries(ALL_STATUSES.map((status) => [status, 0])) as Record<ValePassEmailStatus, number>;
    for (const row of grouped) counts[row.status] = row._count._all;

    const [pending] = await this.prisma.$queryRaw<{ overdue: number; atRisk: number }[]>`
      SELECT count(*) FILTER (WHERE o.deadline_at < ${now})::int AS overdue,
             count(*) FILTER (WHERE o.deadline_at >= ${now} AND o.deadline_at < ${new Date(now.getTime() + DAY_MS)})::int AS "atRisk"
      FROM vale_pass_email_outbox o
      WHERE o.kind = 'INITIAL' AND o.status IN ('QUEUED','SENDING','UNKNOWN','FAILED','NEEDS_ATTENTION')
        AND NOT EXISTS (SELECT 1 FROM vale_pass_email_outbox r WHERE r.group_id = o.group_id AND r.status IN ('ACCEPTED','DELIVERED'))`;
    const acceptedLast24h = await this.prisma.valePassEmailOutbox.count({ where: { acceptedAt: { gte: new Date(now.getTime() - DAY_MS) } } });

    const status = publicEmailStatus(this.config);
    const alerts: EmailSummary['alerts'][number][] = [];
    const overdue = pending?.overdue ?? 0;
    const atRisk = pending?.atRisk ?? 0;
    if (overdue > 0) alerts.push({ code: 'EMAIL_OVERDUE', severity: 'critical', message: `${overdue} unidade(s) passaram do prazo de ${DELIVERY_DEADLINE_DAYS} dias sem o e-mail dos vouchers aceito pela Resend. Resolva agora (reenvio autorizado ou contato direto com o cliente).` });
    if (atRisk > 0) alerts.push({ code: 'EMAIL_AT_RISK', severity: 'warning', message: `${atRisk} unidade(s) vencem o prazo de ${DELIVERY_DEADLINE_DAYS} dias nas próximas 24 horas e o e-mail ainda não foi aceito.` });
    if (counts.NEEDS_ATTENTION > 0) alerts.push({ code: 'EMAIL_NEEDS_ATTENTION', severity: 'critical', message: `${counts.NEEDS_ATTENTION} mensagem(ns) precisam de intervenção (tentativas esgotadas, resultado desconhecido, sem destinatário ou credencial recusada).` });
    if (counts.FAILED > 0) alerts.push({ code: 'EMAIL_FAILED', severity: 'warning', message: `${counts.FAILED} mensagem(ns) falharam definitivamente (endereço recusado ou devolvido). Corrija o e-mail e reenvie.` });
    if (counts.QUEUED + counts.UNKNOWN > 0 && !status.canSend) alerts.push({ code: 'EMAIL_QUEUE_BLOCKED', severity: counts.QUEUED + counts.UNKNOWN > 0 && overdue > 0 ? 'critical' : 'warning', message: `Há ${counts.QUEUED + counts.UNKNOWN} mensagem(ns) na fila, mas o envio real está bloqueado: ${status.blockers.join('; ')}.` });
    if ((status.recipientAllowlist.active || this.config.mode === 'live') && !recipientsUnrestricted(this.config)) {
      const list = this.config.allowedRecipients ?? [];
      const [heldRow] = await this.prisma.$queryRaw<{ held: number }[]>`SELECT count(*)::int AS held FROM vale_pass_email_outbox WHERE status IN ('QUEUED','UNKNOWN') AND NOT (lower(to_email) = ANY(${list}::text[]))`;
      const held = heldRow?.held ?? 0;
      alerts.push({
        code: !status.recipientAllowlist.active ? 'EMAIL_NO_RECIPIENT_ALLOWLIST' : status.recipientAllowlist.valid ? 'EMAIL_RECIPIENT_ALLOWLIST' : 'EMAIL_RECIPIENT_ALLOWLIST_INVALID',
        severity: status.recipientAllowlist.valid && status.recipientAllowlist.active ? 'info' : this.config.mode === 'live' ? 'critical' : 'warning',
        message: !status.recipientAllowlist.active
          ? `Sem lista de destinatários autorizados e sem liberação comercial: NENHUM envio real será feito (${held} mensagem(ns) na fila ficam retidas).`
          : status.recipientAllowlist.valid
            ? `Envio real restrito a ${status.recipientAllowlist.size} endereço(s) autorizado(s); ${held} mensagem(ns) na fila ficam retidas por não estarem na lista.`
            : 'A lista de destinatários autorizados é inválida: NENHUM envio real será feito até corrigi-la.',
      });
    }
    if (acceptedLast24h >= Math.ceil(this.config.dailyLimit * 0.8)) alerts.push({ code: 'EMAIL_DAILY_LIMIT_NEAR', severity: acceptedLast24h >= this.config.dailyLimit ? 'critical' : 'warning', message: `${acceptedLast24h} de ${this.config.dailyLimit} envios do limite diário usados nas últimas 24 horas; o excedente espera o dia seguinte.` });
    return { config: status, counts, overdue, atRisk, acceptedLast24h, dailyLimit: this.config.dailyLimit, alerts };
  }

  /**
   * Prévia somente leitura do e-mail desta mensagem: o MESMO modelo do envio, com os caracteres secretos dos códigos MASCARADOS por inteiro (só o prefixo público fica) e só o primeiro nome do cliente. Não envia, não grava e não chama o provedor.
   * Só existe enquanto o pedido está pago e a unidade completa e ativa (a mesma regra do envio).
   */
  async preview(id: string): Promise<{ subject: string; html: string; text: string; toMasked: string; codesMasked: string[]; status: ValePassEmailStatus; recipientAllowed: boolean }> {
    const row = await this.prisma.valePassEmailOutbox.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Mensagem não encontrada.');
    const verdict = await evaluateGroup(this.prisma, row.shopifyOrderId, row.groupId);
    if (!verdict.ok) throw new ConflictException(`Sem prévia: o pedido não está pago ou a unidade não está completa e ativa (${verdict.reason}).`);
    const masked = verdict.vouchers.map((voucher) => maskCodeFully(voucher.code));
    const rendered = renderVoucherEmail({
      customerName: verdict.order.customerName?.trim().split(/\s+/)[0] ?? null, // a prévia nunca leva o nome completo
      orderName: verdict.order.orderName,
      unit: verdict.unit,
      replyTo: this.config.replyTo,
      testCampaign: verdict.testCampaign,
      vouchers: verdict.vouchers.map((voucher, index) => ({
        company: voucher.company as 'VALLE_SHOWROOM' | 'VS_BY_CLOSET',
        amountCents: voucher.amountCents,
        code: masked[index],
        validFrom: voucher.validFrom,
        expiresAt: voucher.expiresAt,
      })),
    });
    return { ...rendered, toMasked: maskEmail(row.toEmail), codesMasked: masked, status: row.status, recipientAllowed: recipientAllowed(this.config, row.toEmail) };
  }

  /**
   * Reenvio autorizado (somente ADMIN), com justificativa e auditoria. Cria uma NOVA mensagem ligada à original — nunca reaproveita a
   * chave de idempotência — e só se o pedido continuar pago e a unidade completa e ativa. Se a original estiver em andamento, recusa.
   * Se o resultado da original é desconhecido, avisa que o cliente pode receber duas mensagens.
   */
  async requestResend(
    originalId: string,
    input: { note: string; toEmail?: string | null },
    actor: { id: string; name: string },
    now: Date = new Date(),
  ): Promise<{ id: string; status: ValePassEmailStatus; mayDuplicate: boolean }> {
    const note = (input.note ?? '').trim();
    if (note.length < MIN_RESEND_NOTE) throw new UnprocessableEntityException(`Informe a justificativa (mínimo de ${MIN_RESEND_NOTE} caracteres).`);
    const override = input.toEmail?.trim() || null;
    if (override && !isValidRecipient(override)) throw new UnprocessableEntityException('O e-mail informado não parece válido.');
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const located = await tx.valePassEmailOutbox.findUnique({ where: { id: originalId } });
          if (!located) throw new NotFoundException('Mensagem não encontrada.');
          await lockShopifyOrder(tx, located.shopifyOrderId);
          const admin = await tx.adminUser.findUnique({ where: { id: actor.id }, select: { role: true, active: true } });
          // SUPER_ADMIN (o proprietário) satisfaz qualquer checagem de ADMIN por hierarquia (ver satisfiesRole em admin-role.guard.ts); STAFF e inativos seguem barrados.
          if (!admin || !admin.active || (admin.role !== 'ADMIN' && admin.role !== 'SUPER_ADMIN')) throw new ForbiddenException('Somente um administrador pode reenviar.');
          const original = await tx.valePassEmailOutbox.findUniqueOrThrow({ where: { id: originalId } });
          if (IN_FLIGHT_STATUSES.includes(original.status)) throw new ConflictException('Esta mensagem ainda está na fila ou sendo enviada. Aguarde a conclusão antes de reenviar.');
          if (original.status === 'CANCELLED') throw new ConflictException('Esta mensagem foi cancelada porque o pedido deixou de estar pago. Não há o que reenviar.');

          const verdict = await evaluateGroup(tx, original.shopifyOrderId, original.groupId);
          if (!verdict.ok) throw new ConflictException('O pedido não está pago ou a unidade não está completa e ativa: os códigos não podem ser reenviados.');
          const target = override ?? (isValidRecipient(original.toEmail) ? original.toEmail : verdict.order.customerEmail?.trim() ?? '');
          if (!isValidRecipient(target)) throw new UnprocessableEntityException('Não há e-mail válido do cliente. Informe o endereço correto.');
          // Com lista configurada (qualquer modo) ou em live sem liberação comercial, só se reenvia a endereço autorizado. Em off/dry-run sem lista nada pode sair mesmo, então o pedido segue como antes.
          if ((this.config.allowedRecipients !== null || this.config.mode === 'live') && !recipientAllowed(this.config, target)) throw new UnprocessableEntityException('Este endereço não está na lista de destinatários autorizados (VALE_PASS_EMAIL_ALLOWED_RECIPIENTS) e não há liberação comercial. Nada foi enviado nem criado.');

          const previous = await tx.valePassEmailOutbox.count({ where: { groupId: original.groupId, kind: 'RESEND' } });
          if (previous >= MAX_MANUAL_RESENDS) throw new ConflictException(`Limite de ${MAX_MANUAL_RESENDS} reenvios por unidade atingido.`);
          const sequence = previous + 1;
          const id = randomUUID();
          await tx.valePassEmailOutbox.create({
            data: {
              id,
              shopifyOrderId: original.shopifyOrderId,
              campaignId: original.campaignId,
              groupId: original.groupId,
              kind: 'RESEND',
              dedupeKey: `resend:${original.groupId}:${sequence}`,
              toEmail: target,
              recipientName: verdict.order.customerName,
              status: 'QUEUED',
              nextAttemptAt: now,
              idempotencyKey: `vpe-${id}`,
              deadlineAt: original.deadlineAt,
              resendOfId: original.id,
              requestedBy: actor.id,
              note,
            },
          });
          const mayDuplicate = original.providerMessageId === null && original.attempts > 0 && original.status !== 'FAILED';
          await this.recordEvent(tx, id, 'ENQUEUED_RESEND', { resendOf: original.id, sequence, by: actor.id, recipientChanged: target !== original.toEmail });
          await this.recordEvent(tx, original.id, 'RESEND_REQUESTED', { newMessage: id, by: actor.id });
          await writeAdminAuditEvent(tx, {
            adminUserId: actor.id,
            adminUserName: actor.name,
            action: 'VALE_PASS_EMAIL_RESENT',
            entityType: 'ValePassEmailOutbox',
            entityId: id,
            before: { originalId: original.id, originalStatus: original.status, to: maskEmail(original.toEmail) },
            after: { to: maskEmail(target), status: 'QUEUED', sequence },
            detail: { orderId: original.shopifyOrderId, note, recipientChanged: target !== original.toEmail, mayDuplicate },
          });
          return { id, status: 'QUEUED' as const, mayDuplicate };
        },
        { timeout: 20_000, maxWait: 5_000 },
      );
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.error(`Falha ao registrar o reenvio: ${err instanceof Error ? err.name : 'unknown'}`);
      throw new ServiceUnavailableException('Não foi possível registrar o reenvio no momento.');
    }
  }

  /** Eventos da Resend (webhook): entregue / devolvido. Monotônico e idempotente: repetição não regride estado nem duplica linha do tempo. */
  async applyProviderEvent(type: string, providerMessageId: string, now: Date = new Date()): Promise<'applied' | 'ignored' | 'unknown_message'> {
    const row = await this.prisma.valePassEmailOutbox.findUnique({ where: { providerMessageId } });
    if (!row) return 'unknown_message';
    const delivered = type === 'email.delivered';
    const failed = type === 'email.bounced' || type === 'email.failed' || type === 'email.complained' || type === 'email.suppressed';
    if (!delivered && !failed) {
      if (type === 'email.delivery_delayed' && row.status === 'ACCEPTED') {
        await this.recordEvent(this.prisma, row.id, 'PROVIDER_DELAYED');
        return 'applied';
      }
      return 'ignored';
    }
    if (delivered) {
      const changed = await this.prisma.valePassEmailOutbox.updateMany({ where: { id: row.id, status: 'ACCEPTED' }, data: { status: 'DELIVERED', deliveredAt: now, lastError: null } });
      if (changed.count === 1) await this.recordEvent(this.prisma, row.id, 'DELIVERED');
      return changed.count === 1 ? 'applied' : 'ignored';
    }
    const reason = type.replace('email.', '');
    const changed = await this.prisma.valePassEmailOutbox.updateMany({ where: { id: row.id, status: { in: ['ACCEPTED', 'DELIVERED'] } }, data: { status: 'FAILED', failedAt: now, lastError: reason } });
    if (changed.count === 1) await this.recordEvent(this.prisma, row.id, 'PROVIDER_FAILED', { reason });
    return changed.count === 1 ? 'applied' : 'ignored';
  }

  senderConfigured(): boolean {
    return senderAddress(this.config.from) !== null;
  }
}
