import { describe, expect, test } from 'vitest';
import { buildLaunchChecklist, emptyChecklist, type ChecklistInput, type ChecklistItem } from './vale-pass-launch-checklist';
import type { ReadinessBenefit } from './vale-pass-launch-readiness';

const voucher = (company: 'VALLE_SHOWROOM' | 'VS_BY_CLOSET', amountCents: number): ReadinessBenefit => ({ kind: 'VOUCHER', company, amountCents, discountPercent: null, terms: null, active: true });
const discount: ReadinessBenefit = { kind: 'DISCOUNT', company: null, amountCents: null, discountPercent: 10, terms: 'Condições aprovadas', active: true };

const configured: ChecklistInput = {
  campaign: { amountCents: 35_000, active: true, quantityLimit: null, globalLimit: 1_000, voucherValidFrom: '2027-04-01', voucherValidUntil: '2027-10-15', salesEndDate: '2027-05-31' },
  benefits: [voucher('VALLE_SHOWROOM', 50_000), voucher('VS_BY_CLOSET', 5_000), discount],
  hasOpenLot: true,
  shopifyStock: null,
  capacity: { openHolds: 0, refundReviews: 0, cancellationAlerts: 0, paidOrdersWithoutVoucher: 0 },
  flags: { twoVoucher: true, autoVerify: true, emailMode: 'live', emailDomainVerified: true, alertsMode: 'log' },
};
const ref = { id: 'c1', name: 'Valle Pass 2027' };
const byId = (items: readonly ChecklistItem[]) => Object.fromEntries(items.map((i) => [i.id, i]));
const UNPROVABLE = ['terms-url', 'terms-approved', 'refund-policy', 'legal-review', 'validity-confirmed', 'retention-owner', 'staff-policy', 'real-purchase-test'];

