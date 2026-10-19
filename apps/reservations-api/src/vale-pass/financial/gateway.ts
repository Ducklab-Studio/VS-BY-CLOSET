/**
 * Meios de pagamento que NÃO são prova de pagamento comercial do Valle Pass: pagamento marcado MANUALMENTE na Shopify (gateway `manual`) e meios de teste/offline.
 * Os nomes vêm do `payment_gateway_names` do pedido e do `gateway` da transação. Comparação sem acento nem caixa; fail-closed (na dúvida, é revisão do ADMIN).
 * Um pagamento manual pode ser legítimo (ex.: transferência conferida), por isso NÃO é descartado: vira retenção para um ADMIN decidir com justificativa.
 */
const MANUAL_OR_TEST = ['manual', 'bogus', 'for testing', 'cash on delivery', 'bank deposit', 'money order', 'custom', 'sandbox', 'test'];

function normalize(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

export function isManualOrTestGateway(name: string | null | undefined): boolean {
  if (!name) return false;
  const value = normalize(name);
  return MANUAL_OR_TEST.some((entry) => value === entry || value.includes(entry)) || /\bcod\b/.test(value);
}

export const hasManualOrTestGateway = (names: readonly string[] | null | undefined): boolean => Boolean(names?.some((name) => isManualOrTestGateway(name)));
