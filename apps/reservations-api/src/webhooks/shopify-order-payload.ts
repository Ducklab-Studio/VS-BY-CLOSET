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

/// `customer` traz `first_name`/`last_name` (confirmado contra
/// shopify.dev/docs/api/admin-rest — Order resource); `billing_address`/
/// `shipping_address` trazem os mesmos dois campos MAIS `name` (a
/// concatenação que a própria Shopify já calcula). Um único tipo cobre os
/// três containers porque `extractCustomerName`/`extractCustomerPhone`
/// olham os mesmos três, na mesma ordem de preferência.
interface ShopifyContactContainer {
  readonly phone?: string | null;
  readonly first_name?: string | null;
  readonly last_name?: string | null;
  readonly name?: string | null;
}

export interface ShopifyOrderPayload {
  readonly id: number | string;
  readonly admin_graphql_api_id: string;
  /// Número legível do pedido (ex.: "#1002") — confirmado contra
  /// shopify.dev. Usado só pra EXIBIÇÃO no ClosetAdmin (Valle Pass),
  /// nunca pra correlação/lógica.
  readonly name?: string;
  readonly financial_status?: string;
  readonly cancelled_at?: string | null;
  /// `closed_at` preenchido = pedido arquivado/fechado na Shopify;
  /// `updated_at` ordena entregas fora de ordem de `orders/updated`.
  readonly closed_at?: string | null;
  readonly updated_at?: string | null;
  readonly cancel_reason?: string | null;
  readonly note_attributes?: readonly ShopifyNoteAttribute[];
  readonly line_items?: readonly ShopifyOrderLineItem[];
  /// `email` costuma vir preenchido; `contact_email` é o fallback oficial
  /// da Shopify pra pedidos sem conta de cliente (checkout como
  /// visitante). Só usado pra comunicação OPERACIONAL — nunca pra
  /// checkout/pagamento, que continua sendo só a Shopify.
  readonly email?: string | null;
  readonly contact_email?: string | null;
  /// O telefone pode aparecer em mais de um ponto do Order dependendo de
  /// como o checkout foi preenchido. A ordem de preferência fica no parser
  /// abaixo; não copiamos endereço nem outros dados pessoais para a reserva.
  readonly phone?: string | null;
  readonly customer?: ShopifyContactContainer | null;
  readonly shipping_address?: ShopifyContactContainer | null;
  readonly billing_address?: ShopifyContactContainer | null;
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
 * `Reservation.customerEmail` da reserva ONLINE nasce do Order da Shopify,
 * porque o HOLD público não coleta contato. `email` é o padrão;
 * `contact_email` é fallback para checkout como visitante.
 */
export function extractCustomerEmail(order: ShopifyOrderPayload): string | null {
  const value = (order.email ?? order.contact_email)?.trim();
  return value ? value : null;
}

/**
 * Mesmo princípio do e-mail: o telefone operacional da reserva ONLINE vem
 * do Order real. Preferimos o campo de contato do próprio pedido, depois o
 * customer e por fim endereços. Não inventa DDI nem altera o valor aqui;
 * a normalização E.164-ish só acontece no adaptador do WhatsApp.
 */
export function extractCustomerPhone(order: ShopifyOrderPayload): string | null {
  const candidates = [
    order.phone,
    order.customer?.phone,
    order.shipping_address?.phone,
    order.billing_address?.phone,
  ];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * `Reservation.customerName` da reserva ONLINE nasce do Order, no mesmo
 * espírito de extractCustomerEmail/extractCustomerPhone acima — o HOLD
 * público não coleta nome. Preferência: `customer` (ligado à
 * identidade/conta de quem comprou), depois `shipping_address`, depois
 * `billing_address` (endereço pode ter o nome de um terceiro — por isso
 * vêm depois do customer). Em cada container: `first_name` + `last_name`
 * montam o nome completo; se algum faltar, cai para o `name` já
 * concatenado que a Shopify calcula nos endereços. Nunca deriva nome a
 * partir do e-mail.
 */
export function extractCustomerName(order: ShopifyOrderPayload): string | null {
  const candidates = [order.customer, order.shipping_address, order.billing_address];
  for (const candidate of candidates) {
    const name = fullName(candidate);
    if (name) return name;
  }
  return null;
}

function fullName(container: ShopifyContactContainer | null | undefined): string | null {
  if (!container) return null;
  const first = container.first_name?.trim();
  const last = container.last_name?.trim();
  const combined = [first, last].filter((part): part is string => Boolean(part)).join(' ');
  if (combined) return combined;
  const name = container.name?.trim();
  return name ? name : null;
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
