/**
 * Prontidão de lançamento da campanha oficial do Valle Pass 2027 (puro, sem banco e sem Shopify). Compara a campanha como está com o que o
 * Anderson JÁ CONFIRMOU e separa o que falta em dois grupos: DIVERGÊNCIA (configuração que pode ser corrigida) e PENDÊNCIA (decisão
 * comercial que ninguém pode inventar). Só LEITURA: nenhuma função aqui altera campanha, estoque ou pedido.
 */

/** Regras confirmadas pelo Anderson (preço, benefícios, meta, validade). Nada aqui é suposição. */
export const OFFICIAL_SPEC = {
  amountCents: 35_000,
  globalLimit: 1_000,
  /** Validade dos vouchers, confirmada por escrito pelo Anderson (WhatsApp, 27/10/2026): 01/04/2027 a 15/10/2027, inclusive. */
  voucherValidFrom: '2027-04-01',
  voucherValidUntil: '2027-10-15',
  vouchers: [
    { company: 'VALLE_SHOWROOM', amountCents: 50_000 },
    { company: 'VS_BY_CLOSET', amountCents: 5_000 },
  ],
  discountPercent: 10,
  /** Desconto de 10% (Anderson, 26/10/2026): passeios e transfers da Valle Experience, sobre o valor final do orçamento, aplicado MANUALMENTE pela equipe. Nada além disto está definido. */
  discountScope: 'passeios e transfers da Valle Experience',
  discountBase: 'valor final do orçamento',
  discountApplication: 'manual',
  /** Cada lote tem exatamente 100 unidades (10 lotes = 1.000 passes). */
  lotUnits: 100,
  /** Início das vendas previsto (01/11/2026). O sistema NÃO tem data de início de vendas: a venda é controlada pelo estoque da Shopify. */
  salesStart: '2026-11-01',
  /** Encerramento confirmado pelo Anderson (26/10/2026): 31/05/2027 OU ao esgotar as 1.000 unidades, o que vier primeiro. O sistema só registra a data; o esgotamento é o estoque 0 na Shopify. */
  salesEndLastDay: '2027-05-31',
} as const;

export interface ReadinessCampaign {
  readonly amountCents: number;
  readonly active: boolean;
  readonly quantityLimit: number | null;
  readonly globalLimit: number | null;
  /** `YYYY-MM-DD` ou nulo. */
  readonly voucherValidFrom: string | null;
  readonly voucherValidUntil: string | null;
  /** Encerramento das vendas (informativo; nenhum encerramento automático é feito). */
  readonly salesEndDate?: string | null;
}

export interface ReadinessBenefit {
  readonly kind: 'VOUCHER' | 'DISCOUNT';
  readonly company: 'VALLE_SHOWROOM' | 'VS_BY_CLOSET' | null;
  readonly amountCents: number | null;
  readonly discountPercent: number | null;
  readonly terms: string | null;
  readonly active: boolean;
}

export interface ReadinessInput {
  readonly campaign: ReadinessCampaign;
  readonly benefits: readonly ReadinessBenefit[];
  /** Quantas unidades a Shopify oferece hoje (`quantityAvailable`); nulo = não consultado. */
  readonly shopifyStock: number | null;
  /** Há lote comercial aberto (o lote controla o estoque recomendado). */
  readonly hasOpenLot: boolean;
}

export type ReadinessKind = 'OK' | 'DIVERGENCE' | 'PENDING';
export interface ReadinessItem {
  readonly id: string;
  readonly kind: ReadinessKind;
  readonly message: string;
}

const item = (id: string, kind: ReadinessKind, message: string): ReadinessItem => ({ id, kind, message });

