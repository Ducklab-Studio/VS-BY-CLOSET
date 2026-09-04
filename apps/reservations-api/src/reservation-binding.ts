import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Binding assinado pelo servidor entre Reservation e o pedido Shopify —
 * endurecimento pedido antes de continuar a Fase 7: `reservation_id`
 * sozinho como atributo de cart não basta, porque atributos de cart
 * podem ser alterados via Storefront API enquanto o cart ainda existe
 * (`cartAttributesUpdate`) — um cliente mal-intencionado poderia trocar
 * o `reservation_id` de um cart barato pra apontar pra uma reserva mais
 * cara antes de pagar. A assinatura HMAC não pode ser forjada sem o
 * segredo (SERVER-ONLY, nunca chega no navegador); qualquer atributo
 * alterado depois de assinado invalida a comparação em
 * `verifyReservationSignature`.
 *
 * Compartilhado entre CheckoutService (Fase 6 — assina na criação do
 * cart) e WebhooksService (Fase 7 — reverifica no webhook). Uma
 * implementação só, nunca duas cópias da mesma lógica de canonicalização/
 * assinatura.
 */

export function generateReservationBindingId(): string {
  // 128 bits — não precisa ser tão longo quanto o holdToken (não é uma
  // credencial de posse por si só, é um nonce que entra na assinatura).
  return randomBytes(16).toString('base64url');
}

/**
 * Variant id normalizado pra comparação — confirmado contra a
 * documentação oficial (Order REST resource) que `line_items[].variant_id`
 * do webhook é sempre um número cru (`447654529`), nunca um GID; já
 * `RentalUnit.shopifyVariantId` neste projeto pode estar guardado como
 * GID completo (`gid://shopify/ProductVariant/123`) dependendo de como
 * foi cadastrado. Normaliza os dois lados pro mesmo formato (só o
 * número) antes de comparar — nunca assume que um dos dois formatos é
 * "o certo".
 */
export function normalizeVariantId(value: string): string {
  const match = /\/ProductVariant\/(\d+)\s*$/.exec(value.trim());
  return match ? match[1] : value.trim();
}

export interface VariantQuantity {
  readonly variantId: string;
  readonly quantity: number;
}

/** Agrupa por variante normalizada + soma quantidade, depois ordena —
 *  determinístico independente da ordem de entrada. Usado tanto pra
 *  montar as linhas do cart quanto pra calcular o fingerprint que entra
 *  na assinatura — a MESMA função dos dois lados, nunca duas
 *  implementações. */
export function groupAndSortVariantQuantities(items: readonly VariantQuantity[]): VariantQuantity[] {
  const byVariant = new Map<string, number>();
  for (const item of items) {
    const id = normalizeVariantId(item.variantId);
    byVariant.set(id, (byVariant.get(id) ?? 0) + item.quantity);
  }
  return Array.from(byVariant.entries())
    .map(([variantId, quantity]) => ({ variantId, quantity }))
    .sort((a, b) => a.variantId.localeCompare(b.variantId));
}

export function canonicalItemsFingerprint(items: readonly VariantQuantity[]): string {
  return groupAndSortVariantQuantities(items)
    .map((i) => `${i.variantId}:${i.quantity}`)
    .join('|');
}

export interface ReservationBindingPayload {
  readonly reservationId: string;
  readonly reservationBindingId: string;
  readonly itemsFingerprint: string;
  readonly pickupDate: string;
  readonly effectiveReturnDate: string;
}

function canonicalPayloadString(input: ReservationBindingPayload): string {
  return [input.reservationId, input.reservationBindingId, input.itemsFingerprint, input.pickupDate, input.effectiveReturnDate].join('|');
}

export function computeReservationSignature(secret: string, input: ReservationBindingPayload): string {
  return createHmac('sha256', secret).update(canonicalPayloadString(input)).digest('hex');
}

export function verifyReservationSignature(secret: string, input: ReservationBindingPayload, signature: string | undefined | null): boolean {
  if (!signature) return false;
  const expected = computeReservationSignature(secret, input);
  let expectedBuf: Buffer;
  let actualBuf: Buffer;
  try {
    expectedBuf = Buffer.from(expected, 'hex');
    actualBuf = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}
