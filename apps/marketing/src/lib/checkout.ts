/**
 * Fase 6 — ponte entre o carrinho e o reservations-api.
 *
 * O navegador NÃO cria mais o cart Shopify de checkout diretamente:
 * primeiro cria um HOLD real no Postgres (POST /holds), depois pede ao
 * backend pra abrir o carrinho Shopify vinculado a esse HOLD (POST
 * /checkout). O backend controla o vínculo Reservation ↔ Cart — o
 * navegador só recebe de volta a URL final pra redirecionar.
 *
 * Sem fallback nenhum: URL não configurada, resposta não-ok, erro de
 * rede — tudo vira um resultado de erro explícito. Nunca cai de volta
 * pro fluxo antigo (cart Shopify criado no navegador) nem inventa uma
 * checkoutUrl.
 */

export interface HoldItemInput {
  shopifyVariantId: string;
  quantity: number;
}

export interface SundayReturnOptionInfo {
  type: 'saturday' | 'mondayMorning';
  date: string;
  window?: string;
}

export type CreateHoldResult =
  | { ok: true; reservationId: string; holdToken: string }
  | { ok: false; reason: 'needs_sunday_choice'; returnOptions: SundayReturnOptionInfo[] }
  | { ok: false; reason: 'error'; message: string };

export async function createHold(input: {
  items: HoldItemInput[];
  pickupDate: string;
  sundayReturnOption?: 'saturday' | 'mondayMorning';
  termsAccepted: boolean;
  idempotencyKey: string;
}): Promise<CreateHoldResult> {
  const base = process.env.NEXT_PUBLIC_HOLDS_URL;
  if (!base) return { ok: false, reason: 'error', message: 'Reserva não configurada no momento.' };

  let res: Response;
  let json: unknown;
  try {
    res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey },
      body: JSON.stringify({
        items: input.items,
        pickupDate: input.pickupDate,
        ...(input.sundayReturnOption ? { sundayReturnOption: input.sundayReturnOption } : {}),
        termsAccepted: input.termsAccepted,
      }),
    });
    json = await res.json().catch(() => null);
  } catch {
    return { ok: false, reason: 'error', message: 'Não foi possível iniciar a reserva. Verifique sua conexão.' };
  }

  const body = (json ?? {}) as { reservationId?: unknown; holdToken?: unknown; message?: unknown; violations?: unknown; returnOptions?: unknown };

  if (res.ok && typeof body.reservationId === 'string' && typeof body.holdToken === 'string') {
    return { ok: true, reservationId: body.reservationId, holdToken: body.holdToken };
  }

  if (res.status === 422 && Array.isArray(body.violations) && body.violations.includes('pickup_is_sunday_return')) {
    return { ok: false, reason: 'needs_sunday_choice', returnOptions: Array.isArray(body.returnOptions) ? (body.returnOptions as SundayReturnOptionInfo[]) : [] };
  }

  return { ok: false, reason: 'error', message: typeof body.message === 'string' ? body.message : 'Não foi possível iniciar a reserva.' };
}

/**
 * Fase 7 — o `holdToken` NUNCA vai em URL (mesma regra da Fase 6), então
 * a página pós-checkout (pra onde a Shopify não necessariamente
 * redireciona de volta automaticamente — ver observação no relatório da
 * Fase 7) precisa achá-lo de outro jeito: localStorage, mesmo padrão já
 * usado pro id do carrinho Shopify (`vsc_cart_id`). Guardado só no
 * momento em que o HOLD é criado de verdade; nunca lido de volta pra
 * exibição, só reenviado como header em GET /reservations/:id/status.
 */
const LAST_RESERVATION_KEY = 'vsc_last_reservation';

export interface StoredReservation {
  reservationId: string;
  holdToken: string;
}

export function storeLastReservation(reservationId: string, holdToken: string): void {
  try {
    localStorage.setItem(LAST_RESERVATION_KEY, JSON.stringify({ reservationId, holdToken }));
  } catch {
    // Navegador anônimo ou storage bloqueado — a página de status trata
    // "nada guardado" como um estado normal, não um erro.
  }
}

