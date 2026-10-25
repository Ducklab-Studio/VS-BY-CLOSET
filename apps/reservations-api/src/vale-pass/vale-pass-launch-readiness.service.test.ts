import 'reflect-metadata';
import { NotFoundException, RequestMethod } from '@nestjs/common';
import { describe, expect, test, vi } from 'vitest';
import { ValePassLaunchReadinessController } from './vale-pass-launch-readiness.controller';
import { ValePassLaunchReadinessService } from './vale-pass-launch-readiness.service';
import { AdminAuthGuard } from '../admin/admin-auth.guard';
import { AdminRoleGuard } from '../admin/admin-role.guard';
import { REQUIRE_MODULE_KEY } from '../admin/require-module.decorator';
import type { ValePassCampaignItem } from './vale-pass-campaigns.service';

const campaign = (over: Partial<ValePassCampaignItem> = {}): ValePassCampaignItem => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Valle Pass 2027',
  amountCents: 35_000,
  validityDays: 30,
  quantityLimit: null,
  globalLimit: 1_000,
  voucherValidFrom: null,
  voucherValidUntil: null,
  salesEndDate: null,
  shopifyVariantId: '1',
  active: true,
  soldCount: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  ...over,
});
const emptyCapacity = { openLot: null, holds: [], refundReviews: [], cancellationAlerts: [], paidOrdersWithoutVoucher: [], recommendedShopifyStock: 0 };

function build(opts: { campaigns?: ValePassCampaignItem[]; benefits?: unknown[]; capacity?: Record<string, unknown>; twoVoucher?: boolean } = {}) {
  const campaigns = { list: vi.fn(async () => opts.campaigns ?? [campaign()]) };
  const benefits = { list: vi.fn(async () => opts.benefits ?? []) };
  const lots = { getCapacity: vi.fn(async () => ({ ...emptyCapacity, ...(opts.capacity ?? {}) })) };
  const flow = { flagSet: () => ({ twoVoucher: () => opts.twoVoucher ?? false, unitRefunds: () => false, autoVerify: () => false }) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new ValePassLaunchReadinessService(campaigns as any, benefits as any, lots as any, flow as any);
  return { service, campaigns, benefits, lots };
}

describe('serviço do painel de prontidão', () => {
  test('sem campanha: devolve o checklist bloqueado, sem consultar benefícios nem capacidade', async () => {
    const { service, benefits, lots } = build({ campaigns: [] });
    const result = await service.snapshot();
    expect(result.campaign).toBeNull();
    expect(result.readyToSell).toBe(false);
    expect(Number.isNaN(Date.parse(result.generatedAt))).toBe(false);
    expect(benefits.list).not.toHaveBeenCalled();
    expect(lots.getCapacity).not.toHaveBeenCalled();
  });

  test('escolhe a campanha ativa mais recente (ou a primeira, se nenhuma estiver ativa) e usa só leituras', async () => {
    const inactiveNewest = campaign({ id: '22222222-2222-4222-8222-222222222222', active: false });
    const active = campaign();
    const { service, benefits } = build({ campaigns: [inactiveNewest, active] });
    const result = await service.snapshot();
    expect(result.campaign?.id).toBe(active.id);
    expect(benefits.list).toHaveBeenCalledWith(active.id);
    const none = await build({ campaigns: [inactiveNewest] }).service.snapshot();
    expect(none.campaign?.id).toBe(inactiveNewest.id);
  });

  test('campaignId inexistente: 404 (sem vazar nada)', async () => {
    const { service } = build();
    await expect(service.snapshot('99999999-9999-4999-8999-999999999999')).rejects.toBeInstanceOf(NotFoundException);
  });

  test('lê o estado real: retenções abertas e lote aberto entram no checklist; estoque da Shopify nunca é consultado', async () => {
    const { service } = build({ capacity: { openLot: { id: 'l' }, holds: [{}, {}], refundReviews: [{}] }, twoVoucher: true });
    const k = Object.fromEntries((await service.snapshot()).items.map((i) => [i.id, i]));
    expect(k['open-holds'].status).toBe('PENDING');
    expect(k['refund-reviews'].status).toBe('PENDING');
    expect(k.lot).toBeUndefined(); // lote aberto: o item de pendência "lot" não aparece
    expect(k['flag-two-voucher'].status).toBe('APPROVED');
    expect(k['shopify-stock'].status).toBe('PENDING');
  });

  test('devolve o estoque esperado na Shopify (do painel de capacidade) e continua sem consultar a Shopify', async () => {
    const closed = await build().service.snapshot();
    expect(closed.expectedShopifyStock).toBe(0);
    const open = await build({ capacity: { openLot: { id: 'l' }, recommendedShopifyStock: 100 } }).service.snapshot();
    expect(open.expectedShopifyStock).toBe(100);
    expect(open.items.find((i) => i.id === 'shopify-stock')?.status).toBe('PENDING');
  });

  test('cada chamada lê de novo e carimba a própria hora (nada é guardado em cache entre leituras)', async () => {
    const { service, lots } = build();
    const first = await service.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await service.snapshot();
    expect(lots.getCapacity).toHaveBeenCalledTimes(2);
    expect(Date.parse(second.generatedAt)).toBeGreaterThan(Date.parse(first.generatedAt));
  });

  test('propaga erro de leitura (o controller responde erro; a tela mostra estado de erro) sem mascarar como sucesso', async () => {
    const { service, lots } = build();
    lots.getCapacity.mockRejectedValueOnce(new Error('banco indisponível'));
    await expect(service.snapshot()).rejects.toThrow('banco indisponível');
  });
});

describe('controller do painel de prontidão', () => {
  const proto = ValePassLaunchReadinessController.prototype as unknown as Record<string, object>;
  const handlers = Object.getOwnPropertyNames(ValePassLaunchReadinessController.prototype).filter((n) => n !== 'constructor');

  test('expõe apenas leitura: um único handler, método GET (nenhuma rota para abrir vendas, estoque ou chaves)', () => {
    expect(handlers).toEqual(['snapshot']);
    expect(Reflect.getMetadata('method', proto.snapshot)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata('path', ValePassLaunchReadinessController)).toBe('admin/vale-pass/launch-readiness');
  });

  test('exige autenticação administrativa, sessão e o módulo VALLE_PASS', () => {
    const guards = Reflect.getMetadata('__guards__', ValePassLaunchReadinessController) as unknown[];
    expect(guards).toEqual([AdminAuthGuard, AdminRoleGuard]);
    expect(Reflect.getMetadata(REQUIRE_MODULE_KEY, ValePassLaunchReadinessController)).toBe('VALLE_PASS');
  });
});
