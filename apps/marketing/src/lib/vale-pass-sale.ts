/**
 * Estado de venda do Valle Pass na vitrine (puro, sem rede). A ÚNICA fonte da verdade é o que a Shopify informa para a variante
 * (`availableForSale`, que reflete o estoque aberto pela equipe): a página nunca "abre" por causa de uma data.
 *
 * FAIL CLOSED: qualquer coisa diferente de `availableForSale === true` (falso, ausente, nulo) mantém a venda fechada, e o botão
 * de compra nem sequer recebe o endereço do checkout.
 */
export type ValePassSaleState = 'closed' | 'open';

export function valePassSaleState(variant: { availableForSale?: boolean | null } | null | undefined): ValePassSaleState {
  return variant?.availableForSale === true ? 'open' : 'closed';
}

/**
 * Previsão de abertura das vendas informada pelo Anderson (01/11/2026, confirmada em 26/10/2026). É só uma PREVISÃO exibida ao público: não confirma a venda e
 * não libera nada; a abertura real é o estoque da Shopify (acima).
 */
export const VALE_PASS_EXPECTED_SALES_START = '2026-11-01';

const COMMERCIAL_TIME_ZONE = 'America/Sao_Paulo';

/** `YYYY-MM-DD` do dia comercial (fuso de São Paulo), independente do fuso do servidor. */
function commercialDateKey(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: COMMERCIAL_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function formatIsoDateBr(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${year}`;
}

/**
 * Texto de apoio do pré-lançamento. Enquanto a data prevista não passou, informa a previsão deixando claro que ela pode mudar; depois dela, não
 * repete uma data vencida: diz apenas que a abertura será anunciada.
 */
export function valePassClosedNote(now: Date): string {
  if (commercialDateKey(now) <= VALE_PASS_EXPECTED_SALES_START) {
    return `Vendas previstas a partir de ${formatIsoDateBr(VALE_PASS_EXPECTED_SALES_START)} — data sujeita a confirmação.`;
  }
  return 'A abertura das vendas será anunciada em breve.';
}