export function evaluateLaunchReadiness(input: ReadinessInput): ReadinessItem[] {
  const { campaign, benefits } = input;
  const out: ReadinessItem[] = [];

  out.push(
    campaign.amountCents === OFFICIAL_SPEC.amountCents
      ? item('price', 'OK', 'preço R$ 350')
      : item('price', 'DIVERGENCE', `preço da campanha ${campaign.amountCents} centavos; confirmado: ${OFFICIAL_SPEC.amountCents}`),
  );
  out.push(
    campaign.globalLimit === OFFICIAL_SPEC.globalLimit
      ? item('global-limit', 'OK', 'limite global de 1.000 unidades')
      : item('global-limit', 'DIVERGENCE', `limite global ${campaign.globalLimit ?? 'sem teto'}; meta: ${OFFICIAL_SPEC.globalLimit}`),
  );
  out.push(
    campaign.quantityLimit === null
      ? item('legacy-limit', 'OK', 'sem limite legado')
      : item('legacy-limit', 'DIVERGENCE', `limite legado ${campaign.quantityLimit} ainda preenchido (não bloqueia o modelo de benefícios, mas confunde o painel; limpar)`),
  );

  const vouchers = benefits.filter((b) => b.active && b.kind === 'VOUCHER');
  const independent =
    vouchers.length === OFFICIAL_SPEC.vouchers.length &&
    OFFICIAL_SPEC.vouchers.every((e) => vouchers.some((b) => b.company === e.company && b.amountCents === e.amountCents)) &&
    new Set(vouchers.map((b) => b.company)).size === vouchers.length;
  out.push(
    independent
      ? item('vouchers', 'OK', 'dois vouchers independentes (R$ 500 Valle Showroom + R$ 50 VS BY CLOSET)')
      : item('vouchers', 'DIVERGENCE', 'benefícios de voucher ativos diferentes de R$ 500 Valle Showroom + R$ 50 VS BY CLOSET (um por empresa)'),
  );

  const discount = benefits.find((b) => b.active && b.kind === 'DISCOUNT' && b.discountPercent === OFFICIAL_SPEC.discountPercent);
  out.push(
    discount
      ? item('discount', 'OK', '10% em passeios/transfers cadastrado (descritivo)')
      : item('discount', 'DIVERGENCE', 'benefício descritivo de 10% em passeios/transfers (Valle Experience) não cadastrado'),
  );
  if (discount && !discount.terms?.trim()) out.push(item('discount-terms', 'PENDING', 'texto das condições do desconto de 10% sem aprovação do Anderson. Confirmado: passeios e transfers da Valle Experience, 10% sobre o valor final do orçamento, aplicado manualmente pela equipe. Indefinido (não presumir): frequência de uso, número de pessoas, elegibilidade adicional e efeito de cancelamento/reembolso'));

  out.push(
    campaign.voucherValidUntil === OFFICIAL_SPEC.voucherValidUntil
      ? item('valid-until', 'OK', 'validade até 15/10/2027')
      : item('valid-until', 'DIVERGENCE', `fim da validade ${campaign.voucherValidUntil ?? 'não configurado'}; informado: ${OFFICIAL_SPEC.voucherValidUntil}`),
  );
  out.push(
    campaign.voucherValidFrom === OFFICIAL_SPEC.voucherValidFrom
      ? item('valid-from', 'OK', 'validade começa em 01/04/2027')
      : campaign.voucherValidFrom
        ? item('valid-from', 'DIVERGENCE', `início da validade ${campaign.voucherValidFrom}; confirmado: ${OFFICIAL_SPEC.voucherValidFrom}`)
        : item('valid-from', 'PENDING', 'início da validade (01/04/2027) ainda não configurado na campanha (sem ele e sem o fim, a emissão fica retida, por segurança)'),
  );
  out.push(item('extension', 'PENDING', 'prorrogação da validade: vale para todos os vouchers, mas a elegibilidade de expirados e cancelados ainda precisa de confirmação (a estrutura existe; nenhuma prorrogação foi definida)'));

  // Janela de vendas: o início não é campo do sistema (a Shopify controla pelo estoque); o encerramento é só informativo.
  out.push(item('sales-start', 'PENDING', `início das vendas previsto em 01/11/2026: o sistema não tem data de início; a venda abre quando o estoque da Shopify for ajustado ao saldo do lote 1 (hoje deve estar em 0)`));
  const salesEnd = campaign.salesEndDate ?? null;
  if (salesEnd === null) out.push(item('sales-end', 'PENDING', 'encerramento das vendas não registrado na campanha: o Anderson confirmou 31/05/2027 ou o esgotamento das 1.000 unidades, o que vier primeiro; falta registrar a data (nenhum encerramento automático existe)'));
  else if (salesEnd === OFFICIAL_SPEC.salesEndLastDay) out.push(item('sales-end', 'OK', 'encerramento informativo registrado em 31/05/2027, como confirmado pelo Anderson (ou ao esgotar as 1.000 unidades, o que vier primeiro; nada é encerrado automaticamente)'));
  else out.push(item('sales-end', 'DIVERGENCE', `encerramento registrado em ${salesEnd}; previsto: ${OFFICIAL_SPEC.salesEndLastDay}`));

  if (!input.hasOpenLot) out.push(item('lot', 'PENDING', 'nenhum lote comercial aberto (quantidades e datas de lote dependem do Anderson); sem lote o estoque recomendado é 0'));
  if (input.shopifyStock === null) out.push(item('shopify-stock', 'PENDING', 'estoque da Shopify não consultado'));
  else if (input.shopifyStock > OFFICIAL_SPEC.globalLimit) out.push(item('shopify-stock', 'DIVERGENCE', `estoque Shopify (${input.shopifyStock}) acima da meta de ${OFFICIAL_SPEC.globalLimit}`));
  else if (input.shopifyStock < OFFICIAL_SPEC.globalLimit)
    out.push(item('shopify-stock', 'PENDING', `estoque Shopify ${input.shopifyStock} < meta ${OFFICIAL_SPEC.globalLimit}: ajuste manual conforme o lote aberto (o app não escreve na Shopify)`));
  else out.push(item('shopify-stock', 'OK', 'estoque Shopify igual à meta'));

  if (!campaign.active) out.push(item('active', 'PENDING', 'campanha inativa'));
  return out;
}

/** Pode vender? Só quando todos os itens estão OK (pendência ou divergência impede). */
export function isReadyToSell(items: readonly ReadinessItem[]): boolean {
  return items.every((entry) => entry.kind === 'OK');
}
