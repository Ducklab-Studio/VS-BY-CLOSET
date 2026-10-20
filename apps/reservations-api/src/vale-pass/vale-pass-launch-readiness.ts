/**
 * Prontidão de lançamento da campanha oficial do Valle Pass 2027 (puro, sem banco e sem Shopify). Compara a campanha como está com o que o
 * Anderson JÁ CONFIRMOU e separa o que falta em dois grupos: DIVERGÊNCIA (configuração que pode ser corrigida) e PENDÊNCIA (decisão
 * comercial que ninguém pode inventar). Só LEITURA: nenhuma função aqui altera campanha, estoque ou pedido.
 */

/** Regras confirmadas pelo Anderson (preço, benefícios, meta, fim da validade). Nada aqui é suposição. */
export const OFFICIAL_SPEC = {
  amountCents: 35_000,
  globalLimit: 1_000,
  voucherValidUntil: '2027-09-30',
  vouchers: [
    { company: 'VALLE_SHOWROOM', amountCents: 50_000 },
    { company: 'VS_BY_CLOSET', amountCents: 5_000 },
  ],
  discountPercent: 10,
} as const;

export interface ReadinessCampaign {
  readonly amountCents: number;
  readonly active: boolean;
  readonly quantityLimit: number | null;
  readonly globalLimit: number | null;
  /** `YYYY-MM-DD` ou nulo. */
  readonly voucherValidFrom: string | null;
  readonly voucherValidUntil: string | null;
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
  if (discount && !discount.terms?.trim()) out.push(item('discount-terms', 'PENDING', 'condições do desconto de 10% sem texto aprovado pelo Anderson'));

  out.push(
    campaign.voucherValidUntil === OFFICIAL_SPEC.voucherValidUntil
      ? item('valid-until', 'OK', 'validade até 30/09/2027')
      : item('valid-until', 'DIVERGENCE', `fim da validade ${campaign.voucherValidUntil ?? 'não configurado'}; informado: ${OFFICIAL_SPEC.voucherValidUntil}`),
  );
  out.push(
    campaign.voucherValidFrom
      ? item('valid-from', 'OK', `validade começa em ${campaign.voucherValidFrom}`)
      : item('valid-from', 'PENDING', 'data de INÍCIO da validade não definida (sem ela a emissão fica retida, por segurança)'),
  );
  out.push(item('extension', 'PENDING', 'prorrogação da validade: regra não definida (não implementada)'));

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
