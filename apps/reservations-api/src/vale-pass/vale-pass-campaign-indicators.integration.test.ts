import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ValePassStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ValePassCampaignsService } from './vale-pass-campaigns.service';
import { ValePassLotsService } from './vale-pass-lots.service';

/**
 * Indicadores do cartão da campanha (list/update/setActive) contra o motor de capacidade, em PostgreSQL LOCAL descartável. Garante que "Vendidos" é a MESMA
 * definição de `totals.sold` (unidade emitida e NÃO totalmente cancelada), que o histórico de emitidos (inclusive cancelados) é preservado e que o modelo
 * (benefícios cadastrados) é o mesmo critério do webhook. Só leitura sobre os dados: nada é apagado nem alterado pelo serviço.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const campaigns = new ValePassCampaignsService(prisma);
const lots = new ValePassLotsService(prisma);
const TAG = `VPIND-${Date.now()}`;
let counter = 0;
const campaignIds: string[] = [];

async function newCampaign(over: { benefits?: number; inactiveBenefit?: boolean; window?: boolean } = {}) {
  const campaign = await prisma.valePassCampaign.create({
    data: {
      name: `${TAG}-camp-${counter++}`, amountCents: 35_000, validityDays: 30, globalLimit: 1_000, shopifyVariantId: `${TAG}-var-${counter++}`,
      ...(over.window ? { voucherValidFrom: new Date('2026-12-01'), voucherValidUntil: new Date('2027-09-30') } : {}),
    },
  });
  campaignIds.push(campaign.id);
  const benefits: { id: string; company: 'VALLE_SHOWROOM' | 'VS_BY_CLOSET' }[] = [];
  for (let i = 0; i < (over.benefits ?? 0); i++) {
    const company = i === 0 ? 'VALLE_SHOWROOM' : 'VS_BY_CLOSET';
    const created = await prisma.valePassCampaignBenefit.create({
      data: { campaignId: campaign.id, code: `b_${i}_${counter++}`, kind: 'VOUCHER', company, label: `Voucher ${i}`, amountCents: i === 0 ? 50_000 : 5_000, sortOrder: i, active: !(over.inactiveBenefit && i === 1) },
    });
    benefits.push({ id: created.id, company });
  }
  return { campaign, benefits };
}

const base = (campaignId: string, status: ValePassStatus) => ({
  campaignId, status, purchasedAt: new Date(), expiresAt: new Date('2027-10-01T03:00:00Z'),
  ...(status === 'CANCELLED' ? { cancelledAt: new Date(), cancelReason: 'teste de indicador' } : {}),
});
/** Voucher legado (sem grupo e sem empresa): uma unidade por linha. */
const legacy = (campaignId: string, status: ValePassStatus) => prisma.valePass.create({ data: { ...base(campaignId, status), code: `${TAG}-L${counter++}`, amountCents: 35_000 } });
/** Unidade nova: dois vouchers do mesmo grupo, cada um com o seu status. */
async function unit(campaignId: string, benefits: { id: string; company: 'VALLE_SHOWROOM' | 'VS_BY_CLOSET' }[], statuses: [ValePassStatus, ValePassStatus]) {
  const groupId = randomUUID();
  for (const [i, benefit] of benefits.entries()) {
    await prisma.valePass.create({ data: { ...base(campaignId, statuses[i]), groupId, benefitId: benefit.id, company: benefit.company, code: `${TAG}-U${counter++}`, amountCents: i === 0 ? 50_000 : 5_000, shopifyOrderId: `${TAG}-o${counter++}` } });
  }
}

const itemOf = async (id: string) => (await campaigns.list()).find((c) => c.id === id)!;
const rowsOf = (id: string) => prisma.valePass.count({ where: { campaignId: id } });

async function clean() {
  const ids = campaignIds.splice(0);
  if (!ids.length) return;
  await prisma.valePass.deleteMany({ where: { campaignId: { in: ids } } });
  await prisma.valePassCampaignBenefit.deleteMany({ where: { campaignId: { in: ids } } });
  await prisma.valePassCampaign.deleteMany({ where: { id: { in: ids } } });
}

