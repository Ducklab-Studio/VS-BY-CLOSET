import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BadRequestException, ConflictException, HttpException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashPin } from '../admin/admin-pin';
import { ValePassVouchersService } from './vale-pass-vouchers.service';
import { ValePassVouchersController } from './vale-pass-vouchers.controller';
import { REQUIRE_ROLE_KEY } from '../admin/require-role.decorator';
import { REQUIRE_MODULE_KEY } from '../admin/require-module.decorator';

/**
 * Restaurar Valle Pass cancelado — item novo do pedido: a tela mostrava
 * "Nenhuma ação disponível" pra todo CANCELLED; agora um subconjunto pode
 * voltar a ACTIVE. Nenhum status novo (ACTIVE já existe). Integração
 * real, mesmo padrão do resto da suíte de Valle Pass.
 */
const prisma = new PrismaService();
const vouchers = new ValePassVouchersService(prisma);
const PREFIX = `VP-RESTORE-${Date.now()}`;
let counter = 0;

async function createOwner() {
  const pinHash = await hashPin('1234');
  return prisma.adminUser.create({ data: { name: 'Owner Teste', phone: `${PREFIX}-${counter++}`, pinHash, role: 'SUPER_ADMIN', active: true } });
}

async function createCampaign(name = 'Campanha Restauração') {
  return prisma.valePassCampaign.create({
    data: { name, amountCents: 15000, validityDays: 90, shopifyVariantId: `${PREFIX}-variant-${counter++}` },
  });
}

interface VoucherOpts {
  status?: 'ACTIVE' | 'USED' | 'EXPIRED' | 'CANCELLED';
  expiresAt?: Date;
  usedAt?: Date;
  cancelledAt?: Date;
  cancelledBy?: string | null;
  cancelReason?: string | null;
  shopifyOrderId?: string;
}

async function createVoucher(campaignId: string, opts: VoucherOpts = {}) {
  const orderId = opts.shopifyOrderId ?? `${PREFIX}-order-${counter}`;
  return prisma.valePass.create({
    data: {
      code: `VALLE-${PREFIX.slice(-4)}-${(counter++).toString().padStart(4, '0')}`,
      campaignId,
      amountCents: 15000,
      status: opts.status ?? 'ACTIVE',
      purchasedAt: new Date(),
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 90 * 86_400_000),
      customerName: 'Cliente Teste',
      customerPhone: '+56911112222',
      customerEmail: 'cliente@teste.com',
      shopifyOrderId: orderId,
      shopifyOrderName: `#${counter}`,
      usedAt: opts.usedAt,
      cancelledAt: opts.cancelledAt,
      cancelledBy: opts.cancelledBy,
      cancelReason: opts.cancelReason,
    },
  });
}

/** Cancelado por um ADMIN — o único tipo elegível pra restauração. */
async function createAdminCancelledVoucher(campaignId: string, ownerId: string, opts: Omit<VoucherOpts, 'status' | 'cancelledAt' | 'cancelledBy' | 'cancelReason'> = {}) {
  return createVoucher(campaignId, { ...opts, status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: ownerId, cancelReason: 'motivo original do cancelamento' });
}

/** Cancelado pelo WEBHOOK (`orders/cancelled`/`refunds/create`) — nunca
 *  restaurável: `cancelledBy` fica nulo, mesmo shape gravado por
 *  ValePassWebhookService.handleOrderCancelledOrRefunded. */
async function createWebhookCancelledVoucher(campaignId: string, opts: Omit<VoucherOpts, 'status' | 'cancelledAt' | 'cancelledBy' | 'cancelReason'> = {}) {
  return createVoucher(campaignId, { ...opts, status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: null, cancelReason: 'refunds/create' });
}

async function cleanup() {
  const campaigns = await prisma.valePassCampaign.findMany({ where: { shopifyVariantId: { startsWith: PREFIX } } });
  const campaignIds = campaigns.map((c) => c.id);
  if (campaignIds.length) {
    await prisma.$executeRaw`DELETE FROM vale_pass_events WHERE vale_pass_id IN (SELECT id FROM vale_passes WHERE campaign_id = ANY(${campaignIds}::uuid[]))`;
    await prisma.$executeRaw`DELETE FROM vale_passes WHERE campaign_id = ANY(${campaignIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM vale_pass_campaigns WHERE id = ANY(${campaignIds}::uuid[])`;
  }
  const owners = await prisma.adminUser.findMany({ where: { phone: { startsWith: PREFIX } } });
  const ownerIds = owners.map((o) => o.id);
  if (ownerIds.length) {
    await prisma.$executeRaw`DELETE FROM admin_audit_events WHERE admin_user_id = ANY(${ownerIds}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM admin_users WHERE id = ANY(${ownerIds}::uuid[])`;
  }
}

