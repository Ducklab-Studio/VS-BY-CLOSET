import { paymentTimeConfigFromEnv, STRICT_PAYMENT_TIME_CONFIG, type PaymentTimeConfig } from './payment-time-policy';
/**
 * Chaves do Valle Pass 2027 (integração financeira — PR F). TODAS DESLIGADAS POR PADRÃO: variável ausente, vazia ou qualquer valor que não seja
 * exatamente "on" mantém o comportamento de sempre. Lidas a cada uso (não no boot): desligar a chave no Railway vale após o reinício do serviço.
 *
 *  - VALE_PASS_TWO_VOUCHER_FLOW=on  → pagamento confirmado de campanha COM benefícios cadastrados passa pela validação financeira e pela emissão dos
 *    dois vouchers (+ fila de e-mail). Desligada, esse pagamento vira RETENÇÃO visível (nunca emite voucher único, nunca some).
 *  - VALE_PASS_AUTO_VERIFY=on       → (exige a chave acima) consulta as transações na Shopify e retoma sozinha as retenções PAYMENT_TIME_UNKNOWN que passarem em TODAS as validações.
 *  - VALE_PASS_SALES_CLOSE_GUARD=on → pedido CRIADO depois do fim do dia `salesEndDate` da campanha NÃO emite: vira retenção `SALES_CLOSED` para um ADMIN (ver sales-close.ts).
 *  - VALE_PASS_UNIT_REFUNDS=on      → `refunds/create` passa pelo tratamento por unidade (ledger, revisão, política ADMIN_CONFIRM). Desligada, vale o
 *    comportamento legado (cancela os vouchers ativos do pedido).
 *
 * Desligar qualquer chave NUNCA desliga cancelamentos, reembolsos nem a resolução administrativa: só decide quem emite e como os reembolsos são divididos.
 */
export interface FlowFlags {
  twoVoucher(): boolean;
  unitRefunds(): boolean;
  /** Política do horário do pagamento (padrão ESTRITO: o webhook sozinho não confirma). Ausente = estrita. */
  paymentTime?(): PaymentTimeConfig;
  /** Verificação financeira AUTOMÁTICA do horário do pagamento (consulta as transações na Shopify e retoma sozinha). Ausente = desligada. */
  autoVerify?(): boolean;
  /** Proteção contra venda depois do encerramento (retém, nunca cancela nem reembolsa). Ausente = desligada. */
  salesCloseGuard?(): boolean;
}

/** A verificação automática só roda com a chave própria E a integração dos dois vouchers ligadas. */
export const autoVerifyEnabled = (flags: FlowFlags): boolean => flags.twoVoucher() && (flags.autoVerify?.() ?? false);

/** Política efetiva do horário do pagamento (estrita quando a implementação não informa). */
export const paymentTimeOf = (flags: FlowFlags): PaymentTimeConfig => flags.paymentTime?.() ?? STRICT_PAYMENT_TIME_CONFIG;

export const FLOW_FLAGS_TOKEN = 'VALE_PASS_FLOW_FLAGS';

const isOn = (value: string | undefined): boolean => value?.trim().toLowerCase() === 'on';

export function envFlowFlags(env: Record<string, string | undefined> = process.env): FlowFlags {
  return {
    twoVoucher: () => isOn(env.VALE_PASS_TWO_VOUCHER_FLOW),
    unitRefunds: () => isOn(env.VALE_PASS_UNIT_REFUNDS),
    paymentTime: () => paymentTimeConfigFromEnv(env),
    autoVerify: () => isOn(env.VALE_PASS_AUTO_VERIFY),
    salesCloseGuard: () => isOn(env.VALE_PASS_SALES_CLOSE_GUARD),
  };
}

/** Código do motivo guardado na retenção quando o pagamento chega com a chave desligada. */
export const INTEGRATION_DISABLED = 'INTEGRATION_DISABLED';

/** Código da retenção quando o pedido está pago mas o instante REAL do pagamento é desconhecido (cabeçalho ausente/inválido): o prazo de 3 dias não pode ser calculado. */
export const PAYMENT_TIME_UNKNOWN = 'PAYMENT_TIME_UNKNOWN';

/** Código da retenção quando a compra CRESCEU depois da emissão (unidades pagas a mais sem voucher): nunca emite sozinho; um ADMIN regulariza com a validação financeira. */
export const QUANTITY_INCREASED = 'QUANTITY_INCREASED';

/** Retenção aberta cuja quantidade do pedido AUMENTOU sem comprovação do pagamento do acréscimo: a retenção não cresce; o que sobra exige regularização do ADMIN. */
export const QUANTITY_INCREASED_UNPROVEN = 'QUANTITY_INCREASED_UNPROVEN';

/** Códigos de retenção que a retomada pelo ADMIN sabe reprocessar (a causa pode ter sido sanada: chave ligada / instante do pagamento chegou). */
export const RESUMABLE_HOLD_CODES: readonly string[] = [INTEGRATION_DISABLED, PAYMENT_TIME_UNKNOWN, QUANTITY_INCREASED];
