import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ValePassCampaign } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { REQUIRE_MODULE_KEY } from '../admin/require-module.decorator';
import { REQUIRE_ROLE_KEY } from '../admin/require-role.decorator';
import { ValePassCampaignsService } from './vale-pass-campaigns.service';
import { ValePassCampaignsController } from './vale-pass-campaigns.controller';
import { ValePassLotsService } from './vale-pass-lots.service';
import { unitAggregates } from './vale-pass-capacity';

/**
 * Campanhas editáveis, lotes e capacidade do Valle Pass — PostgreSQL LOCAL descartável (sem `DATABASE_URL` de loopback com
 * nome de teste o arquivo é pulado). Linhas COMMITADAS com prefixo exclusivo desta bateria (as transações dos serviços
 * não permitem rollback externo); a limpeza só apaga o que tem o prefixo, no banco de teste. Nenhuma Shopify, nenhum e-mail.
 */
const localDatabase = /^postgres(?:ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\/[^/]*(test|audit|operational)/i.test(process.env.DATABASE_URL ?? '');
const localDescribe = localDatabase ? describe : describe.skip;

const prisma = new PrismaService();
const campaigns = new ValePassCampaignsService(prisma);
const lots = new ValePassLotsService(prisma);

const TAG = `VPL-${Date.now()}`;
let counter = 0;
let adminId: string;
const ADMIN_NAME = 'Admin Teste Lotes';
const createdCampaigns: string[] = [];
const createdOrders: string[] = [];

async function newCampaign(over: Partial<{ quantityLimit: number | null; globalLimit: number | null; active: boolean; amountCents: number; validityDays: number }> = {}): Promise<ValePassCampaign> {
  const c = await prisma.valePassCampaign.create({
    data: {
      name: `${TAG}-camp-${counter++}`,
      amountCents: over.amountCents ?? 35_000,
      validityDays: over.validityDays ?? 30,
      quantityLimit: over.quantityLimit === undefined ? null : over.quantityLimit,
      globalLimit: over.globalLimit === undefined ? null : over.globalLimit,
      active: over.active ?? true,
      shopifyVariantId: `${TAG}-var-${counter++}`,
    },
  });
  createdCampaigns.push(c.id);
  return c;
}

/** Vale emitido NO horário indicado (o que define o lote). */
async function voucher(campaignId: string, at: Date, status: 'ACTIVE' | 'USED' | 'EXPIRED' | 'CANCELLED' = 'ACTIVE', orderId: string | null = null) {
  return prisma.valePass.create({
    data: {
      code: `${TAG}-${counter++}`,
      campaignId,
      amountCents: 35_000,
      status,
      purchasedAt: at,
      expiresAt: new Date(at.getTime() + 30 * 86_400_000),
      shopifyOrderId: orderId,
    },
  });
}

const stamp = (row: { updatedAt: string | Date }) => (typeof row.updatedAt === 'string' ? row.updatedAt : row.updatedAt.toISOString());
const lotStamp = async (id: string) => (await prisma.valePassLot.findUniqueOrThrow({ where: { id } })).updatedAt.toISOString();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const auditFor = (entityId: string) => prisma.adminAuditEvent.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });

beforeAll(async () => {
  if (!localDatabase) return;
  const admin = await prisma.adminUser.create({ data: { name: ADMIN_NAME, phone: `${TAG}-phone`, pinHash: 'x', role: 'ADMIN', active: true } });
  adminId = admin.id;
});

afterAll(async () => {
  if (localDatabase) {
    const lotRows = await prisma.valePassLot.findMany({ where: { campaignId: { in: createdCampaigns } }, select: { id: true } });
    const entityIds = [...createdCampaigns, ...lotRows.map((l) => l.id)];
    await prisma.adminAuditEvent.deleteMany({ where: { entityId: { in: entityIds } } });
    await prisma.valePassLot.deleteMany({ where: { campaignId: { in: createdCampaigns } } });
    await prisma.valePassEvent.deleteMany({ where: { valePass: { campaignId: { in: createdCampaigns } } } });
    await prisma.valePass.deleteMany({ where: { campaignId: { in: createdCampaigns } } });
    await prisma.valePassCampaign.deleteMany({ where: { id: { in: createdCampaigns } } });
    await prisma.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: createdOrders } } });
    await prisma.adminAuditEvent.deleteMany({ where: { adminUserId: adminId } });
    await prisma.adminUser.deleteMany({ where: { id: adminId } });
  }
  await prisma.$disconnect();
});

