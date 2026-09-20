import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { BadRequestException, ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashPin } from '../admin/admin-pin';
import { ValePassVouchersService } from './vale-pass-vouchers.service';

/** Integração real (Neon) — mesmo padrão do resto da suíte admin. */
const prisma = new PrismaService();
const vouchers = new ValePassVouchersService(prisma);
const PREFIX = `VP-VOU-${Date.now()}`;
let counter = 0;

async function createOwner() {
  const pinHash = await hashPin('1234');
  return prisma.adminUser.create({ data: { name: 'Owner Teste', phone: `${PREFIX}-${counter++}`, pinHash, role: 'SUPER_ADMIN', active: true } });
}

async function createCampaign(name = 'Campanha Teste') {
  return prisma.valePassCampaign.create({
    data: { name, amountCents: 15000, validityDays: 90, shopifyVariantId: `${PREFIX}-variant-${counter++}` },
  });
}

async function createVoucher(campaignId: string, opts: Partial<{ status: 'ACTIVE' | 'USED' | 'EXPIRED' | 'CANCELLED'; expiresAt: Date; code: string; customerName: string; customerPhone: string; shopifyOrderName: string }> = {}) {
  return prisma.valePass.create({
    data: {
      code: opts.code ?? `VALLE-${PREFIX.slice(-4)}-${(counter++).toString().padStart(4, '0')}`,
      campaignId,
      amountCents: 15000,
      status: opts.status ?? 'ACTIVE',
      purchasedAt: new Date(),
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 90 * 86_400_000),
      customerName: opts.customerName ?? 'Cliente Teste',
      customerPhone: opts.customerPhone ?? '+56911112222',
      customerEmail: 'cliente@teste.com',
      shopifyOrderId: `${PREFIX}-order-${counter}`,
      shopifyOrderName: opts.shopifyOrderName ?? `#${counter}`,
    },
  });
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

