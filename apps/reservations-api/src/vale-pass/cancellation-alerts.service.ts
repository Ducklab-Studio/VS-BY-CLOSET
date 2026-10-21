import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AdminRole, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { writeAdminAuditEvent } from '../admin/admin-audit';
import { summarizeUsedCredit, type CancellationAlertDetail } from './cancellation-alerts';

type Tx = Prisma.TransactionClient;

export interface CancellationAlertView {
  readonly id: string;
  readonly shopifyOrderId: string;
  /** Referência interna do pedido (ex.: "#1001"). */
  readonly orderName: string | null;
  readonly topic: string;
  readonly usedCents: number;
  readonly detail: CancellationAlertDetail;
  readonly status: 'OPEN' | 'ACKNOWLEDGED';
  readonly createdAt: string;
  readonly acknowledgedAt: string | null;
  readonly acknowledgedByName: string | null;
  readonly acknowledgeNote: string | null;
}

/**
 * Registra (dentro da transação do webhook, sob o lock do pedido) o alerta de pedido cancelado/reembolsado com crédito JÁ utilizado. Idempotente: uma linha por pedido
 * (`skipDuplicates`), então webhook repetido ou simultâneo não duplica nem reabre. Nunca altera voucher, saldo ou reembolso. Devolve `true` só na PRIMEIRA criação.
 */
export async function recordCancellationAlert(tx: Tx, orderId: string, topic: string): Promise<{ created: boolean; usedCents: number }> {
  const vouchers = await tx.valePass.findMany({ where: { shopifyOrderId: orderId }, select: { campaignId: true, company: true, status: true, amountCents: true, balanceCents: true } });
  const summary = summarizeUsedCredit(vouchers);
  if (!summary) return { created: false, usedCents: 0 };
  const order = await tx.valePassOrder.findUnique({ where: { shopifyOrderId: orderId }, select: { shopifyOrderName: true } });
  const created = await tx.valePassCancellationAlert.createMany({
    data: [{ shopifyOrderId: orderId, shopifyOrderName: order?.shopifyOrderName ?? null, campaignId: vouchers[0]?.campaignId ?? null, topic, usedCents: summary.usedCents, detail: summary.detail as unknown as Prisma.InputJsonValue }],
    skipDuplicates: true,
  });
  if (created.count === 1) {
    await writeAdminAuditEvent(tx, {
      adminUserId: null,
      adminUserName: 'Sistema (webhook da Shopify)',
      action: 'VALE_PASS_CANCELLATION_CREDIT_USED',
      entityType: 'ValePassOrder',
      entityId: orderId,
      detail: { orderName: order?.shopifyOrderName ?? null, topic, usedCents: summary.usedCents, vouchersWithUse: summary.detail.vouchersWithUse },
    });
  }
  return { created: created.count === 1, usedCents: summary.usedCents };
}

export const toAlertView = (row: {
  id: string; shopifyOrderId: string; shopifyOrderName: string | null; topic: string; usedCents: number; detail: unknown; status: 'OPEN' | 'ACKNOWLEDGED'; createdAt: Date;
  acknowledgedAt: Date | null; acknowledgedByName: string | null; acknowledgeNote: string | null;
}): CancellationAlertView => ({
  id: row.id, shopifyOrderId: row.shopifyOrderId, orderName: row.shopifyOrderName, topic: row.topic, usedCents: row.usedCents, detail: row.detail as CancellationAlertDetail, status: row.status,
  createdAt: row.createdAt.toISOString(), acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null, acknowledgedByName: row.acknowledgedByName, acknowledgeNote: row.acknowledgeNote,
});

/** Conferência do alerta por um ADMIN: só registra que alguém viu (justificativa + auditoria crítica). Não altera saldo, voucher, reembolso nem cancelamento. */
@Injectable()
export class ValePassCancellationAlertsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(status: 'OPEN' | 'ACKNOWLEDGED' | 'ALL' = 'OPEN', campaignId?: string): Promise<CancellationAlertView[]> {
    const rows = await this.prisma.valePassCancellationAlert.findMany({
      where: { ...(status === 'ALL' ? {} : { status }), ...(campaignId ? { campaignId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map(toAlertView);
  }

  async acknowledge(id: string, note: string, actor: { id: string; name: string; role: AdminRole }): Promise<CancellationAlertView> {
    if (actor.role !== 'ADMIN' && actor.role !== 'SUPER_ADMIN') throw new ForbiddenException('Somente um administrador confere este alerta.');
    const reason = (note ?? '').trim();
    if (reason.length < 10 || reason.length > 500) throw new BadRequestException('Informe a justificativa da conferência (10 a 500 caracteres).');
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException('Alerta não encontrado.');
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.valePassCancellationAlert.updateMany({
        where: { id, status: 'OPEN' },
        data: { status: 'ACKNOWLEDGED', acknowledgedAt: new Date(), acknowledgedBy: actor.id, acknowledgedByName: actor.name, acknowledgeNote: reason },
      });
      const row = await tx.valePassCancellationAlert.findUnique({ where: { id } });
      if (!row) throw new NotFoundException('Alerta não encontrado.');
      if (changed.count !== 1) throw new ConflictException({ statusCode: 409, error: 'Conflict', code: 'ALREADY_ACKNOWLEDGED', message: 'Este alerta já foi conferido.' });
      await writeAdminAuditEvent(tx, {
        adminUserId: actor.id,
        adminUserName: actor.name,
        action: 'VALE_PASS_CANCELLATION_ALERT_ACKNOWLEDGED',
        entityType: 'ValePassOrder',
        entityId: row.shopifyOrderId,
        detail: { alertId: id, orderName: row.shopifyOrderName, usedCents: row.usedCents, note: reason },
      });
      return toAlertView(row);
    });
  }
}
