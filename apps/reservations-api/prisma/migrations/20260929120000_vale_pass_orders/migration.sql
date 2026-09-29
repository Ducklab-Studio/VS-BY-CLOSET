-- Pedidos Shopify com Valle Pass, do `orders/create` em diante — inclusive os
-- nunca pagos (pendentes, expirados, cancelados, recusados). Antes, só
-- `orders/paid` deixava rastro (o vale emitido): um pedido pendente que
-- expirava não aparecia no ClosetAdmin. Só CREATE: nada existente é alterado,
-- e nenhum dado é copiado aqui — a reconciliação periódica importa os pedidos
-- recentes pela Admin API. Continua sem referenciar aluguel (rental_units,
-- reservations, HOLD).

CREATE TYPE "vale_pass_order_status" AS ENUM ('PENDING', 'CONFIRMED', 'EXPIRED', 'CANCELLED', 'DECLINED', 'REFUNDED');

CREATE TABLE "vale_pass_orders" (
  "id"                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shopify_order_id"      TEXT NOT NULL UNIQUE,
  "shopify_order_gid"     TEXT,
  "shopify_order_name"    TEXT,
  "status"                "vale_pass_order_status" NOT NULL DEFAULT 'PENDING',
  "financial_status"      TEXT,
  "cancel_reason"         TEXT,
  "quantity"              INTEGER NOT NULL DEFAULT 0,
  "customer_name"         TEXT,
  "customer_phone"        TEXT,
  "customer_email"        TEXT,
  "order_created_at"      TIMESTAMPTZ(6),
  -- `updated_at` do estado já aplicado: webhook atrasado não volta o status.
  "shopify_updated_at"    TIMESTAMPTZ(6),
  "status_changed_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "vouchers_processed_at" TIMESTAMPTZ(6),
  "deleted_in_shopify_at" TIMESTAMPTZ(6),
  "last_sync_source"      TEXT NOT NULL,
  "created_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ(6) NOT NULL
);

CREATE INDEX "vale_pass_orders_status_idx" ON "vale_pass_orders"("status");
CREATE INDEX "vale_pass_orders_order_created_at_idx" ON "vale_pass_orders"("order_created_at");

-- Histórico do pedido; só INSERT.
CREATE TABLE "vale_pass_order_events" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "vale_pass_order_id" UUID NOT NULL REFERENCES "vale_pass_orders"("id"),
  "type"               TEXT NOT NULL,
  "detail"             JSONB,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX "vale_pass_order_events_vale_pass_order_id_idx" ON "vale_pass_order_events"("vale_pass_order_id");
