import { describe, expect, test, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ValePassLedgerController } from './ledger/ledger.controller';
import { decideCompanyAccess } from './ledger/operator-scope';
import { buildLaunchChecklist, type ChecklistInput } from './vale-pass-launch-checklist';
import { IDENTITY_CHECK_REQUIRED, identityCheckRequired, isIdentityConfirmed } from './vale-pass-identity-confirmation';
import { forListRole, forRole } from './vale-pass-voucher-privacy';
import { ValePassVouchersController } from './vale-pass-vouchers.controller';

// Hardening dos vouchers (auditoria de segurança): conferência de identidade obrigatória, código mascarado na lista e política de STAFF.
// Testes sem banco: controladores com serviços simulados. Os testes com banco estão em redemption.integration.test.ts.

const dto = (over: Record<string, unknown> = {}) => ({ company: 'VALLE_SHOWROOM', amountCents: 1_000, reference: 'Nota 1', operationId: 'op-12345678', expectedBalanceCents: 50_000, confirmAmountCents: 1_000, ...over });
const reqOf = (role: 'SUPER_ADMIN' | 'ADMIN' | 'STAFF') => ({ adminUser: { id: 'u1', name: 'Operador', role } });

function ledgerController() {
  const redemption = { confirmRedeem: vi.fn().mockResolvedValue({ replayed: false }) };
  return { redemption, controller: new ValePassLedgerController(redemption as never, {} as never, {} as never) };
}

describe('conferência de identidade obrigatória no resgate (intransferibilidade)', () => {
  test('só `true` literal conta como conferência', () => {
    expect(isIdentityConfirmed(true)).toBe(true);
    for (const v of [undefined, null, false, 'true', 'sim', 1, 0, {}, []]) expect(isIdentityConfirmed(v), String(v)).toBe(false);
  });

  test('o erro tem código estável, status 400 e não menciona documento guardado', () => {
    const err = identityCheckRequired();
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getStatus()).toBe(400);
    expect((err.getResponse() as { code: string }).code).toBe(IDENTITY_CHECK_REQUIRED);
    expect((err.getResponse() as { message: string }).message).toMatch(/não guarda documento nem foto/);
  });

  test('o controlador HTTP SEMPRE exige a conferência do serviço (requireIdentity) e entrega o corpo sem alterá-lo; a recusa em si é testada com banco', async () => {
    const { redemption, controller } = ledgerController();
    const body = dto({ identityChecked: true });
    await controller.redeem('VALLE-AAAA-BBBB', body as never, reqOf('STAFF') as never);
    await controller.redeem('VALLE-AAAA-BBBB', body as never, reqOf('STAFF') as never); // reenvio da mesma operação: a idempotência é do serviço
    await controller.redeem('VALLE-AAAA-BBBB', dto() as never, reqOf('ADMIN') as never); // sem a conferência: o serviço é quem recusa
    expect(redemption.confirmRedeem).toHaveBeenCalledTimes(3);
    for (const call of redemption.confirmRedeem.mock.calls) expect(call[3]).toEqual({ requireIdentity: true });
    expect(redemption.confirmRedeem.mock.calls[0][1]).toMatchObject({ operationId: 'op-12345678', identityChecked: true });
    expect(redemption.confirmRedeem.mock.calls[0][2]).toMatchObject({ id: 'u1', role: 'STAFF' }); // o operador que confirmou vem da sessão, não do corpo
  });

  test('"marcar como utilizado" por inteiro também exige a conferência no caminho HTTP e informa o serviço', async () => {
    const vouchers = { markUsed: vi.fn().mockResolvedValue({ code: 'VALLE-AAAA-BBBB', customerName: null, customerPhone: null, customerEmail: null }) };
    const controller = new ValePassVouchersController(vouchers as never);
    await controller.markUsed('VALLE-AAAA-BBBB', reqOf('ADMIN') as never);
    expect(vouchers.markUsed.mock.calls[0][3]).toEqual({ role: 'ADMIN', requireIdentity: true, identityChecked: false });
    await controller.markUsed('VALLE-AAAA-BBBB', reqOf('ADMIN') as never, 'sim');
    expect(vouchers.markUsed.mock.calls[1][3]).toMatchObject({ identityChecked: false });
    await controller.markUsed('VALLE-AAAA-BBBB', reqOf('ADMIN') as never, true);
    expect(vouchers.markUsed.mock.calls[2][3]).toEqual({ role: 'ADMIN', requireIdentity: true, identityChecked: true });
  });
});