describe('checklist "Pronta para vender?"', () => {
  test('estado de produção hoje (chaves desligadas, sem validade nem lote): não está pronto e nada é aprovado sem evidência', () => {
    const today: ChecklistInput = {
      ...configured,
      campaign: { ...configured.campaign, voucherValidFrom: null, voucherValidUntil: null, salesEndDate: null },
      hasOpenLot: false,
      flags: { twoVoucher: false, autoVerify: false, emailMode: 'off', emailDomainVerified: true, alertsMode: 'off' },
    };
    const list = buildLaunchChecklist(ref, today);
    const k = byId(list.items);
    expect(list.readyToSell).toBe(false);
    expect(k['global-limit'].status).toBe('APPROVED');
    expect(k.vouchers.status).toBe('APPROVED');
    expect(k['valid-until'].status).toBe('BLOCKED'); // fim da validade ausente = divergência da configuração
    expect(k['valid-from'].status).toBe('PENDING');
    expect(k.lot.status).toBe('PENDING');
    expect(k['flag-two-voucher'].status).toBe('PENDING');
    expect(k['email-mode'].status).toBe('PENDING');
    expect(k['shopify-stock'].status).toBe('PENDING');
    expect(k['shopify-stock'].message).toContain('Admin da Shopify');
  });

  test('NUNCA aprova o que o sistema não comprova, nem com tudo configurado: decisões do Anderson, parecer jurídico, termos e compra de teste real', () => {
    const list = buildLaunchChecklist(ref, configured);
    const k = byId(list.items);
    for (const id of [...UNPROVABLE, 'extension', 'sales-start', 'shopify-stock', 'sales-end']) expect(k[id].status, id).toBe('PENDING');
    expect(list.readyToSell).toBe(false);
    // A confirmação do Anderson (27/10/2026) é citada, mas o sistema não a prova: segue pendente.
    expect(k['validity-confirmed'].message).toMatch(/01[/]04[/]2027.*15[/]10[/]2027/);
  });

  test('só fica "pronto" se TODOS os itens estiverem aprovados (hoje impossível pelos itens não comprováveis)', () => {
    const list = buildLaunchChecklist(ref, configured);
    expect(list.readyToSell).toBe(list.summary.approved === list.summary.total);
    expect(list.summary.approved).toBeLessThan(list.summary.total);
  });

  test('separa técnico de Anderson e os totais fecham', () => {
    const { summary, items } = buildLaunchChecklist(ref, configured);
    expect(summary.total).toBe(items.length);
    expect(summary.approved + summary.pending + summary.blocked).toBe(summary.total);
    const t = summary.technical;
    const a = summary.anderson;
    expect(t.approved + t.pending + t.blocked + a.approved + a.pending + a.blocked).toBe(summary.total);
    const k = byId(buildLaunchChecklist(ref, { ...configured, hasOpenLot: false }).items); // sem lote aberto o item "lot" aparece
    for (const id of ['terms-approved', 'refund-policy', 'legal-review', 'valid-from', 'lot', 'retention-owner', 'staff-policy']) expect(k[id]?.owner, id).toBe('ANDERSON');
    for (const id of ['flag-two-voucher', 'real-purchase-test', 'global-limit', 'vouchers', 'terms-url']) expect(k[id]?.owner, id).toBe('TECNICO');
  });

  test('capacidade: retenções, reembolsos em revisão, alertas e pedidos sem voucher aprovam com zero e ficam pendentes com ocorrências', () => {
    const ids = ['open-holds', 'refund-reviews', 'cancellation-alerts', 'paid-without-voucher'];
    const clean = byId(buildLaunchChecklist(ref, configured).items);
    for (const id of ids) expect(clean[id].status, id).toBe('APPROVED');
    const dirty = byId(buildLaunchChecklist(ref, { ...configured, capacity: { openHolds: 2, refundReviews: 1, cancellationAlerts: 3, paidOrdersWithoutVoucher: 1 } }).items);
    for (const id of ids) expect(dirty[id].status, id).toBe('PENDING');
    expect(dirty['open-holds'].message).toContain('2');
  });

  test('e-mail: live sem domínio verificado BLOQUEIA; dry-run e off ficam pendentes; live com domínio é aprovado', () => {
    const mode = (emailMode: 'off' | 'dry-run' | 'live', emailDomainVerified: boolean) =>
      byId(buildLaunchChecklist(ref, { ...configured, flags: { ...configured.flags, emailMode, emailDomainVerified } }).items)['email-mode'].status;
    expect(mode('live', false)).toBe('BLOCKED');
    expect(mode('live', true)).toBe('APPROVED');
    expect(mode('dry-run', true)).toBe('PENDING');
    expect(mode('off', true)).toBe('PENDING');
  });

  test('verificação automática ligada sem a chave dos dois vouchers não conta como aprovada', () => {
    const k = byId(buildLaunchChecklist(ref, { ...configured, flags: { ...configured.flags, twoVoucher: false, autoVerify: true } }).items);
    expect(k['flag-auto-verify'].status).toBe('PENDING');
    expect(k['flag-auto-verify'].message).toContain('sem efeito');
  });

  test('dados ausentes: sem benefícios, sem limite global e campanha inativa viram bloqueio/pendência, nunca erro', () => {
    const list = buildLaunchChecklist(ref, { ...configured, benefits: [], campaign: { ...configured.campaign, globalLimit: null, active: false } });
    const k = byId(list.items);
    expect(k.vouchers.status).toBe('BLOCKED');
    expect(k['global-limit'].status).toBe('BLOCKED');
    expect(k.active.status).toBe('PENDING');
    expect(list.readyToSell).toBe(false);
  });

  test('sem campanha cadastrada: bloqueado, sem campanha na resposta e ainda com os itens não comprováveis', () => {
    const list = emptyChecklist();
    const k = byId(list.items);
    expect(list.campaign).toBeNull();
    expect(list.readyToSell).toBe(false);
    expect(k.campaign.status).toBe('BLOCKED');
    for (const id of UNPROVABLE) expect(k[id].status, id).toBe('PENDING');
    expect(list.summary.total).toBe(list.items.length);
  });

  test('a resposta não carrega segredos: só ids, rótulos, mensagens e contagens', () => {
    const list = buildLaunchChecklist(ref, configured);
    expect(JSON.stringify(list)).not.toMatch(/postgres(ql)?:\/\/|re_[A-Za-z0-9]{10,}|shpat_|whsec_|Bearer /i);
    expect(Object.keys(list).sort()).toEqual(['campaign', 'expectedShopifyStock', 'generatedAt', 'items', 'readyToSell', 'summary']);
  });

  test('natureza: técnico, comercial (Anderson) e jurídico; aprovado não tem próximo passo e todo item aberto tem orientação', () => {
    const list = buildLaunchChecklist(ref, { ...configured, hasOpenLot: false, flags: { ...configured.flags, twoVoucher: false } });
    const k = byId(list.items);
    for (const id of ['terms-approved', 'refund-policy', 'legal-review']) expect(k[id].nature, id).toBe('JURIDICO');
    for (const id of ['valid-from', 'lot', 'retention-owner', 'staff-policy', 'validity-confirmed', 'sales-end']) expect(k[id]?.nature, id).toBe('COMERCIAL');
    for (const id of ['flag-two-voucher', 'real-purchase-test', 'terms-url', 'shopify-stock', 'global-limit']) expect(k[id].nature, id).toBe('TECNICO');
    for (const entry of list.items) {
      if (entry.status === 'APPROVED') expect(entry.nextStep, entry.id).toBeNull();
      else expect(entry.nextStep && entry.nextStep.length > 10, `${entry.id} sem próximo passo`).toBe(true);
    }
    // Item aberto e técnico nunca é "comercial": quem lê sabe o que dá para fazer sem o Anderson.
    expect(list.items.filter((i) => i.owner === 'TECNICO').every((i) => i.nature === 'TECNICO')).toBe(true);
  });

  test('classificação: o fim da validade depende da data confirmada pelo Anderson (não é pendência técnica) e o encerramento das vendas registrado não aprova sozinho', () => {
    const missing = byId(buildLaunchChecklist(ref, { ...configured, campaign: { ...configured.campaign, voucherValidFrom: null, voucherValidUntil: null } }).items);
    expect(missing['valid-until']).toMatchObject({ status: 'BLOCKED', owner: 'ANDERSON', nature: 'COMERCIAL' });
    const registered = byId(buildLaunchChecklist(ref, configured).items); // salesEndDate = 31/05/2027 (sugestão)
    expect(registered['sales-end']).toMatchObject({ status: 'PENDING', owner: 'ANDERSON' });
    expect(registered['sales-end'].message).toContain('não a confirmou');
  });

  test('não há falso positivo: com a configuração completa só itens com evidência medida ficam aprovados', () => {
    const approved = buildLaunchChecklist(ref, configured).items.filter((i) => i.status === 'APPROVED').map((i) => i.id).sort();
    expect(approved).toEqual(
      ['alerts-mode', 'cancellation-alerts', 'discount', 'email-mode', 'flag-auto-verify', 'flag-two-voucher', 'global-limit', 'legacy-limit', 'open-holds', 'paid-without-voucher', 'price', 'refund-reviews', 'valid-from', 'valid-until', 'vouchers'].sort(),
    );
  });

  test('informa o estoque esperado na Shopify (saldo do lote aberto; 0 sem lote) sem consultar a Shopify; sem campanha é nulo', () => {
    expect(buildLaunchChecklist(ref, { ...configured, expectedShopifyStock: 0 }).expectedShopifyStock).toBe(0);
    expect(buildLaunchChecklist(ref, { ...configured, expectedShopifyStock: 100 }).expectedShopifyStock).toBe(100);
    expect(buildLaunchChecklist(ref, configured).expectedShopifyStock).toBeNull(); // quem chama não informou
    expect(emptyChecklist().expectedShopifyStock).toBeNull();
    // A API continua sem aprovar o estoque por conta própria: quem compara com a Shopify é o site.
    expect(byId(buildLaunchChecklist(ref, { ...configured, expectedShopifyStock: 0 }).items)['shopify-stock'].status).toBe('PENDING');
  });

  test('chaves desligadas são "de propósito" (não erro técnico) e continuam pendentes, nunca bloqueadas', () => {
    const off = byId(buildLaunchChecklist(ref, { ...configured, flags: { twoVoucher: false, autoVerify: false, emailMode: 'off', emailDomainVerified: true, alertsMode: 'off' } }).items);
    for (const id of ['flag-two-voucher', 'flag-auto-verify', 'email-mode']) {
      expect(off[id].status, id).toBe('PENDING');
      expect(off[id].message, id).toContain('de propósito até a ativação autorizada');
      expect(off[id].message, id).toContain('Não é erro técnico');
    }
    expect(off['alerts-mode'].message).toContain('opcional');
  });

  test('registra o instante da leitura (o dado vale para aquele momento), também sem campanha', () => {
    const at = new Date('2026-10-24T23:41:00.000Z');
    expect(buildLaunchChecklist(ref, configured, at).generatedAt).toBe('2026-10-24T23:41:00.000Z');
    expect(emptyChecklist(at).generatedAt).toBe('2026-10-24T23:41:00.000Z');
    expect(Number.isNaN(Date.parse(buildLaunchChecklist(ref, configured).generatedAt))).toBe(false);
  });
});
