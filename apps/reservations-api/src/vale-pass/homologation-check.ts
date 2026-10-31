import { createHash } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

/**
 * Verificador SOMENTE LEITURA da homologação do `AUTO_VERIFY` (docs/VALLE-PASS-HOMOLOGACAO-RUNBOOK.md). Recebe o NOME do pedido de teste (ex.: "#1015") e confere, no
 * banco, os critérios objetivos de aprovação. Só faz `find*`/`count`: nada é gravado. A saída não contém dados pessoais nem códigos de voucher (ids de grupo/linha são
 * UUIDs internos; códigos nunca são lidos).
 */
export interface HomologationCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly detail: string;
}
export interface HomologationReport {
  readonly orderName: string;
  readonly found: boolean;
  readonly pass: boolean;
  readonly checks: readonly HomologationCheck[];
  /** Hash de contagens e ids internos: duas leituras separadas por ciclos do agendador (e por reentregas) precisam dar o MESMO valor (nada duplicou). */
  readonly fingerprint: string | null;
}

/** Tolerância máxima entre o horário confirmado e o sinal do webhook (a mesma da política: 120 s). */
export const HOMOLOGATION_TOLERANCE_SECONDS = 120;

type Db = Pick<PrismaClient, 'valePassOrder' | 'valePass' | 'valePassCampaignBenefit' | 'valePassEmailOutbox' | 'valePassIssuanceHold' | 'adminAuditEvent'>;

const COMPANIES = ['VALLE_SHOWROOM', 'VS_BY_CLOSET'] as const;