const item = { code: 'VALLE-AB12-CD34', customerName: 'Maria da Silva Souza', customerPhone: '+55 11 91234-5678', customerEmail: 'maria.souza@exemplo.invalid' };

describe('código mascarado na lista para quem não é administrador', () => {
  test('STAFF não recebe o código completo nem dados pessoais; administradores recebem tudo', () => {
    const staff = forListRole(item, 'STAFF');
    expect(staff.code).toBe('VALLE-AB12-****');
    expect(JSON.stringify(staff)).not.toMatch(/CD34|maria\.souza|91234|Silva Souza/);
    expect(forListRole(item, 'ADMIN').code).toBe(item.code);
    expect(forListRole(item, 'SUPER_ADMIN').code).toBe(item.code);
  });

  test('a consulta por código digitado (não a lista) continua mostrando o código que o operador informou', () => {
    expect(forRole(item, 'STAFF').code).toBe(item.code);
  });

  test('a lista do controlador passa o modo restrito ao serviço e devolve códigos mascarados ao STAFF', async () => {
    const vouchers = { list: vi.fn().mockResolvedValue([{ ...item }]) };
    const controller = new ValePassVouchersController(vouchers as never);
    const asStaff = await controller.list(reqOf('STAFF') as never, undefined, undefined, 'VALLE');
    expect(vouchers.list.mock.calls[0][1]).toEqual({ restricted: true });
    expect(asStaff[0].code).toBe('VALLE-AB12-****');
    const asAdmin = await controller.list(reqOf('ADMIN') as never, undefined, undefined, 'VALLE');
    expect(vouchers.list.mock.calls[1][1]).toEqual({ restricted: false });
    expect(asAdmin[0].code).toBe(item.code);
  });
});

describe('política técnica de STAFF e empresa incorreta', () => {
  test('STAFF com vínculo resgata só na empresa vinculada; sem vínculo não opera; ADMIN sem vínculo não opera; SUPER_ADMIN opera as duas', () => {
    expect(decideCompanyAccess('STAFF', ['VALLE_SHOWROOM'], 'VALLE_SHOWROOM')).toMatchObject({ allowed: true, basis: 'SCOPE' });
    expect(decideCompanyAccess('STAFF', ['VALLE_SHOWROOM'], 'VS_BY_CLOSET')).toMatchObject({ allowed: false, code: 'COMPANY_NOT_AUTHORIZED' });
    expect(decideCompanyAccess('STAFF', [], 'VALLE_SHOWROOM')).toMatchObject({ allowed: false, code: 'NO_COMPANY_AUTHORIZED' });
    expect(decideCompanyAccess('ADMIN', [], 'VS_BY_CLOSET')).toMatchObject({ allowed: false, code: 'NO_COMPANY_AUTHORIZED' });
    expect(decideCompanyAccess('SUPER_ADMIN', [], 'VS_BY_CLOSET')).toMatchObject({ allowed: true, basis: 'OWNER' });
  });
});

describe('checklist: política de STAFF descrita corretamente e sem aprovação comercial', () => {
  const input: ChecklistInput = {
    campaign: { amountCents: 35_000, active: true, quantityLimit: null, globalLimit: 1_000, voucherValidFrom: '2027-04-01', voucherValidUntil: '2027-10-15', salesEndDate: '2027-05-31' },
    benefits: [],
    hasOpenLot: false,
    shopifyStock: null,
    capacity: { openHolds: 0, refundReviews: 0, cancellationAlerts: 0, paidOrdersWithoutVoucher: 0 },
    flags: { twoVoucher: true, autoVerify: false, emailMode: 'dry-run', emailDomainVerified: true, alertsMode: 'off' },
  };

  test('diz que STAFF com vínculo explícito resgata só nessa empresa, que isso não é aprovação do Anderson e segue PENDENTE', () => {
    const staff = buildLaunchChecklist({ id: 'c1', name: 'Valle Pass 2027' }, input).items.find((i) => i.id === 'staff-policy')!;
    expect(staff.status).toBe('PENDING');
    expect(staff.owner).toBe('ANDERSON');
    expect(staff.message).toMatch(/vínculo explícito/);
    expect(staff.message).toMatch(/NÃO é aprovação comercial/);
    expect(staff.message).not.toMatch(/só ADMIN e SUPER_ADMIN resgatam/);
    expect(staff.nextStep).toMatch(/vínculo explícito/);
  });
});
