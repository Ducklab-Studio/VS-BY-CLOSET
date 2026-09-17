import { describe, expect, test } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateValePassCampaignDto } from './create-vale-pass-campaign.dto';
import { CancelValePassDto } from './cancel-vale-pass.dto';

/** Mesmo achado real de CreateEmployeeDto: `adminUserId` (lido pelo
 *  AdminRoleGuard do body) precisa estar declarado no DTO, senão o
 *  ValidationPipe global (`forbidNonWhitelisted: true`) recusa a
 *  requisição inteira. */
describe('CreateValePassCampaignDto / CancelValePassDto — adminUserId aceito pelo ValidationPipe', () => {
  test('1) CreateValePassCampaignDto com adminUserId válido não gera erro de whitelist', async () => {
    const dto = plainToInstance(CreateValePassCampaignDto, {
      adminUserId: '00000000-0000-0000-0000-000000000000',
      name: 'Campanha Teste',
      amountCents: 10000,
      validityDays: 90,
      shopifyVariantId: '123456789',
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });

  test('2) CreateValePassCampaignDto ainda recusa campo desconhecido', async () => {
    const dto = plainToInstance(CreateValePassCampaignDto, {
      name: 'Campanha Teste',
      amountCents: 10000,
      validityDays: 90,
      shopifyVariantId: '123456789',
      hacker: 'campo nunca declarado',
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.some((e) => e.property === 'hacker')).toBe(true);
  });

  test('3) CancelValePassDto com adminUserId válido não gera erro de whitelist', async () => {
    const dto = plainToInstance(CancelValePassDto, {
      adminUserId: '00000000-0000-0000-0000-000000000000',
      reason: 'motivo de teste',
    });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors).toHaveLength(0);
  });
});