export async function checkHomologation(db: Db, input: { orderName: string }): Promise<HomologationReport> {
  const orderName = input.orderName.trim();
  const checks: HomologationCheck[] = [];
  const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });

  const orders = await db.valePassOrder.findMany({
    where: { shopifyOrderName: { in: [orderName, orderName.replace(/^#/, ''), `#${orderName.replace(/^#/, '')}`] } },
    select: { id: true, shopifyOrderId: true, status: true, quantity: true, paymentConfirmedAt: true, paymentConfirmedSource: true, paymentSignalAt: true, paymentTimeEvidence: true, deletedInShopifyAt: true },
  });
  if (orders.length !== 1) {
    add('0-pedido', false, orders.length === 0 ? 'pedido não encontrado no registro do Valle Pass' : `${orders.length} pedidos com o mesmo nome (ambíguo)`);
    return { orderName, found: false, pass: false, checks, fingerprint: null };
  }
  const order = orders[0];

  // 1) horário confirmado pelo AUTO_VERIFY, pelo evento de confirmação, dentro da tolerância do webhook
  const evidence = (order.paymentTimeEvidence ?? {}) as { transaction?: { instant?: string }; webhook?: { triggeredAt?: string; payloadUpdatedAt?: string } };
  const signals = [evidence.webhook?.triggeredAt, evidence.webhook?.payloadUpdatedAt, order.paymentSignalAt?.toISOString()].filter((v): v is string => Boolean(v)).map((v) => new Date(v).getTime());
  const confirmedMs = order.paymentConfirmedAt?.getTime() ?? null;
  const delta = confirmedMs !== null && signals.length > 0 ? Math.min(...signals.map((s) => Math.abs(s - confirmedMs))) / 1000 : null;
  add('1a-status', order.status === 'CONFIRMED' && !order.deletedInShopifyAt, `status=${order.status}`);
  add('1b-fonte', order.paymentConfirmedSource === 'ADMIN_API_TRANSACTION_AUTO', `fonte=${order.paymentConfirmedSource ?? 'nenhuma'}`);
  add('1c-horario', delta !== null && delta <= HOMOLOGATION_TOLERANCE_SECONDS, delta === null ? 'sem horário confirmado ou sem sinal do webhook' : `confirmação a ${Math.round(delta)} s do webhook (limite ${HOMOLOGATION_TOLERANCE_SECONDS} s)`);

  // 2) exatamente 2 vouchers por unidade, 1 por empresa, valor/saldo corretos
  const vouchers = await db.valePass.findMany({ where: { shopifyOrderId: order.shopifyOrderId }, select: { id: true, groupId: true, company: true, amountCents: true, balanceCents: true, status: true, benefitId: true, campaignId: true } });
  const benefitIds = [...new Set(vouchers.map((v) => v.benefitId).filter((id): id is string => Boolean(id)))];
  const benefits = await db.valePassCampaignBenefit.findMany({ where: { id: { in: benefitIds } }, select: { id: true, amountCents: true } });
  const benefitAmount = new Map(benefits.map((b) => [b.id, b.amountCents]));
  const groups = new Map<string, typeof vouchers>();
  for (const voucher of vouchers) groups.set(voucher.groupId ?? 'sem-grupo', [...(groups.get(voucher.groupId ?? 'sem-grupo') ?? []), voucher]);
  const perGroupOk = [...groups.entries()].every(([groupId, rows]) => groupId !== 'sem-grupo' && rows.length === 2 && COMPANIES.every((company) => rows.filter((r) => r.company === company).length === 1));
  add('2a-quantidade', vouchers.length === order.quantity * 2 && groups.size === order.quantity, `${vouchers.length} voucher(s) em ${groups.size} grupo(s) para ${order.quantity} unidade(s)`);
  add('2b-um-por-empresa', perGroupOk, 'cada grupo tem exatamente um voucher da Valle Showroom e um da VS BY CLOSET');
  add('2c-valores', vouchers.length > 0 && vouchers.every((v) => v.benefitId !== null && benefitAmount.get(v.benefitId) === v.amountCents && v.balanceCents === v.amountCents && v.status === 'ACTIVE'), 'valor = benefício da campanha, saldo cheio, ATIVO');

  // 3) caixa de saída: uma mensagem por unidade, ainda sem envio
  const outbox = await db.valePassEmailOutbox.findMany({ where: { shopifyOrderId: order.shopifyOrderId }, select: { id: true, groupId: true, kind: true, status: true, attempts: true, nextAttemptAt: true } });
  const groupIds = new Set(outbox.map((m) => m.groupId));
  add('3a-uma-por-unidade', outbox.length === order.quantity && groupIds.size === order.quantity && outbox.every((m) => m.kind === 'INITIAL'), `${outbox.length} mensagem(ns) INITIAL para ${order.quantity} unidade(s)`);
  add('3b-nada-enviado', outbox.every((m) => m.status === 'QUEUED' && m.attempts === 0), `estados: ${[...new Set(outbox.map((m) => m.status))].join(',') || 'nenhum'} (esperado QUEUED, 0 tentativas: e-mail em dry-run)`);
  add('3c-assentamento', confirmedMs !== null && outbox.every((m) => m.nextAttemptAt.getTime() >= confirmedMs), 'a mensagem não é elegível antes da confirmação do pagamento');

  // 4) sem retenção aberta; auditoria do sistema única
  const holds = await db.valePassIssuanceHold.findMany({ where: { shopifyOrderId: order.shopifyOrderId }, select: { id: true, status: true } });
  add('4a-sem-retencao-aberta', holds.every((h) => h.status !== 'OPEN'), `${holds.length} retenção(ões), ${holds.filter((h) => h.status === 'OPEN').length} aberta(s)`);
  const audits = await db.adminAuditEvent.count({ where: { action: 'VALE_PASS_PAYMENT_TIME_AUTO_CONFIRMED', entityId: order.id } });
  add('4b-auditoria-unica', audits === 1, `${audits} auditoria(s) de confirmação automática (esperado 1)`);

  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ o: order.id, c: confirmedMs, v: vouchers.map((v) => v.id).sort(), m: outbox.map((m) => `${m.id}:${m.status}:${m.attempts}`).sort(), h: holds.map((h) => `${h.id}:${h.status}`).sort(), a: audits }))
    .digest('hex')
    .slice(0, 24);
  return { orderName, found: true, pass: checks.every((c) => c.ok), checks, fingerprint };
}
