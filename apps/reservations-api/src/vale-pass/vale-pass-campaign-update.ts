import type { Prisma } from '@prisma/client';
import { formatIsoDate, parseIsoDate } from './vale-pass-capacity';

/**
 * Plano de edição de uma campanha de Valle Pass: valida o PATCH contra o estado atual e contra o que já foi vendido, e
 * devolve só o que muda. Puro (sem banco): o serviço fornece o contexto lido DENTRO da transação, com a campanha travada.
 *
 * Princípios:
 *  - campo ausente = não muda; `null` = limpa (só onde faz sentido);
 *  - nenhum valor pode ser configurado de um jeito que já nasça violado pelo que foi vendido (ex.: limite menor que os
 *    passes já emitidos) — vira erro explicativo, nunca um bloqueio silencioso de pagamentos;
 *  - editar valor/validade NÃO altera passes já emitidos (cada um guarda o seu); só vale para emissões futuras.
 */

export interface CampaignCurrent {
  readonly name: string;
  readonly amountCents: number;
  readonly validityDays: number;
  readonly quantityLimit: number | null;
  readonly globalLimit: number | null;
  readonly voucherValidFrom: Date | null;
  readonly voucherValidUntil: Date | null;
  readonly salesEndDate: Date | null;
}

export interface CampaignUpdateInput {
  readonly name?: string | null;
  readonly amountCents?: number | null;
  readonly validityDays?: number | null;
  readonly quantityLimit?: number | null;
  readonly globalLimit?: number | null;
  readonly voucherValidFrom?: string | null;
  readonly voucherValidUntil?: string | null;
  readonly salesEndDate?: string | null;
}

export interface CampaignUpdateContext {
  /** Todos os passes emitidos da campanha (inclui cancelados): é o que o limite LEGADO compara. */
  readonly issued: number;
  /** Emitidos e não cancelados: é o que o limite GLOBAL compara. */
  readonly sold: number;
  /** Lote aberto, se houver: o que ainda precisa caber no limite global. */
  readonly openLot: { readonly quantity: number; readonly sold: number } | null;
}

export type CampaignUpdatePlan =
  | { readonly ok: true; readonly data: Prisma.ValePassCampaignUpdateInput; readonly changed: readonly string[]; readonly before: Record<string, unknown>; readonly after: Record<string, unknown> }
  | { readonly ok: false; readonly errors: readonly string[] };

const has = (input: object, key: string): boolean => Object.prototype.hasOwnProperty.call(input, key) && (input as Record<string, unknown>)[key] !== undefined;

export function planCampaignUpdate(current: CampaignCurrent, input: CampaignUpdateInput, context: CampaignUpdateContext): CampaignUpdatePlan {
  const errors: string[] = [];
  const data: Prisma.ValePassCampaignUpdateInput = {};
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  const changed: string[] = [];
  const set = (field: string, from: unknown, to: unknown, apply: () => void) => {
    if (from === to) return;
    apply();
    changed.push(field);
    before[field] = from;
    after[field] = to;
  };

  // Campos que nunca ficam vazios.
  if (has(input, 'name')) {
    const name = typeof input.name === 'string' ? input.name.trim() : null;
    if (!name) errors.push('O nome da campanha não pode ficar vazio.');
    else set('name', current.name, name, () => (data.name = name));
  }
  if (has(input, 'amountCents')) {
    if (input.amountCents === null) errors.push('O valor da campanha não pode ficar vazio.');
    else set('amountCents', current.amountCents, input.amountCents, () => (data.amountCents = input.amountCents as number));
  }
  if (has(input, 'validityDays')) {
    if (input.validityDays === null) errors.push('A validade em dias não pode ficar vazia.');
    else set('validityDays', current.validityDays, input.validityDays, () => (data.validityDays = input.validityDays as number));
  }

  // Limite LEGADO (bloqueia a emissão): nunca abaixo do que já foi emitido, senão o próximo pagamento ficaria sem vale.
  if (has(input, 'quantityLimit')) {
    const value = input.quantityLimit as number | null;
    if (value !== null && value < context.issued) {
      errors.push(`O limite de emissão (${value}) é menor que os ${context.issued} passes já emitidos: o próximo pagamento ficaria sem passe. Deixe vazio ou use um valor maior.`);
    } else set('quantityLimit', current.quantityLimit, value, () => (data.quantityLimit = value));
  }

  // Limite GLOBAL: precisa comportar o que já foi vendido e o saldo do lote aberto.
  if (has(input, 'globalLimit')) {
    const value = input.globalLimit as number | null;
    const needed = context.sold + (context.openLot ? Math.max(0, context.openLot.quantity - context.openLot.sold) : 0);
    if (value !== null && value < context.sold) {
      errors.push(`O limite global (${value}) é menor que os ${context.sold} passes já vendidos.`);
    } else if (value !== null && value < needed) {
      errors.push(`O limite global (${value}) não comporta o saldo do lote aberto (vendidos ${context.sold} + restante do lote ${needed - context.sold} = ${needed}). Encerre ou reduza o lote antes.`);
    } else set('globalLimit', current.globalLimit, value, () => (data.globalLimit = value));
  }

  // Validade fixa dos vouchers: as duas datas juntas, calendário real, início ≤ fim.
  if (has(input, 'voucherValidFrom') || has(input, 'voucherValidUntil')) {
    const fromText = has(input, 'voucherValidFrom') ? (input.voucherValidFrom as string | null) : formatIsoDate(current.voucherValidFrom);
    const untilText = has(input, 'voucherValidUntil') ? (input.voucherValidUntil as string | null) : formatIsoDate(current.voucherValidUntil);
    const from = fromText === null ? null : parseIsoDate(fromText);
    const until = untilText === null ? null : parseIsoDate(untilText);
    if ((fromText !== null && from === null) || (untilText !== null && until === null)) {
      errors.push('Data de validade inválida (use uma data real entre 2000 e 2100).');
    } else if ((from === null) !== (until === null)) {
      errors.push('Informe as duas datas da validade dos vouchers (início e fim), ou nenhuma.');
    } else if (from && until && from.getTime() > until.getTime()) {
      errors.push('O início da validade dos vouchers não pode ser depois do fim.');
    } else {
      set('voucherValidFrom', formatIsoDate(current.voucherValidFrom), formatIsoDate(from), () => (data.voucherValidFrom = from));
      set('voucherValidUntil', formatIsoDate(current.voucherValidUntil), formatIsoDate(until), () => (data.voucherValidUntil = until));
    }
  }

  // Data de encerramento das vendas: informativa. Nenhum encerramento automático.
  if (has(input, 'salesEndDate')) {
    const text = input.salesEndDate as string | null;
    const date = text === null ? null : parseIsoDate(text);
    if (text !== null && date === null) errors.push('Data de encerramento das vendas inválida.');
    else set('salesEndDate', formatIsoDate(current.salesEndDate), formatIsoDate(date), () => (data.salesEndDate = date));
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, data, changed, before, after };
}
