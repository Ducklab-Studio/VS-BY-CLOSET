/**
 * Status que "ocupam" uma RentalUnit — usados tanto pela leitura
 * (AvailabilityService, pra saber o que já está bloqueado) quanto pela
 * escrita (HoldsService, pra saber o que conta como ocupação real ao
 * alocar). É a MESMA lista, literalmente idêntica ao WHERE da EXCLUDE
 * constraint (migration 20260903120100) — centralizada aqui desde a Fase
 * 5 pra não voltar a divergir entre os dois serviços (existia uma cópia
 * só em availability.service.ts antes desta fase).
 *
 * Duplicar esta lista em SQL é inevitável (a constraint do banco não
 * importa uma constante de TypeScript), mas fica documentado aqui que as
 * duas precisam continuar iguais.
 */
export const OCCUPYING_RESERVATION_STATUSES = [
  'hold',
  'pending_payment',
  'confirmed',
  'preparing',
  'ready_for_pickup',
  'picked_up',
  'returned',
  'cleaning',
  'problem',
  // 'late_payment_conflict' (Fase 7) fica DE FORA de propósito — ao
  // contrário de 'problem', que significa "ainda segurando a unidade
  // enquanto um humano decide", late_payment_conflict significa "a
  // capacidade já foi pra outra reserva" — incluir aqui faria o
  // trigger tentar ocupar de novo uma unidade que a EXCLUDE constraint
  // sabe (corretamente) que já não é mais desta reserva. Ver
  // WebhooksService.attemptLatePaymentRecovery.
] as const;