localDescribe('Valle Pass — edição de campanha', () => {
  test('edita a configuração, audita antes/depois e NÃO toca nos passes já emitidos', async () => {
    const c = await newCampaign({ quantityLimit: 10 });
    const issuedAt = new Date(Date.now() - 86_400_000);
    const v = await voucher(c.id, issuedAt);

    const updated = await campaigns.update(
      c.id,
      { expectedUpdatedAt: stamp(c), name: `${TAG}-2027`, amountCents: 50_000, validityDays: 365, quantityLimit: null, globalLimit: 1000, voucherValidFrom: '2027-01-01', voucherValidUntil: '2027-12-31', salesEndDate: '2027-05-30' },
      adminId,
      ADMIN_NAME,
    );
    expect(updated).toMatchObject({ amountCents: 50_000, validityDays: 365, quantityLimit: null, globalLimit: 1000, voucherValidFrom: '2027-01-01', voucherValidUntil: '2027-12-31', salesEndDate: '2027-05-30', soldCount: 1 });

    // o passe emitido antes mantém valor, validade e código
    const after = await prisma.valePass.findUniqueOrThrow({ where: { id: v.id } });
    expect(after.amountCents).toBe(35_000);
    expect(after.expiresAt.getTime()).toBe(v.expiresAt.getTime());
    expect(after.code).toBe(v.code);
    expect(after.status).toBe('ACTIVE');

    const [event] = await auditFor(c.id);
    expect(event.action).toBe('VALE_PASS_CAMPAIGN_UPDATED');
    expect(event.adminUserId).toBe(adminId);
    expect(event.before).toMatchObject({ amountCents: 35_000, validityDays: 30, quantityLimit: 10, globalLimit: null });
    expect(event.after).toMatchObject({ amountCents: 50_000, validityDays: 365, quantityLimit: null, globalLimit: 1000, voucherValidFrom: '2027-01-01' });
    expect(event.isCritical).toBe(true); // ação nova entra na lista de críticas
  });

  test('sem mudança real não grava nada nem audita', async () => {
    const c = await newCampaign();
    const same = await campaigns.update(c.id, { expectedUpdatedAt: stamp(c), amountCents: c.amountCents }, adminId, ADMIN_NAME);
    expect(same.updatedAt).toBe(stamp(c));
    expect(await auditFor(c.id)).toHaveLength(0);
  });

  test('versão antiga é recusada (409); duas edições simultâneas: uma vence, a outra recebe 409', async () => {
    const c = await newCampaign();
    await sleep(5); // a versão nova precisa diferir em pelo menos 1 ms da gravada na criação
    await campaigns.update(c.id, { expectedUpdatedAt: stamp(c), name: `${TAG}-a` }, adminId, ADMIN_NAME);
    await expect(campaigns.update(c.id, { expectedUpdatedAt: stamp(c), name: `${TAG}-b` }, adminId, ADMIN_NAME)).rejects.toBeInstanceOf(ConflictException);

    const d = await newCampaign();
    const results = await Promise.allSettled([
      campaigns.update(d.id, { expectedUpdatedAt: stamp(d), name: `${TAG}-x` }, adminId, ADMIN_NAME),
      campaigns.update(d.id, { expectedUpdatedAt: stamp(d), name: `${TAG}-y` }, adminId, ADMIN_NAME),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictException);
    expect(await auditFor(d.id)).toHaveLength(1);
  });

  test('limites incoerentes com o que já foi vendido são recusados com explicação, sem gravar', async () => {
    const c = await newCampaign({ quantityLimit: 50 });
    const now = Date.now();
    for (let i = 0; i < 4; i++) await voucher(c.id, new Date(now - 1000 * (i + 1)));
    await voucher(c.id, new Date(now - 9000), 'CANCELLED');

    await expect(campaigns.update(c.id, { expectedUpdatedAt: stamp(c), quantityLimit: 4 }, adminId, ADMIN_NAME)).rejects.toThrow(/próximo pagamento ficaria sem passe/); // 5 emitidos (1 cancelado)
    await expect(campaigns.update(c.id, { expectedUpdatedAt: stamp(c), globalLimit: 3 }, adminId, ADMIN_NAME)).rejects.toBeInstanceOf(UnprocessableEntityException); // 4 vendidos
    // global = 4 é aceito (cancelado não conta); legado precisa de ≥ 5
    const ok = await campaigns.update(c.id, { expectedUpdatedAt: stamp(c), globalLimit: 4, quantityLimit: 5 }, adminId, ADMIN_NAME);
    expect(ok).toMatchObject({ globalLimit: 4, quantityLimit: 5 });
    expect((await prisma.valePassCampaign.findUniqueOrThrow({ where: { id: c.id } })).globalLimit).toBe(4);
  });

  test('o banco recusa janela de validade incoerente e limite global zero (rede de proteção)', async () => {
    const c = await newCampaign();
    await expect(prisma.$executeRaw`UPDATE vale_pass_campaigns SET voucher_valid_from = '2027-01-01' WHERE id = ${c.id}::uuid`).rejects.toThrow(/vpc_voucher_window/);
    await expect(prisma.$executeRaw`UPDATE vale_pass_campaigns SET voucher_valid_from = '2027-12-31', voucher_valid_until = '2027-01-01' WHERE id = ${c.id}::uuid`).rejects.toThrow(/vpc_voucher_window/);
    await expect(prisma.$executeRaw`UPDATE vale_pass_campaigns SET global_limit = 0 WHERE id = ${c.id}::uuid`).rejects.toThrow(/vpc_global_limit_positive/);
  });
});

localDescribe('Valle Pass — lotes e limite global', () => {
  test('ciclo completo: criar → abrir → vender → encerrar; um lote encerrado nunca reabre', async () => {
    const c = await newCampaign({ globalLimit: 1000 });
    const lot1 = await lots.create(c.id, { name: 'Lote 1', quantity: 100 }, adminId, ADMIN_NAME);
    expect(lot1).toMatchObject({ status: 'PLANNED', quantity: 100, sold: 0, remaining: 100, openedAt: null });

    // vales emitidos ANTES de abrir o lote não pertencem a ele
    await voucher(c.id, new Date(Date.now() - 60_000));
    await sleep(15);
    const opened = await lots.open(c.id, lot1.id, await lotStamp(lot1.id), adminId, ADMIN_NAME);
    expect(opened.status).toBe('OPEN');
    await sleep(15);
    for (let i = 0; i < 3; i++) await voucher(c.id, new Date());
    await voucher(c.id, new Date(), 'CANCELLED');
    await sleep(15);

    let capacity = await lots.getCapacity(c.id);
    expect(capacity.totals).toMatchObject({ issued: 5, cancelled: 1, sold: 4 });
    expect(capacity.globalRemaining).toBe(996);
    expect(capacity.openLot).toMatchObject({ id: lot1.id, sold: 3, remaining: 97, soldOut: false });
    expect(capacity.recommendedShopifyStock).toBe(97);

    const closed = await lots.close(c.id, lot1.id, await lotStamp(lot1.id), adminId, ADMIN_NAME);
    expect(closed).toMatchObject({ status: 'CLOSED', sold: 3 });
    // vale emitido DEPOIS do encerramento não entra no lote 1
    await sleep(15);
    await voucher(c.id, new Date());
    capacity = await lots.getCapacity(c.id);
    expect(capacity.lots.find((l) => l.id === lot1.id)).toMatchObject({ status: 'CLOSED', sold: 3 });
    expect(capacity.openLot).toBeNull();
    expect(capacity.recommendedShopifyStock).toBe(0);

    await expect(lots.open(c.id, lot1.id, await lotStamp(lot1.id), adminId, ADMIN_NAME)).rejects.toThrow(/nunca é reaberto/);
    await expect(lots.close(c.id, lot1.id, await lotStamp(lot1.id), adminId, ADMIN_NAME)).rejects.toBeInstanceOf(ConflictException);

    const actions = (await auditFor(lot1.id)).map((e) => e.action);
    expect(actions).toEqual(['VALE_PASS_LOT_CREATED', 'VALE_PASS_LOT_OPENED', 'VALE_PASS_LOT_CLOSED']);
  });

  test('passe cancelado libera capacidade (lote e global)', async () => {
    const c = await newCampaign({ globalLimit: 10 });
    const lot = await lots.create(c.id, { name: 'Lote A', quantity: 5 }, adminId, ADMIN_NAME);
    await lots.open(c.id, lot.id, await lotStamp(lot.id), adminId, ADMIN_NAME);
    await sleep(15);
    const first = await voucher(c.id, new Date());
    await voucher(c.id, new Date());
    expect((await lots.getCapacity(c.id)).openLot).toMatchObject({ sold: 2, remaining: 3 });
    await prisma.valePass.update({ where: { id: first.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    const capacity = await lots.getCapacity(c.id);
    expect(capacity.openLot).toMatchObject({ sold: 1, remaining: 4 });
    expect(capacity.globalRemaining).toBe(9);
  });

  test('exige limite global para abrir; o lote nunca pode exceder o saldo global', async () => {
    const semGlobal = await newCampaign();
    const lotA = await lots.create(semGlobal.id, { name: 'Lote', quantity: 100 }, adminId, ADMIN_NAME);
    await expect(lots.open(semGlobal.id, lotA.id, await lotStamp(lotA.id), adminId, ADMIN_NAME)).rejects.toThrow(/limite global/);

    const c = await newCampaign({ globalLimit: 150 });
    for (let i = 0; i < 100; i++) await voucher(c.id, new Date(Date.now() - 1000 - i));
    await expect(lots.create(c.id, { name: 'Grande', quantity: 51 }, adminId, ADMIN_NAME)).rejects.toThrow(/não cabe no saldo do limite global \(50 restantes de 150,/);
    const fits = await lots.create(c.id, { name: 'Cabe', quantity: 50 }, adminId, ADMIN_NAME);
    expect(fits.quantity).toBe(50);
    await lots.open(c.id, fits.id, await lotStamp(fits.id), adminId, ADMIN_NAME);
    // não dá para aumentar o lote aberto além do saldo global
    await expect(lots.update(c.id, fits.id, { expectedUpdatedAt: await lotStamp(fits.id), quantity: 51 }, adminId, ADMIN_NAME)).rejects.toThrow(/não cabe no limite global/);
  });

  test('um lote aberto por campanha: dois pedidos de abertura simultâneos, só um vence', async () => {
    const c = await newCampaign({ globalLimit: 1000 });
    const a = await lots.create(c.id, { name: 'A', quantity: 100 }, adminId, ADMIN_NAME);
    const b = await lots.create(c.id, { name: 'B', quantity: 100 }, adminId, ADMIN_NAME);
    const results = await Promise.allSettled([
      lots.open(c.id, a.id, await lotStamp(a.id), adminId, ADMIN_NAME),
      lots.open(c.id, b.id, await lotStamp(b.id), adminId, ADMIN_NAME),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(ConflictException);
    expect((await prisma.valePassLot.count({ where: { campaignId: c.id, status: 'OPEN' } }))).toBe(1);
  });

  test('o banco é a última linha: dois lotes abertos e estados incoerentes são recusados', async () => {
    const c = await newCampaign({ globalLimit: 1000 });
    const a = await lots.create(c.id, { name: 'A', quantity: 10 }, adminId, ADMIN_NAME);
    const b = await lots.create(c.id, { name: 'B', quantity: 10 }, adminId, ADMIN_NAME);
    await prisma.$executeRaw`UPDATE vale_pass_lots SET status = 'OPEN', open_flag = true, opened_at = now() WHERE id = ${a.id}::uuid`;
    await expect(prisma.$executeRaw`UPDATE vale_pass_lots SET status = 'OPEN', open_flag = true, opened_at = now() WHERE id = ${b.id}::uuid`).rejects.toThrow(/unique|duplicate|open_flag/i);
    await expect(prisma.$executeRaw`UPDATE vale_pass_lots SET status = 'OPEN', open_flag = NULL, opened_at = now() WHERE id = ${b.id}::uuid`).rejects.toThrow(/vpl_open_flag_matches_status/);
    await expect(prisma.$executeRaw`UPDATE vale_pass_lots SET status = 'CLOSED', opened_at = now(), closed_at = now() - interval '1 hour' WHERE id = ${b.id}::uuid`).rejects.toThrow(/vpl_timestamps_match_status/);
    await expect(prisma.$executeRaw`UPDATE vale_pass_lots SET quantity = 0 WHERE id = ${b.id}::uuid`).rejects.toThrow(/vpl_quantity_positive/);
  });

  test('campanha encerrada não abre lote; lote planejado pode ser editado e cancelado; aberto só muda a quantidade', async () => {
    const inativa = await newCampaign({ globalLimit: 100, active: false });
    const l = await lots.create(inativa.id, { name: 'L', quantity: 10 }, adminId, ADMIN_NAME);
    await expect(lots.open(inativa.id, l.id, await lotStamp(l.id), adminId, ADMIN_NAME)).rejects.toThrow(/encerrada/);

    const c = await newCampaign({ globalLimit: 100 });
    const lot = await lots.create(c.id, { name: 'Original', quantity: 10 }, adminId, ADMIN_NAME);
    const renamed = await lots.update(c.id, lot.id, { expectedUpdatedAt: await lotStamp(lot.id), name: 'Renomeado', quantity: 20 }, adminId, ADMIN_NAME);
    expect(renamed).toMatchObject({ name: 'Renomeado', quantity: 20 });
    await lots.open(c.id, lot.id, await lotStamp(lot.id), adminId, ADMIN_NAME);
    await expect(lots.update(c.id, lot.id, { expectedUpdatedAt: await lotStamp(lot.id), name: 'Outro' }, adminId, ADMIN_NAME)).rejects.toThrow(/só a quantidade/);
    await sleep(15);
    for (let i = 0; i < 6; i++) await voucher(c.id, new Date());
    await expect(lots.update(c.id, lot.id, { expectedUpdatedAt: await lotStamp(lot.id), quantity: 5 }, adminId, ADMIN_NAME)).rejects.toThrow(/menor que os 6 passes já vendidos/);
    expect((await lots.update(c.id, lot.id, { expectedUpdatedAt: await lotStamp(lot.id), quantity: 6 }, adminId, ADMIN_NAME)).soldOut).toBe(true);
    await expect(lots.cancel(c.id, lot.id, await lotStamp(lot.id), adminId, ADMIN_NAME)).rejects.toThrow(/Encerrar/);

    const spare = await lots.create(c.id, { name: 'Sobra', quantity: 5 }, adminId, ADMIN_NAME);
    expect((await lots.cancel(c.id, spare.id, await lotStamp(spare.id), adminId, ADMIN_NAME)).status).toBe('CANCELLED');
    await expect(lots.open(c.id, spare.id, await lotStamp(spare.id), adminId, ADMIN_NAME)).rejects.toThrow(/planejado/);
  });

  test('ação sobre versão antiga do lote é recusada (409); lote de outra campanha não é encontrado', async () => {
    const c = await newCampaign({ globalLimit: 100 });
    const other = await newCampaign({ globalLimit: 100 });
    const lot = await lots.create(c.id, { name: 'L', quantity: 10 }, adminId, ADMIN_NAME);
    const old = await lotStamp(lot.id);
    await sleep(5);
    await lots.update(c.id, lot.id, { expectedUpdatedAt: old, quantity: 12 }, adminId, ADMIN_NAME);
    await expect(lots.open(c.id, lot.id, old, adminId, ADMIN_NAME)).rejects.toBeInstanceOf(ConflictException);
    await expect(lots.open(other.id, lot.id, await lotStamp(lot.id), adminId, ADMIN_NAME)).rejects.toThrow(/Lote não encontrado/);
  });

  test('editar o limite global com lote aberto exige comportar o saldo do lote', async () => {
    const c = await newCampaign({ globalLimit: 1000 });
    const lot = await lots.create(c.id, { name: 'L', quantity: 100 }, adminId, ADMIN_NAME);
    await lots.open(c.id, lot.id, await lotStamp(lot.id), adminId, ADMIN_NAME);
    const fresh = await prisma.valePassCampaign.findUniqueOrThrow({ where: { id: c.id } });
    await expect(campaigns.update(c.id, { expectedUpdatedAt: stamp(fresh), globalLimit: 99 }, adminId, ADMIN_NAME)).rejects.toThrow(/não comporta o saldo do lote aberto/);
    expect((await campaigns.update(c.id, { expectedUpdatedAt: stamp(fresh), globalLimit: 100 }, adminId, ADMIN_NAME)).globalLimit).toBe(100);
  });
});

localDescribe('Valle Pass — travamento da campanha (determinístico)', () => {
  /**
   * Outra transação (como será a emissão de vales na etapa seguinte) trava a campanha, muda um dado dela e só então
   * confirma. Quem edita/abre lote DEPOIS tem que ENXERGAR essa mudança: sem o `FOR UPDATE`, a leitura anterior ao commit
   * passaria nas validações com o estado antigo (atualização perdida / lote acima do novo limite).
   */
  async function holdAndChange(campaignId: string, sqlChange: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>) {
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => (signalLocked = resolve));
    const finished = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vale_pass_campaigns WHERE id = ${campaignId}::uuid FOR UPDATE`;
      signalLocked();
      await sleep(350);
      await sqlChange(tx);
    }, { timeout: 10_000 });
    await locked; // só devolve DEPOIS de a trava estar tomada
    // `finished` vai dentro de um objeto: devolvê-lo direto faria o `await` do chamador esperar o COMMIT (e a corrida voltaria)
    return { finished };
  }

  test('editar a campanha enxerga a mudança feita por quem a tinha travada (409, sem atualização perdida)', async () => {
    const c = await newCampaign();
    // Nova versão = 1 s depois da que esta pessoa viu. (Com `now()` o relógio do banco podia cair no MESMO milissegundo do `updatedAt`
    // gravado pelo Prisma e a versão "nova" parecer igual à antiga — foi o que reprovou este teste no CI.)
    const newer = new Date(c.updatedAt.getTime() + 1000);
    const { finished: holder } = await holdAndChange(c.id, (tx) => tx.$executeRaw`UPDATE vale_pass_campaigns SET name = ${TAG + '-do-outro'}, updated_at = ${newer} WHERE id = ${c.id}::uuid`);
    // começa depois de o outro travar; a versão que esta pessoa viu já é a antiga
    await expect(campaigns.update(c.id, { expectedUpdatedAt: stamp(c), name: `${TAG}-minha` }, adminId, ADMIN_NAME)).rejects.toBeInstanceOf(ConflictException);
    await holder;
    expect((await prisma.valePassCampaign.findUniqueOrThrow({ where: { id: c.id } })).name).toBe(`${TAG}-do-outro`);
  });

  test('abrir um lote enxerga o novo limite global confirmado por quem tinha a campanha travada', async () => {
    const c = await newCampaign({ globalLimit: 100 });
    const lot = await lots.create(c.id, { name: 'L', quantity: 10 }, adminId, ADMIN_NAME);
    const { finished: holder } = await holdAndChange(c.id, (tx) => tx.$executeRaw`UPDATE vale_pass_campaigns SET global_limit = 5 WHERE id = ${c.id}::uuid`);
    await expect(lots.open(c.id, lot.id, await lotStamp(lot.id), adminId, ADMIN_NAME)).rejects.toThrow(/não cabe no saldo do limite global \(5 restantes de 5,/);
    await holder;
    expect((await prisma.valePassLot.findUniqueOrThrow({ where: { id: lot.id } })).status).toBe('PLANNED');
  });
});

localDescribe('Valle Pass — capacidade CONSUMIDA (vendido + pago aguardando emissão)', () => {
  let storeId: string;
  let webhookCounter = 0;
  const orderIds: string[] = [];

  beforeAll(async () => {
    storeId = `${TAG}-store`;
    await prisma.$executeRaw`INSERT INTO stores (id, shopify_domain, currency) VALUES (${storeId}, ${storeId + '.invalid'}, 'BRL')`;
  });

  afterAll(async () => {
    await prisma.webhookEvent.deleteMany({ where: { storeId } });
    await prisma.$executeRaw`DELETE FROM stores WHERE id = ${storeId}`;
  });

  afterEach(async () => {
    // Pedidos pagos sem vale e sem payload são cobrados de TODAS as campanhas (lado seguro): nunca deixe um para o teste seguinte.
    await prisma.webhookEvent.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: orderIds } } });
    orderIds.length = 0;
  });

  /** Pedido registrado como a emissão o deixaria; `variant` simula o que a Shopify enviou no webhook (atribuição à campanha). */
  async function paidOrder(
    campaign: ValePassCampaign,
    quantity: number,
    options: { status?: 'CONFIRMED' | 'PENDING' | 'REFUNDED' | 'CANCELLED' | 'EXPIRED' | 'DECLINED'; processed?: boolean; deleted?: boolean; withPayload?: boolean; variant?: string } = {},
  ) {
    const id = `${TAG}-o${counter++}`;
    orderIds.push(id);
    await prisma.valePassOrder.create({
      data: {
        shopifyOrderId: id,
        shopifyOrderName: `${TAG}#${counter}`,
        status: options.status ?? 'CONFIRMED',
        financialStatus: 'paid',
        quantity,
        lastSyncSource: 'teste',
        orderCreatedAt: new Date(Date.now() - 3_600_000),
        statusChangedAt: new Date(Date.now() - 3_600_000),
        vouchersProcessedAt: options.processed === false ? null : new Date(),
        deletedInShopifyAt: options.deleted ? new Date() : null,
      },
    });
    if (options.withPayload !== false) {
      await prisma.webhookEvent.create({
        data: {
          shopifyWebhookId: `${TAG}-wh-${webhookCounter++}`,
          storeId,
          topic: 'orders/paid',
          orderId: id,
          status: 'processed',
          payload: { id, line_items: [{ variant_id: options.variant ?? campaign.shopifyVariantId, quantity }] },
        },
      });
    }
    return id;
  }
  const issue = async (campaignId: string, orderId: string, n: number, status: 'ACTIVE' | 'CANCELLED' | 'USED' = 'ACTIVE') => {
    for (let i = 0; i < n; i++) await voucher(campaignId, new Date(), status, orderId);
  };
  const totalsOf = async (campaignId: string) => (await lots.getCapacity(campaignId)).totals;

  test('o exemplo da auditoria: 5 unidades pagas, 1 emitida → consumidas 5 (não 1); o lote não abre com capacidade fictícia', async () => {
    const c = await newCampaign({ globalLimit: 10 });
    const o1 = await paidOrder(c, 3, { processed: true });
    await issue(c.id, o1, 1);
    await paidOrder(c, 2, { processed: false });

    const capacity = await lots.getCapacity(c.id);
    expect(capacity.totals).toMatchObject({ issued: 1, sold: 1, pending: 4, consumed: 5 });
    expect(capacity.globalRemaining).toBe(5);

    const tooBig = await lots.create(c.id, { name: 'Ficticio', quantity: 6 }, adminId, ADMIN_NAME).catch((e) => e);
    expect(tooBig).toBeInstanceOf(UnprocessableEntityException); // com a contagem antiga (1 vendido) um lote de 6 ou de 9 passaria
    expect((tooBig as Error).message).toMatch(/5 restantes de 10/);

    const lot = await lots.create(c.id, { name: 'Real', quantity: 5 }, adminId, ADMIN_NAME);
    const opened = await lots.open(c.id, lot.id, lot.updatedAt, adminId, ADMIN_NAME);
    expect(opened).toMatchObject({ status: 'OPEN', sold: 0, pending: 4, remaining: 1 }); // as 4 unidades pagas esperando emissão já ocupam o lote
    const after = await lots.getCapacity(c.id);
    expect(after.openLot).toMatchObject({ remaining: 1, soldOut: false });
    expect(after.recommendedShopifyStock).toBe(1);
    expect(after.alerts.map((a) => a.code)).toEqual(expect.arrayContaining(['PAID_ORDERS_WITHOUT_VOUCHER', 'PAID_UNITS_COUNTED_AS_SOLD']));
    await expect(lots.update(c.id, lot.id, { expectedUpdatedAt: opened.updatedAt, quantity: 3 }, adminId, ADMIN_NAME)).rejects.toThrow(/menor que os 4 passes já vendidos ou pagos aguardando emissão/);
  });

  test('a emissão completa depois NÃO conta duas vezes: consumido fica em 5 em cada etapa, parcial ou total', async () => {
    const c = await newCampaign({ globalLimit: 10 });
    const o1 = await paidOrder(c, 3);
    const o2 = await paidOrder(c, 2, { processed: false });
    const consumed = async () => (await totalsOf(c.id)).consumed;
    expect(await consumed()).toBe(5);
    await issue(c.id, o1, 1);
    expect(await consumed()).toBe(5);
    await issue(c.id, o1, 2);
    expect(await consumed()).toBe(5);
    await issue(c.id, o2, 1);
    expect(await consumed()).toBe(5);
    await issue(c.id, o2, 1);
    expect(await consumed()).toBe(5);
    expect(await totalsOf(c.id)).toMatchObject({ sold: 5, pending: 0 });
    expect((await lots.getCapacity(c.id)).alerts.map((a) => a.code)).not.toContain('PAID_ORDERS_WITHOUT_VOUCHER');
    // emitir além do comprado (reprocessamento indevido) nunca gera pendência negativa
    await issue(c.id, o2, 2);
    expect((await totalsOf(c.id)).pending).toBe(0);
  });

  test('cancelamento e reembolso seguem as regras existentes: liberam capacidade; pedido não pago ou excluído nunca consome', async () => {
    const c = await newCampaign({ globalLimit: 20 });
    // pedidos que NÃO consomem: pendente de pagamento, expirado, recusado, cancelado, reembolsado e pago-mas-excluído-na-Shopify
    for (const status of ['PENDING', 'EXPIRED', 'DECLINED', 'CANCELLED', 'REFUNDED'] as const) await paidOrder(c, 3, { status, processed: false });
    await paidOrder(c, 3, { deleted: true, processed: false });
    expect(await totalsOf(c.id)).toMatchObject({ pending: 0, consumed: 0 });

    // pedido pago e emitido; o vale é cancelado (reembolso) e o pedido passa a REFUNDED: libera
    const paid = await paidOrder(c, 2);
    await issue(c.id, paid, 2);
    expect((await totalsOf(c.id)).consumed).toBe(2);
    await prisma.valePass.updateMany({ where: { shopifyOrderId: paid }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    // mesmo com o pedido ainda CONFIRMED, o passe cancelado foi EMITIDO: não vira pendência de novo e a capacidade foi liberada
    expect(await totalsOf(c.id)).toMatchObject({ sold: 0, pending: 0, consumed: 0, cancelled: 2 });
  });

  test('pedido duplicado ou webhook repetido não gera contagem dupla (um registro por pedido)', async () => {
    const c = await newCampaign({ globalLimit: 10 });
    const id = await paidOrder(c, 2, { processed: false });
    await expect(prisma.valePassOrder.create({ data: { shopifyOrderId: id, status: 'CONFIRMED', quantity: 2, lastSyncSource: 'teste' } })).rejects.toThrow(/Unique constraint|unique/i);
    expect((await totalsOf(c.id)).pending).toBe(2);
    // o mesmo pedido entregue várias vezes pela Shopify deixa vários webhook_events, mas conta uma vez só
    for (let i = 0; i < 3; i++) {
      await prisma.webhookEvent.create({ data: { shopifyWebhookId: `${TAG}-dup-${webhookCounter++}`, storeId, topic: 'orders/updated', orderId: id, status: 'processed', payload: { id, line_items: [{ variant_id: c.shopifyVariantId, quantity: 2 }] } } });
    }
    expect((await totalsOf(c.id)).pending).toBe(2);
  });

  test('atribuição à campanha: pela variante do payload, pelos vales existentes ou, sem como saber, a todas (nunca libera)', async () => {
    const mine = await newCampaign({ globalLimit: 50 });
    const other = await newCampaign({ globalLimit: 50 });
    await paidOrder(other, 4, { processed: false }); // payload da OUTRA campanha → não é minha
    await paidOrder(mine, 2, { processed: false });
    expect((await totalsOf(mine.id)).pending).toBe(2);
    expect((await totalsOf(other.id)).pending).toBe(4);

    const base = (await totalsOf(mine.id)).pending;
    await paidOrder(mine, 7, { processed: false, withPayload: false }); // reconciliação sem payload: variante desconhecida
    expect((await totalsOf(mine.id)).pending).toBe(base + 7);
    expect((await totalsOf(other.id)).pending).toBe(4 + 7); // cobrado também da outra (lado seguro)

    const partial = await paidOrder(other, 3);
    await issue(other.id, partial, 1); // já tem vale da OUTRA campanha → o que falta é dela, não da minha
    expect((await totalsOf(other.id)).pending).toBe(4 + 7 + 2);
    expect((await totalsOf(mine.id)).pending).toBe(base + 7);
  });

  test('limites coerentes com o consumo: global e legado não podem ficar abaixo do vendido + pago aguardando', async () => {
    const c = await newCampaign({ globalLimit: 10, quantityLimit: 20 });
    const o = await paidOrder(c, 5, { processed: false });
    await issue(c.id, o, 1);
    const row = await prisma.valePassCampaign.findUniqueOrThrow({ where: { id: c.id } });
    await expect(campaigns.update(c.id, { expectedUpdatedAt: stamp(row), globalLimit: 4 }, adminId, ADMIN_NAME)).rejects.toThrow(/menor que os 5 passes já vendidos \(incluindo pagos aguardando emissão\)/);
    await expect(campaigns.update(c.id, { expectedUpdatedAt: stamp(row), quantityLimit: 4 }, adminId, ADMIN_NAME)).rejects.toThrow(/ou pagos aguardando emissão/);
    expect((await campaigns.update(c.id, { expectedUpdatedAt: stamp(row), globalLimit: 5 }, adminId, ADMIN_NAME)).globalLimit).toBe(5);
  });

  test('consumo acima do limite (excedente) vira alerta CRÍTICO e saldo 0, nunca saldo negativo nem lote novo', async () => {
    const c = await newCampaign({ globalLimit: 3 });
    const o = await paidOrder(c, 5, { processed: false });
    const capacity = await lots.getCapacity(c.id);
    expect(capacity.totals.consumed).toBe(5);
    expect(capacity.globalRemaining).toBe(0);
    expect(capacity.alerts.find((a) => a.code === 'GLOBAL_LIMIT_EXCEEDED')?.severity).toBe('critical');
    await expect(lots.create(c.id, { name: 'X', quantity: 1 }, adminId, ADMIN_NAME)).rejects.toThrow(/0 restantes de 3/);
    expect(o).toBeTruthy();
  });

  test('concorrência: pedido pago confirmado por quem tinha a campanha travada ANTES de o lote abrir é enxergado — sem capacidade fictícia', async () => {
    const c = await newCampaign({ globalLimit: 10 });
    await paidOrder(c, 4, { processed: false }); // consumo 4 → um lote de 6 caberia
    const lot = await lots.create(c.id, { name: 'L', quantity: 6 }, adminId, ADMIN_NAME);
    let signalLocked!: () => void;
    const locked = new Promise<void>((resolve) => (signalLocked = resolve));
    // simula a emissão/o webhook do PR B: trava a campanha, registra OUTRO pedido pago de 3 unidades e só então confirma
    const concurrent = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM vale_pass_campaigns WHERE id = ${c.id}::uuid FOR UPDATE`;
      signalLocked();
      await sleep(300);
      const id = `${TAG}-o${counter++}`;
      orderIds.push(id);
      await tx.valePassOrder.create({ data: { shopifyOrderId: id, status: 'CONFIRMED', financialStatus: 'paid', quantity: 3, lastSyncSource: 'teste', orderCreatedAt: new Date(), statusChangedAt: new Date() } });
      await tx.webhookEvent.create({ data: { shopifyWebhookId: `${TAG}-wh-${webhookCounter++}`, storeId, topic: 'orders/paid', orderId: id, status: 'processed', payload: { id, line_items: [{ variant_id: c.shopifyVariantId, quantity: 3 }] } } });
    }, { timeout: 10_000 });
    await locked; // a trava já está tomada; a abertura começa DEPOIS
    // sem o FOR UPDATE a abertura leria consumo 4 (saldo 6), abriria o lote de 6 e o consumo real (7) deixaria só 3 de saldo
    await expect(lots.open(c.id, lot.id, lot.updatedAt, adminId, ADMIN_NAME)).rejects.toThrow(/não cabe no saldo do limite global \(3 restantes de 10/);
    await concurrent;
    expect((await totalsOf(c.id)).consumed).toBe(7);
    expect((await prisma.valePassLot.findUniqueOrThrow({ where: { id: lot.id } })).status).toBe('PLANNED');
  });

  test('invariantes (60 cenários aleatórios, sementes fixas): consumido = vendido + pendente e nenhum lote abre acima do saldo real', async () => {
    let seed = 20261018;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const pick = <T,>(values: readonly T[]) => values[Math.floor(rnd() * values.length)];
    const limit = 40;
    for (let scenario = 0; scenario < 60; scenario++) {
      const c = await newCampaign({ globalLimit: limit });
      let expectedSold = 0;
      let expectedPending = 0;
      const orderCount = 1 + Math.floor(rnd() * 5);
      for (let k = 0; k < orderCount; k++) {
        const status = pick(['CONFIRMED', 'CONFIRMED', 'CONFIRMED', 'PENDING', 'REFUNDED', 'CANCELLED'] as const);
        const quantity = 1 + Math.floor(rnd() * 4);
        const deleted = rnd() < 0.15;
        const order = await paidOrder(c, quantity, { status, deleted, processed: rnd() < 0.7, withPayload: rnd() < 0.8 });
        const issuedCount = Math.floor(rnd() * (quantity + 2));
        let issuedUnits = 0;
        for (let i = 0; i < issuedCount; i++) {
          const voucherStatus = pick(['ACTIVE', 'ACTIVE', 'USED', 'CANCELLED'] as const);
          await voucher(c.id, new Date(), voucherStatus, order);
          issuedUnits++;
          if (voucherStatus !== 'CANCELLED') expectedSold++;
        }
        if (status === 'CONFIRMED' && !deleted) expectedPending += Math.max(0, quantity - issuedUnits);
      }
      const capacity = await lots.getCapacity(c.id);
      expect(capacity.totals, `cenário ${scenario}`).toMatchObject({ sold: expectedSold, pending: expectedPending, consumed: expectedSold + expectedPending });
      const remaining = Math.max(0, limit - expectedSold - expectedPending);
      expect(capacity.globalRemaining, `cenário ${scenario}`).toBe(remaining);

      // nenhum lote abre acima do saldo REAL; um lote exatamente do tamanho do saldo abre
      if (remaining < 1000) {
        const over = await lots.create(c.id, { name: 'acima', quantity: remaining + 1 }, adminId, ADMIN_NAME).catch((e) => e);
        expect(over, `cenário ${scenario}`).toBeInstanceOf(UnprocessableEntityException);
      }
      if (remaining > 0) {
        const fits = await lots.create(c.id, { name: 'cabe', quantity: remaining }, adminId, ADMIN_NAME);
        expect((await lots.open(c.id, fits.id, fits.updatedAt, adminId, ADMIN_NAME)).status, `cenário ${scenario}`).toBe('OPEN');
      }
      await prisma.webhookEvent.deleteMany({ where: { orderId: { in: orderIds } } });
      await prisma.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: orderIds } } });
      orderIds.length = 0;
    }
  }, 180_000);

  test('PR B: um Valle Pass com DOIS vouchers consome UMA unidade (agregados por chave de unidade, com group_id simulado)', async () => {
    // Simula a tabela do PR B com `group_id`: g1 = 2 vouchers ativos; g2 = 1 cancelado + 1 ativo; g3 = tudo cancelado; sem grupo = legado.
    const [row] = await prisma.$queryRaw<{ issued: number; sold: number; active: number; used: number; expired: number }[]>`
      SELECT ${unitAggregates(Prisma.sql`coalesce(v.group_id, v.id)`)}
      FROM (VALUES ('a','g1','ACTIVE'),('b','g1','ACTIVE'),('c','g2','CANCELLED'),('d','g2','ACTIVE'),('e','g3','CANCELLED'),('f','g3','CANCELLED'),('h',NULL,'USED'),('i',NULL,'EXPIRED')) AS v(id, group_id, status)`;
    expect(row).toEqual({ issued: 5, sold: 4, active: 2, used: 1, expired: 1 }); // 8 linhas, 5 unidades; só g3 deixa de consumir
    // sem grupo (legado), cada linha é uma unidade, exatamente como era; a chave real (`PASS_UNIT_KEY`) é exercitada na tabela de verdade nos testes de emissão
    const [legacy] = await prisma.$queryRaw<{ issued: number; sold: number }[]>`
      SELECT ${unitAggregates(Prisma.sql`v.id`)} FROM (VALUES ('a','ACTIVE'),('b','CANCELLED'),('c','USED')) AS v(id, status)`;
    expect(legacy).toMatchObject({ issued: 3, sold: 2 });
  });

  test('guarda: toda contagem de capacidade passa pela chave de unidade (nunca count(*) sobre vale_passes)', () => {
    // sem os comentários (que explicam justamente isto), só o código/SQL
    const source = readFileSync(join(__dirname, 'vale-pass-capacity.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/count\(\*\)/);
    expect(source).toContain('export const PASS_UNIT_KEY');
    expect((source.match(/\$\{PASS_UNIT_KEY\}|unitAggregates\(PASS_UNIT_KEY\)/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});

localDescribe('Valle Pass — alertas de capacidade e de pagamento sem passe', () => {
  test('limite legado ativo, limite global ausente e lote esgotado geram alertas', async () => {
    const c = await newCampaign({ quantityLimit: 10 });
    let capacity = await lots.getCapacity(c.id);
    expect(capacity.alerts.map((a) => a.code)).toEqual(expect.arrayContaining(['LEGACY_LIMIT_BLOCKS_ISSUANCE', 'GLOBAL_LIMIT_NOT_SET']));
    expect(capacity.alerts.find((a) => a.code === 'LEGACY_LIMIT_BLOCKS_ISSUANCE')?.severity).toBe('warning');

    const d = await newCampaign({ quantityLimit: 3, globalLimit: 100 });
    for (let i = 0; i < 3; i++) await voucher(d.id, new Date(Date.now() - 1000 - i));
    capacity = await lots.getCapacity(d.id);
    expect(capacity.alerts.find((a) => a.code === 'LEGACY_LIMIT_BLOCKS_ISSUANCE')).toMatchObject({ severity: 'critical' }); // restam 0: o próximo pagante ficaria sem passe

    const e = await newCampaign({ globalLimit: 100 });
    const lot = await lots.create(e.id, { name: 'Pequeno', quantity: 2 }, adminId, ADMIN_NAME);
    await lots.open(e.id, lot.id, await lotStamp(lot.id), adminId, ADMIN_NAME);
    await sleep(15);
    await voucher(e.id, new Date());
    await voucher(e.id, new Date());
    expect((await lots.getCapacity(e.id)).alerts.map((a) => a.code)).toContain('OPEN_LOT_SOLD_OUT');
  });

  test('pedido pago com MENOS passes do que o comprado aparece como alerta crítico (a falha do limite legado)', async () => {
    const c = await newCampaign({ globalLimit: 1000 });
    const orderId = `${TAG}-order-short`;
    const okId = `${TAG}-order-ok`;
    const pendingId = `${TAG}-order-awaiting`;
    createdOrders.push(orderId, okId, pendingId);
    const base = { status: 'CONFIRMED' as const, financialStatus: 'paid', lastSyncSource: 'teste', orderCreatedAt: new Date(Date.now() - 3_600_000) };
    await prisma.valePassOrder.create({ data: { ...base, shopifyOrderId: orderId, shopifyOrderName: `${TAG}#1`, quantity: 3, vouchersProcessedAt: new Date() } });
    await prisma.valePassOrder.create({ data: { ...base, shopifyOrderId: okId, shopifyOrderName: `${TAG}#2`, quantity: 1, vouchersProcessedAt: new Date() } });
    await prisma.valePassOrder.create({ data: { ...base, shopifyOrderId: pendingId, shopifyOrderName: `${TAG}#3`, quantity: 1, statusChangedAt: new Date(Date.now() - 3_600_000) } });
    await voucher(c.id, new Date(), 'ACTIVE', orderId); // 1 de 3
    await voucher(c.id, new Date(), 'ACTIVE', okId); // 1 de 1

    const capacity = await lots.getCapacity(c.id);
    const mine = capacity.paidOrdersWithoutVoucher.filter((o) => o.orderId.startsWith(TAG));
    expect(mine).toEqual([{ orderId, orderName: `${TAG}#1`, quantity: 3, issued: 1, absorbed: 0, missing: 2 }]);
    expect(capacity.alerts.find((a) => a.code === 'PAID_ORDERS_WITHOUT_VOUCHER')?.severity).toBe('critical');
    expect(capacity.alerts.find((a) => a.code === 'PAID_ORDERS_AWAITING_PROCESSING')?.severity).toBe('warning'); // o pedido sem processamento há 1 h
    // nenhuma identificação do cliente na resposta
    expect(JSON.stringify(capacity)).not.toMatch(/customer|phone|email/i);
    await prisma.valePassOrder.deleteMany({ where: { shopifyOrderId: { in: [orderId, okId, pendingId] } } });
  });
});

localDescribe('Valle Pass — permissões e isolamento da emissão', () => {
  test('escrita exige ADMIN; leitura (capacidade) só o módulo VALLE_PASS', () => {
    const proto = ValePassCampaignsController.prototype as unknown as Record<string, unknown>;
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, ValePassCampaignsController)).toBe('VALLE_PASS');
    for (const handler of ['create', 'update', 'activate', 'deactivate', 'createLot', 'updateLot', 'openLot', 'closeLot', 'cancelLot']) {
      expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto[handler] as object), handler).toBe('ADMIN');
    }
    for (const handler of ['list', 'capacity']) expect(Reflect.getMetadata(REQUIRE_ROLE_KEY, proto[handler] as object), handler).toBeUndefined();
  });

  test('a emissão de vales (webhook) NÃO lê lotes nem limite global nesta etapa', () => {
    const source = readFileSync(join(__dirname, 'vale-pass-webhook.service.ts'), 'utf8');
    for (const name of ['valePassLot', 'globalLimit', 'voucherValidFrom', 'voucherValidUntil', 'salesEndDate', 'vale-pass-capacity', 'vale-pass-lots']) {
      expect(source, name).not.toContain(name);
    }
  });

  test('migrações aditivas: as colunas originais dos passes continuam as mesmas (só 4 novas, nulas, no fim)', async () => {
    const columns = await prisma.$queryRaw<{ column_name: string }[]>`SELECT column_name FROM information_schema.columns WHERE table_name = 'vale_passes' ORDER BY ordinal_position`;
    expect(columns.map((c) => c.column_name)).toEqual([
      'id', 'code', 'campaign_id', 'amount_cents', 'status', 'purchased_at', 'expires_at', 'customer_name', 'customer_phone', 'customer_email',
      'shopify_order_id', 'shopify_order_gid', 'shopify_order_name', 'used_at', 'used_by', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'created_at', 'updated_at',
      // PR B (dois vouchers): só 4 colunas NOVAS e NULAS — todo voucher existente continua legado
      'benefit_id', 'company', 'group_id', 'valid_from',
    ]);
  });
});
