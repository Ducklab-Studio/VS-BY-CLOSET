/**
 * Só o subconjunto do payload REST de Order/Refund que a Fase 7
 * realmente lê — confirmado contra shopify.dev/docs/api/admin-rest
 * (Order resource): `id` numérico, `admin_graphql_api_id` no formato
 * `gid://shopify/Order/{id}`, `note_attributes` como `[{name, value}]`
 * (não `{key, value}` — checado na documentação oficial antes de
 * escrever este parser).
 */
export interface ShopifyNoteAttribute {
  readonly name: string;
  readonly value: string;
}

/** Confirmado contra shopify.dev: `variant_id` no line item do REST é
 *  sempre um número cru (`447654529`), nunca um GID — normalizar os
 *  dois lados antes de comparar é o que `normalizeVariantId` em
 *  reservation-binding.ts faz. */
export interface ShopifyOrderLineItem {
  readonly variant_id?: number | string | null;
  readonly quantity?: number;
}

export interface ShopifyOrderPayload {
  readonly id: number | string;
  readonly admin_graphql_api_id: string;
  readonly financial_status?: string;
  readonly cancelled_at?: string | null;
  readonly cancel_reason?: string | null;
  readonly note_attributes?: readonly ShopifyNoteAttribute[];
  readonly line_items?: readonly ShopifyOrderLineItem[];
  /// `email` costuma vir preenchido; `contact_email` é o fallback oficial
  /// da Shopify pra pedidos sem conta de cliente (checkout como
  /// visitante). Só usado pra e-mail OPERACIONAL (Fase 10) — nunca pra
  /// nada de checkout/pagamento, que continua sendo só a Shopify.
  readonly email?: string | null;
  readonly contact_email?: string | null;
}

export interface ShopifyRefundTransaction {
  readonly amount?: string;
}

export interface ShopifyRefundPayload {
  readonly id: number | string;
  readonly order_id: number | string;
  readonly transactions?: readonly ShopifyRefundTransaction[];
  readonly refund_line_items?: readonly unknown[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * O vínculo pedido↔reserva inteiro depende disto — devolve `null` (nunca
 * lança, nunca "escolhe parecido") pra qualquer coisa que não seja
 * literalmente um UUID válido no atributo `reservation_id`. Quem chama
 * trata `null` como "correlação impossível" e falha fechado (item 5 da
 * Fase 7).
 */
export function extractReservationId(order: ShopifyOrderPayload): string | null {
  const attr = order.note_attributes?.find((a) => a.name === 'reservation_id');
  const value = attr?.value?.trim();
  if (!value || !UUID_RE.test(value)) return null;
  return value;
}

/** Mesmo princípio de extractReservationId — devolve `null` (nunca uma
 *  string vazia tratada como "válida") pra qualquer atributo ausente. */
export function extractNoteAttribute(order: ShopifyOrderPayload, name: string): string | null {
  const attr = order.note_attributes?.find((a) => a.name === name);
  const value = attr?.value?.trim();
  return value ? value : null;
}

/**
 * Fase 10 — achado da auditoria: `Reservation.customerEmail` nunca era
 * preenchido pra reserva ONLINE (só a manual grava, e é opcional lá) —
 * o HOLD público nunca coleta e-mail, então o único lugar onde ele
 * existe de verdade é no próprio Order da Shopify. `email` é o padrão;
 * `contact_email` é o fallback oficial da Shopify pra checkout como
 * visitante. `null` (nunca string vazia) quando nenhum dos dois vem —
 * e-mails operacionais simplesmente não são enviados pra essa reserva,
 * não é tratado como erro.
 */
export function extractCustomerEmail(order: ShopifyOrderPayload): string | null {
  const value = (order.email ?? order.contact_email)?.trim();
  return value ? value : null;
}

/** {variantId, quantity} normalizados a partir das linhas REAIS do
 *  pedido — usado pra revalidar contra as ReservationItems no endurecimento
 *  da correlação (item 7 do pedido do usuário: "validar que as linhas
 *  REAIS do Order correspondem exatamente às RentalUnits/ReservationItems"). */
export function extractOrderLineVariants(order: ShopifyOrderPayload): { variantId: string; quantity: number }[] {
  const result: { variantId: string; quantity: number }[] = [];
  for (const line of order.line_items ?? []) {
    if (line.variant_id == null) continue;
    const quantity = typeof line.quantity === 'number' && Number.isFinite(line.quantity) ? line.quantity : 0;
    if (quantity <= 0) continue;
    result.push({ variantId: String(line.variant_id), quantity });
  }
  return result;
}

/** Soma só os valores — nunca o objeto de transação inteiro (que pode
 *  carregar detalhe de gateway/pagamento) vai pro log/auditoria. */
export function sumRefundAmount(refund: ShopifyRefundPayload): number {
  let total = 0;
  for (const t of refund.transactions ?? []) {
    const n = Number(t.amount);
    if (Number.isFinite(n)) total += n;
  }
  return Math.round(total * 100) / 100;
}