beforeAll(cleanup);
afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe('ValePassVouchersService.restore — restaurar Valle Pass cancelado (integração real, Neon)', () => {
  test('1) cancelado por ADMIN, nunca utilizado, não expirado → restaura pra ACTIVE', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const voucher = await createAdminCancelledVoucher(campaign.id, owner.id);

    const restored = await vouchers.restore(voucher.code, 'engano do cliente, ele quer manter o vale', owner.id, owner.name);

    expect(restored.status).toBe('ACTIVE');
    expect(restored.cancelledAt).toBeNull();
    expect(restored.cancelReason).toBeNull();

    const reloaded = await prisma.valePass.findUniqueOrThrow({ where: { id: voucher.id } });
    expect(reloaded.cancelledBy).toBeNull(); // linha atual limpa — nunca um vale ACTIVE com resíduo de cancelamento
  });

  test('2) cancelado que já foi utilizado antes (defesa em profundidade) não pode ser restaurado', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    // CANCELLED hoje só nasce de ACTIVE, nunca de USED — este cenário é
    // sintético de propósito, pra provar que o serviço nunca confia só em
    // "status é CANCELLED": ele confere usedAt mesmo que a invariante hoje
    // torne isso redundante.
    const voucher = await createAdminCancelledVoucher(campaign.id, owner.id, { usedAt: new Date() });
    await expect(vouchers.restore(voucher.code, 'motivo qualquer', owner.id, owner.name)).rejects.toThrow(ConflictException);
    expect((await prisma.valePass.findUniqueOrThrow({ where: { id: voucher.id } })).status).toBe('CANCELLED');
  });

  test('3) cancelado com validade já vencida não pode ser restaurado — nunca reabre e deixa expirar sozinho', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const voucher = await createAdminCancelledVoucher(campaign.id, owner.id, { expiresAt: new Date(Date.now() - 1000) });
    await expect(vouchers.restore(voucher.code, 'motivo qualquer', owner.id, owner.name)).rejects.toThrow(BadRequestException);
    const reloaded = await prisma.valePass.findUniqueOrThrow({ where: { id: voucher.id } });
    expect(reloaded.status).toBe('CANCELLED'); // nunca vira ACTIVE nem EXPIRED por essa chamada
  });

  test('cancelado pelo WEBHOOK (Shopify) nunca pode ser restaurado por aqui — fonte de verdade é a Shopify', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const voucher = await createWebhookCancelledVoucher(campaign.id);
    await expect(vouchers.restore(voucher.code, 'motivo qualquer', owner.id, owner.name)).rejects.toThrow(ConflictException);
    expect((await prisma.valePass.findUniqueOrThrow({ where: { id: voucher.id } })).status).toBe('CANCELLED');
  });

  test('cancelado por ADMIN, mas outro vale do MESMO pedido foi cancelado pelo webhook (pedido reembolsado) → bloqueado', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const orderId = `${PREFIX}-shared-order-${counter++}`;
    const adminCancelled = await createAdminCancelledVoucher(campaign.id, owner.id, { shopifyOrderId: orderId });
    await createWebhookCancelledVoucher(campaign.id, { shopifyOrderId: orderId }); // irmão do mesmo pedido, cancelado pela Shopify

    await expect(vouchers.restore(adminCancelled.code, 'motivo qualquer', owner.id, owner.name)).rejects.toThrow(ConflictException);
    expect((await prisma.valePass.findUniqueOrThrow({ where: { id: adminCancelled.id } })).status).toBe('CANCELLED');
  });

  test('vale ACTIVE (não cancelado) não pode ser "restaurado" → BadRequestException, nada muda', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const voucher = await createVoucher(campaign.id, { status: 'ACTIVE' });
    await expect(vouchers.restore(voucher.code, 'motivo qualquer', owner.id, owner.name)).rejects.toThrow(BadRequestException);
  });

  test('4) restaurações concorrentes do mesmo vale: exatamente uma vence, um único evento e uma única auditoria', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const voucher = await createAdminCancelledVoucher(campaign.id, owner.id);

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => vouchers.restore(voucher.code, 'restauração concorrente de teste', owner.id, owner.name)),
    );

    const wins = results.filter((r) => r.status === 'fulfilled');
    expect(wins).toHaveLength(1);
    const losers = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(losers).toHaveLength(4);
    for (const loser of losers) expect(loser.reason).toBeInstanceOf(HttpException);

    expect((await prisma.valePass.findUniqueOrThrow({ where: { id: voucher.id } })).status).toBe('ACTIVE');
    expect(await prisma.valePassEvent.count({ where: { valePassId: voucher.id, type: 'RESTORED' } })).toBe(1);
    expect(await prisma.adminAuditEvent.count({ where: { action: 'VALE_PASS_RESTORED', entityId: voucher.id } })).toBe(1);
  }, 20_000);

  test('5) "duplo clique" — duas chamadas idênticas em paralelo geram uma única alteração', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const voucher = await createAdminCancelledVoucher(campaign.id, owner.id);

    const [first, second] = await Promise.allSettled([
      vouchers.restore(voucher.code, 'clique duplo de teste', owner.id, owner.name),
      vouchers.restore(voucher.code, 'clique duplo de teste', owner.id, owner.name),
    ]);
    const outcomes = [first.status, second.status];
    expect(outcomes.filter((s) => s === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((s) => s === 'rejected')).toHaveLength(1);
    expect(await prisma.valePassEvent.count({ where: { valePassId: voucher.id, type: 'RESTORED' } })).toBe(1);
  });

  test('6) histórico de cancelamento nunca é apagado — evento CANCELLED original continua, e RESTORED guarda o motivo/autor anteriores', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const voucher = await createVoucher(campaign.id, { status: 'ACTIVE' });

    await vouchers.cancel(voucher.code, 'motivo original do cancelamento', owner.id, owner.name);
    await vouchers.restore(voucher.code, 'motivo da restauração', owner.id, owner.name);

    const cancelledEvent = await prisma.valePassEvent.findFirst({ where: { valePassId: voucher.id, type: 'CANCELLED' } });
    expect(cancelledEvent).not.toBeNull(); // nunca apagado, mesmo depois de restaurado

    const restoredEvent = await prisma.valePassEvent.findFirstOrThrow({ where: { valePassId: voucher.id, type: 'RESTORED' } });
    expect(restoredEvent.detail).toMatchObject({
      reason: 'motivo da restauração',
      previousCancelledBy: owner.id,
      previousCancelReason: 'motivo original do cancelamento',
    });

    const cancelAudit = await prisma.adminAuditEvent.findFirst({ where: { action: 'VALE_PASS_CANCELLED_BY_ADMIN', entityId: voucher.id } });
    expect(cancelAudit).not.toBeNull(); // auditoria do cancelamento também permanece
    const restoreAudit = await prisma.adminAuditEvent.findFirstOrThrow({ where: { action: 'VALE_PASS_RESTORED', entityId: voucher.id } });
    expect(restoreAudit.isCritical).toBe(true); // mesma sensibilidade de cancelar
    expect(restoreAudit.before).toMatchObject({ status: 'CANCELLED', cancelledBy: owner.id });
  });

  test('7) permissões: POST .../restore exige módulo VALLE_PASS + role ADMIN, mesmo padrão de .../cancel', () => {
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, ValePassVouchersController)).toBe('VALLE_PASS');
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, ValePassVouchersController.prototype.restore)).toBe('ADMIN');
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, ValePassVouchersController.prototype.cancel)).toBe('ADMIN');
    // list/findByCode/markUsed não exigem ADMIN — só o módulo (operação do dia a dia)
    expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, ValePassVouchersController.prototype.markUsed)).toBeUndefined();
  });

  test('8) a listagem reflete a restauração: some de "cancelados restauráveis" e aparece em ACTIVE', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const voucher = await createAdminCancelledVoucher(campaign.id, owner.id);

    const before = await vouchers.list({ campaignId: campaign.id, status: 'CANCELLED' });
    expect(before.find((v) => v.id === voucher.id)).toMatchObject({ canBeRestored: true, restoreBlockedReason: null });

    await vouchers.restore(voucher.code, 'motivo da restauração', owner.id, owner.name);

    const afterCancelled = await vouchers.list({ campaignId: campaign.id, status: 'CANCELLED' });
    expect(afterCancelled.find((v) => v.id === voucher.id)).toBeUndefined();
    const afterActive = await vouchers.list({ campaignId: campaign.id, status: 'ACTIVE' });
    expect(afterActive.find((v) => v.id === voucher.id)).toMatchObject({ status: 'ACTIVE', canBeRestored: false });
  });

  test('9) filtros/estados: list() reporta o motivo certo pra cada tipo de cancelamento, e vazio quando não há nenhum', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const restorable = await createAdminCancelledVoucher(campaign.id, owner.id);
    const used = await createAdminCancelledVoucher(campaign.id, owner.id, { usedAt: new Date() });
    const expired = await createAdminCancelledVoucher(campaign.id, owner.id, { expiresAt: new Date(Date.now() - 1000) });
    const fromWebhook = await createWebhookCancelledVoucher(campaign.id);

    const cancelled = await vouchers.list({ campaignId: campaign.id, status: 'CANCELLED' });
    const byId = (id: string) => cancelled.find((v) => v.id === id);

    expect(byId(restorable.id)).toMatchObject({ canBeRestored: true, restoreBlockedReason: null });
    expect(byId(used.id)?.canBeRestored).toBe(false);
    expect(byId(expired.id)).toMatchObject({ canBeRestored: false, restoreBlockedReason: 'A validade já expirou.' });
    expect(byId(fromWebhook.id)).toMatchObject({ canBeRestored: false, restoreBlockedReason: 'Cancelado automaticamente por um cancelamento/reembolso do pedido na Shopify.' });

    const emptyCampaign = await createCampaign('Campanha Vazia');
    expect(await vouchers.list({ campaignId: emptyCampaign.id, status: 'CANCELLED' })).toEqual([]);
  });

  test('canBeRestored/restoreBlockedReason ficam nulos/false pra vale que não está CANCELLED', async () => {
    const campaign = await createCampaign();
    const active = await createVoucher(campaign.id, { status: 'ACTIVE' });
    const found = await vouchers.findByCode(active.code);
    expect(found).toMatchObject({ canBeRestored: false, restoreBlockedReason: null });
  });
});
