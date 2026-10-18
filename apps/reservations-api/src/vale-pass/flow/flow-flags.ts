/**
 * Chaves do Valle Pass 2027 (integração financeira — PR F). TODAS DESLIGADAS POR PADRÃO: variável ausente, vazia ou qualquer valor que não seja
 * exatamente "on" mantém o comportamento de sempre. Lidas a cada uso (não no boot): desligar a chave no Railway vale após o reinício do serviço.
 *
 *  - VALE_PASS_TWO_VOUCHER_FLOW=on  → pagamento confirmado de campanha COM benefícios cadastrados passa pela validação financeira e pela emissão dos
 *    dois vouchers (+ fila de e-mail). Desligada, esse pagamento vira RETENÇÃO visível (nunca emite voucher único, nunca some).
 *  - VALE_PASS_UNIT_REFUNDS=on      → `refunds/create` passa pelo tratamento por unidade (ledger, revisão, política ADMIN_CONFIRM). Desligada, vale o
 *    comportamento legado (cancela os vouchers ativos do pedido).
 *
 * Desligar qualquer chave NUNCA desliga cancelamentos, reembolsos nem a resolução administrativa: só decide quem emite e como os reembolsos são divididos.
 */
export interface FlowFlags {
  twoVoucher(): boolean;
  unitRefunds(): boolean;
}

export const FLOW_FLAGS_TOKEN = 'VALE_PASS_FLOW_FLAGS';

const isOn = (value: string | undefined): boolean => value?.trim().toLowerCase() === 'on';

export function envFlowFlags(env: Record<string, string | undefined> = process.env): FlowFlags {
  return {
    twoVoucher: () => isOn(env.VALE_PASS_TWO_VOUCHER_FLOW),
    unitRefunds: () => isOn(env.VALE_PASS_UNIT_REFUNDS),
  };
}

/** Código do motivo guardado na retenção quando o pagamento chega com a chave desligada. */
export const INTEGRATION_DISABLED = 'INTEGRATION_DISABLED';

/** Código da retenção quando o pedido está pago mas o instante REAL do pagamento é desconhecido (cabeçalho ausente/inválido): o prazo de 3 dias não pode ser calculado. */
export const PAYMENT_TIME_UNKNOWN = 'PAYMENT_TIME_UNKNOWN';

/** Código da retenção quando a compra CRESCEU depois da emissão (unidades pagas a mais sem voucher): nunca emite sozinho; um ADMIN regulariza com a validação financeira. */
export const QUANTITY_INCREASED = 'QUANTITY_INCREASED';

/** Códigos de retenção que a retomada pelo ADMIN sabe reprocessar (a causa pode ter sido sanada: chave ligada / instante do pagamento chegou). */
export const RESUMABLE_HOLD_CODES: readonly string[] = [INTEGRATION_DISABLED, PAYMENT_TIME_UNKNOWN, QUANTITY_INCREASED];
