import { describe, expect, test } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { UpdateValePassCampaignDto } from './update-vale-pass-campaign.dto';
import { CreateValePassLotDto, UpdateValePassLotDto, ValePassLotActionDto } from './vale-pass-lot.dto';

// Mesmas opções do ValidationPipe global (main.ts): campo não declarado derruba a requisição inteira.
const check = async <T extends object>(cls: new () => T, body: Record<string, unknown>) =>
  validate(plainToInstance(cls, body), { whitelist: true, forbidNonWhitelisted: true });
const STAMP = '2026-10-17T12:00:00.123Z';

describe('UpdateValePassCampaignDto', () => {
  test('aceita o corpo do painel (adminUserId incluso) e null para limpar limites e datas', async () => {
    expect(await check(UpdateValePassCampaignDto, { adminUserId: '00000000-0000-0000-0000-000000000000', expectedUpdatedAt: STAMP, name: 'Valle Pass 2027', amountCents: 35000, validityDays: 365, quantityLimit: null, globalLimit: 1000, voucherValidFrom: '2027-01-01', voucherValidUntil: '2027-12-31', salesEndDate: null })).toHaveLength(0);
    expect(await check(UpdateValePassCampaignDto, { expectedUpdatedAt: STAMP })).toHaveLength(0);
  });

  test('exige o carimbo de versão e recusa campo desconhecido', async () => {
    expect(await check(UpdateValePassCampaignDto, { name: 'x' })).not.toHaveLength(0);
    expect(await check(UpdateValePassCampaignDto, { expectedUpdatedAt: 'ontem' })).not.toHaveLength(0);
    expect(await check(UpdateValePassCampaignDto, { expectedUpdatedAt: STAMP, shopifyVariantId: '1' })).not.toHaveLength(0); // a variante nunca é editável
    expect(await check(UpdateValePassCampaignDto, { expectedUpdatedAt: STAMP, active: false })).not.toHaveLength(0); // ativar/encerrar tem rota própria
  });

  test('formato dos números e das datas', async () => {
    for (const bad of [{ amountCents: 0 }, { amountCents: 1.5 }, { validityDays: 3651 }, { quantityLimit: 0 }, { globalLimit: -1 }, { globalLimit: 1_000_001 }, { voucherValidFrom: '01/01/2027' }, { salesEndDate: '2027-5-30' }, { name: '' }]) {
      expect(await check(UpdateValePassCampaignDto, { expectedUpdatedAt: STAMP, ...bad }), JSON.stringify(bad)).not.toHaveLength(0);
    }
  });
});

describe('DTOs de lote', () => {
  test('criar: nome e quantidade', async () => {
    expect(await check(CreateValePassLotDto, { name: 'Lote 1', quantity: 100 })).toHaveLength(0);
    for (const bad of [{ name: '', quantity: 100 }, { name: 'a'.repeat(81), quantity: 100 }, { name: 'Lote', quantity: 0 }, { name: 'Lote', quantity: 100_001 }, { name: 'Lote', quantity: 1.5 }, { name: 'Lote' }]) {
      expect(await check(CreateValePassLotDto, bad), JSON.stringify(bad)).not.toHaveLength(0);
    }
  });

  test('editar e agir (abrir/encerrar/cancelar) exigem o carimbo de versão', async () => {
    expect(await check(UpdateValePassLotDto, { expectedUpdatedAt: STAMP, quantity: 200 })).toHaveLength(0);
    expect(await check(UpdateValePassLotDto, { quantity: 200 })).not.toHaveLength(0);
    expect(await check(ValePassLotActionDto, { expectedUpdatedAt: STAMP })).toHaveLength(0);
    expect(await check(ValePassLotActionDto, {})).not.toHaveLength(0);
    expect(await check(ValePassLotActionDto, { expectedUpdatedAt: STAMP, status: 'OPEN' })).not.toHaveLength(0); // o estado nunca vem do cliente
  });
});
