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

/**
 * "Limpar históricos" (arquivamento) — status em que uma reserva é
 * verdadeiramente terminal: nenhuma transição automática (webhook) nem
 * manual (painel) sai daqui, então arquivar não corre o risco de
 * esconder algo que ainda pode mudar. Deliberadamente DE FORA:
 *
 * - `hold`/`pending_payment`/`confirmed`/`preparing`/`ready_for_pickup`/
 *   `picked_up`/`returned`/`cleaning` — ainda em andamento.
 * - `problem`/`late_payment_conflict` — precisam de revisão humana
 *   (ocorrência operacional aberta); só saem de `problem` por ação
 *   manual futura, nunca automaticamente.
 * - `pending` — legado da Fase 1 nunca escrito por reserva nova, mas
 *   soa a "aguardando" — mantido fora por precaução.
 *
 * `expired` entra aqui apesar de poder (raramente) se recuperar via
 * late payment (`expired → confirmed`/`late_payment_conflict`,
 * webhooks.service.ts) — a proteção contra isso é o período mínimo de
 * segurança (ReservationArchiveService), não a exclusão do status.
 */
export const ARCHIVABLE_TERMINAL_STATUSES = ['cancelled', 'expired', 'completed'] as const;
