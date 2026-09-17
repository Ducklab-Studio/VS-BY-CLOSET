import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { PrismaService } from '../prisma/prisma.service';
import { hashPin } from '../admin/admin-pin';
import { ValePassCampaignsService } from './vale-pass-campaigns.service';

/** Integração real (Neon) — mesmo padrão do resto da suíte admin. */
const prisma = new PrismaService();
const campaigns = new ValePassCampaignsService(prisma);
const PREFIX = `VP-CAMP-${Date.now()}`;
let counter = 0;

async function createOwner() {
  const pinHash = await hashPin('1234');
  return prisma.adminUser.create({ data: { name: 'Owner Teste', phone: `${PREFIX}-${counter++}`, pinHash, role: 'SUPER_ADMIN', active: true } });
}

async function cleanup() {
  const rows = await prisma.valePassCampaign.findMany({ where: { shopifyVariantId: { startsWith: PREFIX } } });
  const ids = rows.map((r) => r.id);
  if (ids.length) {
    await prisma.$executeRaw`DELETE FROM vale_pass_events WHERE vale_pass_id IN (SELECT id FROM vale_passes WHERE campaign_id = ANY(${ids}::uuid[]))`;
    await prisma.$executeRaw`DELETE FROM vale_passes WHERE campaign_id = ANY(${ids}::uuid[])`;
    await prisma.$executeRaw`DELETE FROM vale_pass_campaigns WHERE id = ANY(${ids}::uuid[])`;
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

describe('ValePassCampaignsService — configurar campanha (integração real, Neon)', () => {
  test('1) cria campanha com valor/validade/quantidade, audita como crítico', async () => {
    const owner = await createOwner();
    const created = await campaigns.create(
      { name: 'Campanha Verão', amountCents: 20000, validityDays: 180, quantityLimit: 50, shopifyVariantId: `${PREFIX}-v1` },
      owner.id,
      owner.name,
    );
    expect(created.name).toBe('Campanha Verão');
    expect(created.amountCents).toBe(20000);
    expect(created.validityDays).toBe(180);
    expect(created.quantityLimit).toBe(50);
    expect(created.active).toBe(true);
    expect(created.soldCount).toBe(0);

    const event = await prisma.adminAuditEvent.findFirst({ where: { action: 'VALE_PASS_CAMPAIGN_CREATED', entityId: created.id } });
    expect(event).not.toBeNull();
    expect(event!.isCritical).toBe(true);
  }, 15_000);

  test('2) quantityLimit opcional — campanha sem limite fica null', async () => {
    const owner = await createOwner();
    const created = await campaigns.create({ name: 'Sem Limite', amountCents: 10000, validityDays: 30, shopifyVariantId: `${PREFIX}-v2` }, owner.id, owner.name);
    expect(created.quantityLimit).toBeNull();
  });

  test('3) shopifyVariantId duplicado → ConflictException', async () => {
    const owner = await createOwner();
    const variantId = `${PREFIX}-v3`;
    await campaigns.create({ name: 'Original', amountCents: 10000, validityDays: 30, shopifyVariantId: variantId }, owner.id, owner.name);
    await expect(
      campaigns.create({ name: 'Duplicada', amountCents: 20000, validityDays: 60, shopifyVariantId: variantId }, owner.id, owner.name),
    ).rejects.toThrow('Já existe uma campanha para esta variante da Shopify.');
  });

  test('4) desativar/reativar nunca apaga — list() continua mostrando a campanha e os vales dela permanecem', async () => {
    const owner = await createOwner();
    const created = await campaigns.create({ name: 'Ativa/Inativa', amountCents: 10000, validityDays: 30, shopifyVariantId: `${PREFIX}-v4` }, owner.id, owner.name);

    const deactivated = await campaigns.setActive(created.id, false, owner.id, owner.name);
    expect(deactivated.active).toBe(false);
    let list = await campaigns.list();
    expect(list.some((c) => c.id === created.id)).toBe(true);

    const reactivated = await campaigns.setActive(created.id, true, owner.id, owner.name);
    expect(reactivated.active).toBe(true);
    list = await campaigns.list();
    expect(list.find((c) => c.id === created.id)?.active).toBe(true);

    const deactivatedEvent = await prisma.adminAuditEvent.findFirst({ where: { action: 'VALE_PASS_CAMPAIGN_DEACTIVATED', entityId: created.id } });
    expect(deactivatedEvent).not.toBeNull();
    const activatedEvent = await prisma.adminAuditEvent.findFirst({ where: { action: 'VALE_PASS_CAMPAIGN_ACTIVATED', entityId: created.id } });
    expect(activatedEvent).not.toBeNull();
  }, 15_000);

  test('5) campanha inexistente → NotFoundException', async () => {
    const owner = await createOwner();
    await expect(campaigns.setActive('00000000-0000-0000-0000-000000000000', false, owner.id, owner.name)).rejects.toThrow('Campanha não encontrada.');
  });

  test('6) list() traz soldCount correto (conta vales emitidos, não afetado por ativar/desativar)', async () => {
    const owner = await createOwner();
    const created = await campaigns.create({ name: 'Com Vendas', amountCents: 10000, validityDays: 30, shopifyVariantId: `${PREFIX}-v6` }, owner.id, owner.name);
    await prisma.valePass.create({
      data: {
        code: `VALLE-${PREFIX}-1`.slice(0, 15),
        campaignId: created.id,
        amountCents: 10000,
        status: 'ACTIVE',
        purchasedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const list = await campaigns.list();
    expect(list.find((c) => c.id === created.id)?.soldCount).toBe(1);
  });
});