describe('ValePassVouchersService — listar/buscar/validar/usar/cancelar (integração real, Neon)', () => {
  test('1) findByCode devolve o vale com nome da campanha', async () => {
    const campaign = await createCampaign('Campanha Busca');
    const voucher = await createVoucher(campaign.id);
    const found = await vouchers.findByCode(voucher.code);
    expect(found.code).toBe(voucher.code);
    expect(found.campaignName).toBe('Campanha Busca');
    expect(found.status).toBe('ACTIVE');
  });

  test('2) findByCode aceita minúsculas/espaços (normaliza antes de buscar)', async () => {
    const campaign = await createCampaign();
    const voucher = await createVoucher(campaign.id);
    const found = await vouchers.findByCode(`  ${voucher.code.toLowerCase()}  `);
    expect(found.code).toBe(voucher.code);
  });

  test('3) código inexistente → NotFoundException', async () => {
    await expect(vouchers.findByCode('VALLE-ZZZZ-ZZZZ')).rejects.toThrow(NotFoundException);
  });

  test('4) marcar como utilizado: sucesso na primeira vez, falha na segunda (já usado)', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const voucher = await createVoucher(campaign.id);

    const used = await vouchers.markUsed(voucher.code, owner.id, owner.name);
    expect(used.status).toBe('USED');

    await expect(vouchers.markUsed(voucher.code, owner.id, owner.name)).rejects.toThrow(BadRequestException);

    const event = await prisma.valePassEvent.findFirst({ where: { valePassId: voucher.id, type: 'USED' } });
    expect(event).not.toBeNull();
    const auditEvent = await prisma.adminAuditEvent.findFirst({ where: { action: 'VALE_PASS_MARKED_USED', entityId: voucher.id } });
    expect(auditEvent).not.toBeNull();
    expect(auditEvent!.isCritical).toBe(false); // ação operacional do dia a dia, não crítica
  }, 15_000);

  test('5) não é possível marcar como utilizado um vale CANCELLED', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const voucher = await createVoucher(campaign.id, { status: 'CANCELLED' });
    await expect(vouchers.markUsed(voucher.code, owner.id, owner.name)).rejects.toThrow(BadRequestException);
  });

  test('6) não é possível marcar como utilizado um vale EXPIRED (nem um ACTIVE cujo expiresAt já passou — expiração lazy)', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const voucher = await createVoucher(campaign.id, { status: 'ACTIVE', expiresAt: new Date(Date.now() - 1000) });
    await expect(vouchers.markUsed(voucher.code, owner.id, owner.name)).rejects.toThrow(BadRequestException);
    const reloaded = await prisma.valePass.findUniqueOrThrow({ where: { id: voucher.id } });
    expect(reloaded.status).toBe('EXPIRED');
  }, 15_000);

  test('7) cancelar: sucesso com motivo, audita como crítico, nunca some do banco', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const voucher = await createVoucher(campaign.id);

    const cancelled = await vouchers.cancel(voucher.code, 'pedido cancelado pelo cliente', owner.id, owner.name);
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancelReason).toBe('pedido cancelado pelo cliente');

    const stillExists = await prisma.valePass.findUnique({ where: { id: voucher.id } });
    expect(stillExists).not.toBeNull();

    const auditEvent = await prisma.adminAuditEvent.findFirst({ where: { action: 'VALE_PASS_CANCELLED_BY_ADMIN', entityId: voucher.id } });
    expect(auditEvent).not.toBeNull();
    expect(auditEvent!.isCritical).toBe(true);
  }, 15_000);

  test('8) não é possível cancelar um vale já USADO', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const voucher = await createVoucher(campaign.id, { status: 'USED' });
    await expect(vouchers.cancel(voucher.code, 'motivo qualquer', owner.id, owner.name)).rejects.toThrow(ConflictException);
  });

  test('9) cancelar um vale já CANCELLED → BadRequestException (idempotência explícita, nunca lança de novo silenciosamente)', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const voucher = await createVoucher(campaign.id, { status: 'CANCELLED' });
    await expect(vouchers.cancel(voucher.code, 'motivo qualquer', owner.id, owner.name)).rejects.toThrow(BadRequestException);
  });

  test('10) list() filtra por status, por campanha, e por busca livre (nome, telefone, código, nº do pedido)', async () => {
    const campaignA = await createCampaign('Campanha A');
    const campaignB = await createCampaign('Campanha B');
    const active = await createVoucher(campaignA.id, { status: 'ACTIVE', customerName: `Fulano ${PREFIX}` });
    const used = await createVoucher(campaignA.id, { status: 'USED' });
    const otherCampaign = await createVoucher(campaignB.id, { status: 'ACTIVE' });

    const byStatus = await vouchers.list({ status: 'ACTIVE' });
    expect(byStatus.some((v) => v.id === active.id)).toBe(true);
    expect(byStatus.some((v) => v.id === used.id)).toBe(false);

    const byCampaign = await vouchers.list({ campaignId: campaignA.id });
    expect(byCampaign.some((v) => v.id === active.id)).toBe(true);
    expect(byCampaign.some((v) => v.id === otherCampaign.id)).toBe(false);

    const bySearch = await vouchers.list({ search: `Fulano ${PREFIX}` });
    expect(bySearch.some((v) => v.id === active.id)).toBe(true);
    expect(bySearch.some((v) => v.id === used.id)).toBe(false);

    const byCode = await vouchers.list({ search: active.code });
    expect(byCode.some((v) => v.id === active.id)).toBe(true);
  }, 15_000);

  test('11) list() também aplica expiração lazy — vale ACTIVE vencido aparece como EXPIRED', async () => {
    const campaign = await createCampaign();
    const voucher = await createVoucher(campaign.id, { status: 'ACTIVE', expiresAt: new Date(Date.now() - 1000) });
    const list = await vouchers.list({ campaignId: campaign.id });
    const found = list.find((v) => v.id === voucher.id);
    expect(found?.status).toBe('EXPIRED');
  });

  // Dois operadores atendendo ao mesmo tempo, ou duas chamadas diretas à
  // API, chegavam os dois na gravação depois de passar pela checagem de
  // status — e o mesmo crédito era entregue duas vezes. A invariante
  // verificada aqui é a que interessa: aconteça qual interleaving
  // acontecer, no máximo UMA chamada pode vencer.
  test('12) resgates simultâneos do mesmo código: exatamente um vence, e o vale é gasto uma vez só', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const voucher = await createVoucher(campaign.id);

    // Cinco tentativas em paralelo, e não duas: com duas, o par podia não
    // se sobrepor de fato e o teste passava mesmo contra o código
    // vulnerável. Cinco tornam a sobreposição confiável sem depender de
    // sorte no agendamento.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => vouchers.markUsed(voucher.code, owner.id, owner.name)),
    );

    const wins = results.filter((r) => r.status === 'fulfilled');
    expect(wins).toHaveLength(1);
    expect((wins[0] as PromiseFulfilledResult<{ status: string }>).value.status).toBe('USED');

    // As perdedoras precisam falhar de forma explícita, nunca em silêncio.
    const losers = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(losers).toHaveLength(4);
    for (const loser of losers) expect(loser.reason).toBeInstanceOf(HttpException);

    const reloaded = await prisma.valePass.findUniqueOrThrow({ where: { id: voucher.id } });
    expect(reloaded.status).toBe('USED');

    // Uma única gravação de uso, e uma única linha na trilha de auditoria:
    // é isso que prova que o crédito não saiu duas vezes.
    const usedEvents = await prisma.valePassEvent.findMany({ where: { valePassId: voucher.id, type: 'USED' } });
    expect(usedEvents).toHaveLength(1);
    const auditEvents = await prisma.adminAuditEvent.findMany({ where: { action: 'VALE_PASS_MARKED_USED', entityId: voucher.id } });
    expect(auditEvents).toHaveLength(1);
  }, 20_000);

  test('13) cancelamento e resgate simultâneos: um só vence, e o vale não termina nos dois estados', async () => {
    const owner = await createOwner();
    const campaign = await createCampaign();
    const voucher = await createVoucher(campaign.id);

    const results = await Promise.allSettled([
      vouchers.markUsed(voucher.code, owner.id, owner.name),
      vouchers.cancel(voucher.code, 'cancelamento concorrente de teste', owner.id, owner.name),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);

    const reloaded = await prisma.valePass.findUniqueOrThrow({ where: { id: voucher.id } });
    expect(['USED', 'CANCELLED']).toContain(reloaded.status);

    // O estado final tem de ter UMA causa só: ou foi usado, ou foi
    // cancelado. Os dois carimbos ao mesmo tempo seria a corrida.
    const stamps = [reloaded.usedAt, reloaded.cancelledAt].filter((value) => value !== null);
    expect(stamps).toHaveLength(1);

    const events = await prisma.valePassEvent.findMany({ where: { valePassId: voucher.id, type: { in: ['USED', 'CANCELLED'] } } });
    expect(events).toHaveLength(1);
  }, 20_000);
});
