/**
 * Indicadores do cartão e do formulário de edição da campanha do Valle Pass (puro: sem rede, sem React). Só EXPLICA o que o sistema já faz; nenhuma regra muda.
 *
 * - "Vendidos" usa a mesma definição do motor de capacidade (unidade emitida e NÃO totalmente cancelada); o histórico (emitidas, inclusive canceladas) aparece
 *   à parte e nada é apagado.
 * - Validade: campanha com benefícios (modelo novo) usa a janela FIXA de datas e, sem ela, os pagamentos ficam RETIDOS (nunca "N dias"); "N dias após a compra"
 *   só existe no modelo legado (sem benefícios). Mesmo critério do webhook (`benefícios cadastrados > 0`).
 */
import type { ValePassCampaign } from './admin-data';

export type CampaignIndicatorInput = Pick<ValePassCampaign, 'validityDays' | 'voucherValidFrom' | 'voucherValidUntil' | 'quantityLimit' | 'soldCount'> & {
  readonly issuedCount?: number;
  readonly benefitsCount?: number;
};

export type ValidityKind = 'FIXED_WINDOW' | 'PENDING' | 'LEGACY_DAYS';

export interface ValidityIndicator {
  readonly kind: ValidityKind;
  /** Texto principal do cartão ("01/12/2026 a 30/09/2027", "A definir" ou "30 dias após a compra"). */
  readonly text: string;
  /** Explicação curta quando há algo a avisar (nulo quando não há). */
  readonly note: string | null;
}

/** "2027-09-30" -> "30/09/2027"; qualquer outra forma (ou data impossível) é `null` (nunca inventa uma data). */
export function formatIsoDay(iso: string | null | undefined): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!match) return null;
  const [, y, m, d] = match;
  const probe = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (probe.getUTCFullYear() !== Number(y) || probe.getUTCMonth() !== Number(m) - 1 || probe.getUTCDate() !== Number(d)) return null;
  return `${d}/${m}/${y}`;
}

export function validityIndicator(c: CampaignIndicatorInput): ValidityIndicator {
  const from = formatIsoDay(c.voucherValidFrom);
  const until = formatIsoDay(c.voucherValidUntil);
  const legacyText = `${c.validityDays} dias após a compra`;
  // API antiga (sem a informação do modelo): comportamento anterior, sem afirmar nada novo.
  if (c.benefitsCount === undefined) return { kind: 'LEGACY_DAYS', text: legacyText, note: null };
  // Modelo legado (sem benefícios): a emissão usa os dias; datas registradas não valem para ele.
  if (c.benefitsCount === 0) {
    return { kind: 'LEGACY_DAYS', text: legacyText, note: from || until ? 'Datas registradas, mas esta campanha não tem benefícios: a emissão usa os dias após a compra.' : null };
  }
  if (from && until) return { kind: 'FIXED_WINDOW', text: `${from} a ${until}`, note: null };
  if (from || until) {
    return { kind: 'PENDING', text: 'A definir', note: 'Janela incompleta: informe início e fim juntos. Enquanto isso, pagamentos ficam retidos.' };
  }
  return { kind: 'PENDING', text: 'A definir', note: 'Pagamentos ficam retidos até a validade (início e fim) ser configurada.' };
}

export interface SoldIndicator {
  /** "0", "5" ou "5 / 10" (com o limite legado, quando existir). */
  readonly value: string;
  /** Histórico: canceladas fora da contagem (nulo quando não há). */
  readonly note: string | null;
}

export function soldIndicator(c: CampaignIndicatorInput): SoldIndicator {
  const value = `${c.soldCount}${c.quantityLimit ? ` / ${c.quantityLimit}` : ''}`;
  const issued = c.issuedCount;
  if (typeof issued !== 'number' || issued <= c.soldCount) return { value, note: null };
  const cancelled = issued - c.soldCount;
  return { value, note: `${cancelled} ${cancelled === 1 ? 'unidade cancelada' : 'unidades canceladas'} no histórico (${issued} emitida${issued === 1 ? '' : 's'} no total)` };
}

export interface EditFormValidityCopy {
  readonly daysLabel: string;
  readonly windowHint: string;
  readonly today: string;
}

/** Textos da validade no formulário de edição, conforme o modelo da campanha (a explicação não pode contradizer o que o sistema faz). */
export function editFormValidityCopy(c: CampaignIndicatorInput): EditFormValidityCopy {
  const indicator = validityIndicator(c);
  if (c.benefitsCount !== undefined && c.benefitsCount > 0) {
    return {
      daysLabel: 'Validade em dias — legado (não vale para esta campanha)',
      windowHint: 'Esta campanha tem benefícios e usa a validade fixa (início e fim, sempre juntos). Sem as duas datas, os pagamentos ficam retidos e nada é emitido.',
      today: indicator.kind === 'FIXED_WINDOW' ? `validade ${indicator.text}` : 'validade a definir (pagamentos retidos)',
    };
  }
  return {
    daysLabel: 'Validade em dias — usada na emissão',
    windowHint: 'Campanhas sem benefícios (modelo antigo) usam a validade em dias. As datas acima só valem para campanhas com benefícios cadastrados.',
    today: indicator.text,
  };
}

/**
 * Atualiza os indicadores do cartão com os do painel de capacidade (mesma fonte da verdade). Devolve o MESMO objeto quando nada mudou (sem re-render nem laço);
 * não mexe em mais nenhum campo da campanha (inclusive `updatedAt`, a versão usada nas edições).
 */
export function syncCampaignWithCapacity<T extends CampaignIndicatorInput>(
  campaign: T,
  capacity: { readonly totals: { readonly sold: number; readonly issued: number }; readonly benefits: readonly unknown[] },
): T {
  const sold = capacity.totals.sold;
  const issued = capacity.totals.issued;
  const benefits = capacity.benefits.length;
  if (campaign.soldCount === sold && campaign.issuedCount === issued && campaign.benefitsCount === benefits) return campaign;
  return { ...campaign, soldCount: sold, issuedCount: issued, benefitsCount: benefits };
}
