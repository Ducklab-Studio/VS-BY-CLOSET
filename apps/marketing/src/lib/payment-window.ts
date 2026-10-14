/**
 * Prazo mostrado à cliente no carrinho ("Reserva garantida por N minutos"). É um TEXTO: o prazo
 * real vem da API (`PAYMENT_WINDOW_MINUTES`, padrão 60, contado a partir da criação do
 * checkout). Mantenha igual ao padrão de `apps/reservations-api/src/checkout/checkout.config.ts`
 * — test/payment-window.test.mjs reprova se divergirem. Se o valor for alterado só no Railway,
 * atualize aqui também, senão a cliente lê um prazo diferente do real.
 */
export const PAYMENT_WINDOW_MINUTES_LABEL = 60;
