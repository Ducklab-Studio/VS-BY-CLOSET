-- Pedido excluído na Shopify (orders/delete ou reconciliação): marca na
-- reserva vinculada. Coluna nova e nula; nada existente é apagado ou
-- alterado (status, pagamento, datas, peças, HOLD e histórico ficam como
-- estão). Idempotente: pode rodar de novo sem efeito.
ALTER TABLE "reservations" ADD COLUMN IF NOT EXISTS "shopify_order_deleted_at" TIMESTAMPTZ(6);
