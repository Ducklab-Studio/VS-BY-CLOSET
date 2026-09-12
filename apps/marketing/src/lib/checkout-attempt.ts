import { createCheckout, createHold, storeLastReservation, type CreateCheckoutResult, type CreateHoldResult, type StoredReservation } from './checkout';

type Input = Omit<Parameters<typeof createHold>[0], 'idempotencyKey'>;
type Result = CreateCheckoutResult | Exclude<CreateHoldResult, { ok: true }>;
type CreateCheckoutFn = (reservationId: string, holdToken: string) => Promise<CreateCheckoutResult>;

/**
 * Keep the credential from a successful HOLD: idempotent replays omit it.
 *
 * `createCheckoutFn` é escolhido POR CHAMADA (não fixado na criação do
 * attempt) — Mercado Pago é o método principal, Shopify a alternativa
 * (ver carrinho/page.tsx); se o cliente trocar de método depois de já
 * ter um HOLD (ex.: uma tentativa anterior falhou só na criação do
 * checkout), a MESMA reserva/HOLD é reaproveitada, nunca cria um
 * segundo — só o provedor final muda. Default `createCheckout`
 * (Shopify) preserva o comportamento anterior pra quem não passar nada.
 */
export function createCheckoutAttempt() {
  let attempt: { intent: string; key: string; hold?: StoredReservation } | undefined;
  let busy = false;

  return {
    reset() { attempt = undefined; },
    async run(input: Input, beforeHold: () => Promise<void>, createCheckoutFn: CreateCheckoutFn = createCheckout): Promise<Result> {
      if (busy) return { ok: false, message: 'O checkout já está sendo preparado.' };
      if (!input.termsAccepted) return { ok: false, message: 'Aceite os termos para continuar.' };
      const intent = JSON.stringify({
        items: [...input.items].sort((a, b) => a.shopifyVariantId.localeCompare(b.shopifyVariantId)),
        pickupDate: input.pickupDate,
        sundayReturnOption: input.sundayReturnOption ?? null,
      });
      if (attempt?.intent !== intent) attempt = { intent, key: crypto.randomUUID() };
      const current = attempt;
      const changed = (): Result => ({ ok: false, message: 'O carrinho mudou. Confira os itens antes de continuar.' });
      busy = true;
      try {
        if (!current.hold) {
          // On retry the customer's own HOLD already occupies this stock.
          await beforeHold();
          if (attempt !== current) return changed();
          const held = await createHold({ ...input, idempotencyKey: current.key });
          if (attempt !== current) return changed();
          if (!held.ok) return held;
          current.hold = { reservationId: held.reservationId, holdToken: held.holdToken };
          storeLastReservation(held.reservationId, held.holdToken);
        }
        const result = await createCheckoutFn(current.hold.reservationId, current.hold.holdToken);
        if (attempt !== current) return changed();
        // Only an authoritative expiration permits a fresh HOLD on retry.
        if (!result.ok && result.expired) attempt = undefined;
        return result;
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : 'Não foi possível preparar a reserva.' };
      } finally {
        busy = false;
      }
    },
  };
}