export function readLastReservation(): StoredReservation | null {
  try {
    const raw = localStorage.getItem(LAST_RESERVATION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredReservation>;
    if (typeof parsed.reservationId !== 'string' || typeof parsed.holdToken !== 'string') return null;
    return { reservationId: parsed.reservationId, holdToken: parsed.holdToken };
  } catch {
    return null;
  }
}

export interface ReservationStatus {
  status: string;
  paymentStatus?: string;
  pickupDate: string | null;
  effectiveReturnDate: string | null;
}

export type GetReservationStatusResult = { ok: true; data: ReservationStatus } | { ok: false; message: string };

/**
 * GET /reservations/:id/status — item 18/19 da Fase 7. O backend é a
 * ÚNICA autoridade sobre "a reserva foi confirmada" (nunca o redirect do
 * navegador de volta da Shopify, nunca um `?success=true` na URL).
 */
export async function getReservationStatus(reservationId: string, holdToken: string): Promise<GetReservationStatusResult> {
  const base = process.env.NEXT_PUBLIC_RESERVATIONS_URL;
  if (!base) return { ok: false, message: 'Consulta de status não configurada no momento.' };

  let res: Response;
  let json: unknown;
  try {
    res = await fetch(`${base.replace(/\/$/, '')}/${encodeURIComponent(reservationId)}/status`, {
      headers: { Accept: 'application/json', 'X-Hold-Token': holdToken },
    });
    json = await res.json().catch(() => null);
  } catch {
    return { ok: false, message: 'Não foi possível consultar sua reserva. Verifique sua conexão.' };
  }

  const body = (json ?? {}) as Partial<ReservationStatus> & { message?: unknown };
  if (res.ok && typeof body.status === 'string') {
    return { ok: true, data: { status: body.status, paymentStatus: typeof body.paymentStatus === 'string' ? body.paymentStatus : undefined, pickupDate: body.pickupDate ?? null, effectiveReturnDate: body.effectiveReturnDate ?? null } };
  }
  return { ok: false, message: typeof body.message === 'string' ? body.message : 'Não foi possível consultar sua reserva.' };
}

export type CreateCheckoutResult = { ok: true; checkoutUrl: string } | { ok: false; message: string; expired?: boolean };

export async function createCheckout(reservationId: string, holdToken: string): Promise<CreateCheckoutResult> {
  const base = process.env.NEXT_PUBLIC_CHECKOUT_URL;
  if (!base) return { ok: false, message: 'Checkout não configurado no momento.' };

  let res: Response;
  let json: unknown;
  try {
    res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reservationId, holdToken }),
    });
    json = await res.json().catch(() => null);
  } catch {
    return { ok: false, message: 'Não foi possível continuar para o pagamento. Verifique sua conexão.' };
  }

  const body = (json ?? {}) as { checkoutUrl?: unknown; message?: unknown };
  if (res.ok && typeof body.checkoutUrl === 'string') {
    return { ok: true, checkoutUrl: body.checkoutUrl };
  }
  return { ok: false, expired: res.status === 410, message: typeof body.message === 'string' ? body.message : 'Não foi possível continuar para o pagamento.' };
}

/**
 * Mercado Pago (Checkout Pro, ambiente de TESTE/sandbox) — método
 * PRINCIPAL de pagamento; `createCheckout` (Shopify) acima continua
 * como alternativa. Mesmo contrato de `createCheckout`: HOLD já criado,
 * navegador só recebe a URL final pra redirecionar — nunca vê token,
 * valor calculado no servidor. `idempotencyKey` própria (nunca reaproveita
 * a do HOLD): cada TENTATIVA de pagamento é uma chave nova, mesmo padrão
 * de POST /holds.
 */
export async function createMercadoPagoPreference(reservationId: string, holdToken: string): Promise<CreateCheckoutResult> {
  const base = process.env.NEXT_PUBLIC_MERCADOPAGO_CHECKOUT_URL;
  if (!base) return { ok: false, message: 'Pagamento com Mercado Pago não configurado no momento.' };

  let res: Response;
  let json: unknown;
  try {
    res = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reservationId, holdToken, idempotencyKey: crypto.randomUUID() }),
    });
    json = await res.json().catch(() => null);
  } catch {
    return { ok: false, message: 'Não foi possível continuar para o pagamento. Verifique sua conexão.' };
  }

  const body = (json ?? {}) as { checkoutUrl?: unknown; message?: unknown };
  if (res.ok && typeof body.checkoutUrl === 'string') {
    return { ok: true, checkoutUrl: body.checkoutUrl };
  }
  return { ok: false, expired: res.status === 410, message: typeof body.message === 'string' ? body.message : 'Não foi possível continuar para o pagamento com o Mercado Pago.' };
}