localDescribe('indicadores da campanha x motor de capacidade', () => {
  beforeAll(clean);
  afterEach(clean);
  afterAll(async () => {
    await clean();
    await prisma.$disconnect();
  });

  test('voucher legado CANCELADO: vendidos 0, emitidos 1 (histórico preservado) — o caso real da campanha oficial', async () => {
    const { campaign } = await newCampaign({ benefits: 2, window: false });
    await legacy(campaign.id, 'CANCELLED');
    const item = await itemOf(campaign.id);
    expect(item).toMatchObject({ soldCount: 0, issuedCount: 1, benefitsCount: 2, voucherValidFrom: null, voucherValidUntil: null, validityDays: 30, globalLimit: 1_000 });
    expect(await rowsOf(campaign.id)).toBe(1); // nada foi apagado
  });

  test('voucher legado ATIVO, USADO e EXPIRADO contam como vendidos (não cancelados), cada um uma unidade', async () => {
    const { campaign } = await newCampaign();
    await legacy(campaign.id, 'ACTIVE');
    await legacy(campaign.id, 'USED');
    await legacy(campaign.id, 'EXPIRED');
    await legacy(campaign.id, 'CANCELLED');
    expect(await itemOf(campaign.id)).toMatchObject({ soldCount: 3, issuedCount: 4, benefitsCount: 0 });
  });

  test('unidade com dois vouchers conta UMA vez; só deixa de ser vendida quando os DOIS estão cancelados', async () => {
    const { campaign, benefits } = await newCampaign({ benefits: 2 });
    await unit(campaign.id, benefits, ['ACTIVE', 'ACTIVE']); // vendida
    await unit(campaign.id, benefits, ['CANCELLED', 'ACTIVE']); // ainda vendida (um voucher vivo)
    await unit(campaign.id, benefits, ['CANCELLED', 'CANCELLED']); // totalmente cancelada
    await unit(campaign.id, benefits, ['USED', 'CANCELLED']); // vendida
    const item = await itemOf(campaign.id);
    expect(item).toMatchObject({ soldCount: 3, issuedCount: 4, benefitsCount: 2 });
    expect(await rowsOf(campaign.id)).toBe(8); // todas as linhas continuam no banco
  });

  test('"Vendidos" do cartão é IGUAL ao `totals.sold` da capacidade (e emitidos ao `totals.issued`) em todos os cenários', async () => {
    const legacyOnly = await newCampaign();
    await legacy(legacyOnly.campaign.id, 'ACTIVE');
    await legacy(legacyOnly.campaign.id, 'CANCELLED');
    const mixed = await newCampaign({ benefits: 2, window: true });
    await unit(mixed.campaign.id, mixed.benefits, ['ACTIVE', 'ACTIVE']);
    await unit(mixed.campaign.id, mixed.benefits, ['CANCELLED', 'CANCELLED']);
    await legacy(mixed.campaign.id, 'CANCELLED');
    const empty = await newCampaign({ benefits: 2 });
    for (const { campaign } of [legacyOnly, mixed, empty]) {
      const item = await itemOf(campaign.id);
      const { totals, benefits } = await lots.getCapacity(campaign.id);
      expect(item.soldCount, campaign.name).toBe(totals.sold);
      expect(item.issuedCount, campaign.name).toBe(totals.issued);
      expect(item.benefitsCount, campaign.name).toBe(benefits.length);
    }
    expect((await itemOf(empty.campaign.id)).soldCount).toBe(0);
  });

  test('modelo: benefícios cadastrados (ativos ou não) = modelo novo; nenhum = legado; mesmo critério do webhook (contagem de todas as linhas)', async () => {
    const none = await newCampaign();
    const some = await newCampaign({ benefits: 2, inactiveBenefit: true });
    expect((await itemOf(none.campaign.id)).benefitsCount).toBe(0);
    expect((await itemOf(some.campaign.id)).benefitsCount).toBe(2); // o benefício inativo também conta, como no webhook
    const webhookCount = await prisma.valePassCampaignBenefit.count({ where: { campaignId: some.campaign.id } });
    expect((await itemOf(some.campaign.id)).benefitsCount).toBe(webhookCount);
  });

  test('validade: as datas fixas vêm como YYYY-MM-DD e, ausentes, como null (a tela decide "A definir"); validityDays segue disponível para o legado', async () => {
    const withWindow = await newCampaign({ benefits: 2, window: true });
    const without = await newCampaign({ benefits: 2, window: false });
    expect(await itemOf(withWindow.campaign.id)).toMatchObject({ voucherValidFrom: '2026-12-01', voucherValidUntil: '2027-09-30', validityDays: 30 });
    expect(await itemOf(without.campaign.id)).toMatchObject({ voucherValidFrom: null, voucherValidUntil: null, validityDays: 30 });
  });

  test('setActive e update devolvem os mesmos indicadores de list(); desativar/ativar não altera vendidos nem apaga nada', async () => {
    const { campaign, benefits } = await newCampaign({ benefits: 2 });
    await unit(campaign.id, benefits, ['ACTIVE', 'ACTIVE']);
    await legacy(campaign.id, 'CANCELLED');
    const owner = await prisma.adminUser.create({ data: { name: 'Owner Indicadores', phone: `${TAG}-owner`, pinHash: 'x', role: 'SUPER_ADMIN', active: true } });
    try {
      const off = await campaigns.setActive(campaign.id, false, owner.id, owner.name);
      const listed = await itemOf(campaign.id);
      expect([off.soldCount, off.issuedCount, off.benefitsCount]).toEqual([1, 2, 2]);
      expect([listed.soldCount, listed.issuedCount, listed.benefitsCount]).toEqual([1, 2, 2]);
      const on = await campaigns.setActive(campaign.id, true, owner.id, owner.name);
      expect([on.soldCount, on.issuedCount]).toEqual([1, 2]);
      expect(await rowsOf(campaign.id)).toBe(3);
    } finally {
      await prisma.adminAuditEvent.deleteMany({ where: { adminUserId: owner.id } });
      await prisma.adminUser.delete({ where: { id: owner.id } });
    }
  });

  test('a leitura não escreve: list() repetido não cria nem altera vouchers, benefícios nem campanhas', async () => {
    const { campaign, benefits } = await newCampaign({ benefits: 2 });
    await unit(campaign.id, benefits, ['CANCELLED', 'CANCELLED']);
    const before = await prisma.$queryRaw<{ n: bigint; updated: Date }[]>`SELECT (SELECT count(*) FROM vale_passes WHERE campaign_id = ${campaign.id}::uuid)::bigint AS n, (SELECT updated_at FROM vale_pass_campaigns WHERE id = ${campaign.id}::uuid) AS updated`;
    await campaigns.list();
    await campaigns.list();
    const after = await prisma.$queryRaw<{ n: bigint; updated: Date }[]>`SELECT (SELECT count(*) FROM vale_passes WHERE campaign_id = ${campaign.id}::uuid)::bigint AS n, (SELECT updated_at FROM vale_pass_campaigns WHERE id = ${campaign.id}::uuid) AS updated`;
    expect(Number(after[0].n)).toBe(Number(before[0].n));
    expect(after[0].updated.getTime()).toBe(before[0].updated.getTime());
  });

  test('a campanha criada nasce com os indicadores zerados', async () => {
    const owner = await prisma.adminUser.create({ data: { name: 'Owner Criação', phone: `${TAG}-owner2`, pinHash: 'x', role: 'SUPER_ADMIN', active: true } });
    try {
      const created = await campaigns.create({ name: `${TAG} nova`, amountCents: 35_000, validityDays: 30, shopifyVariantId: `${TAG}-nova` }, owner.id, owner.name);
      campaignIds.push(created.id);
      expect([created.soldCount, created.issuedCount, created.benefitsCount]).toEqual([0, 0, 0]);
    } finally {
      await clean();
      await prisma.adminAuditEvent.deleteMany({ where: { adminUserId: owner.id } });
      await prisma.adminUser.delete({ where: { id: owner.id } });
    }
  });
});
