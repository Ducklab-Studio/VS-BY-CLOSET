-- Valle Pass: vale-presente/crédito de compra vendido pelo checkout
-- oficial da Shopify, TOTALMENTE separado do fluxo de aluguel — nunca
-- referencia rental_units, reservations, disponibilidade ou HOLD.

CREATE TYPE "vale_pass_status" AS ENUM ('ACTIVE', 'USED', 'EXPIRED', 'CANCELLED');

-- A "campanha": configura valor/validade/quantidade de um produto
-- Valle Pass já criado manualmente na Shopify (mesmo padrão de
-- rental_units.shopify_variant_id — nunca cria produto na Shopify).
-- "Encerrar" a campanha é active=false; nunca apaga os vales já
-- vendidos.
CREATE TABLE "vale_pass_campaigns" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"               TEXT NOT NULL,
  "amount_cents"       INTEGER NOT NULL,
  "validity_days"      INTEGER NOT NULL,
  "quantity_limit"     INTEGER,
  "shopify_variant_id" TEXT NOT NULL UNIQUE,
  "active"             BOOLEAN NOT NULL DEFAULT true,
  -- Sem FK de propósito (mesmo padrão de reservations.archived_by) —
  -- nunca trava se o AdminUser autor for removido/excluído no futuro.
  "created_by"         UUID,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ(6) NOT NULL
);

-- Um vale individual — nasce automaticamente quando orders/paid
-- confirma um pedido com line item de uma campanha, nunca criado
-- manualmente com valor livre.
CREATE TABLE "vale_passes" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"               TEXT NOT NULL UNIQUE,
  "campaign_id"        UUID NOT NULL REFERENCES "vale_pass_campaigns"("id"),
  -- Snapshot do valor da campanha no momento da compra — nunca muda
  -- mesmo que a campanha seja editada depois.
  "amount_cents"       INTEGER NOT NULL,
  "status"             "vale_pass_status" NOT NULL DEFAULT 'ACTIVE',
  "purchased_at"       TIMESTAMPTZ(6) NOT NULL,
  "expires_at"         TIMESTAMPTZ(6) NOT NULL,
  "customer_name"      TEXT,
  "customer_phone"     TEXT,
  "customer_email"     TEXT,
  "shopify_order_id"   TEXT,
  "shopify_order_gid"  TEXT,
  "shopify_order_name" TEXT,
  "used_at"            TIMESTAMPTZ(6),
  "used_by"            UUID,
  "cancelled_at"       TIMESTAMPTZ(6),
  "cancelled_by"       UUID,
  "cancel_reason"      TEXT,
  "created_at"         TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"         TIMESTAMPTZ(6) NOT NULL
);

CREATE INDEX "vale_passes_campaign_id_idx" ON "vale_passes"("campaign_id");
CREATE INDEX "vale_passes_status_idx" ON "vale_passes"("status");
CREATE INDEX "vale_passes_shopify_order_id_idx" ON "vale_passes"("shopify_order_id");

-- Trilha de eventos por vale (criado, usado, cancelado, expirado) —
-- mesmo espírito de reservation_events, domínio totalmente separado.
CREATE TABLE "vale_pass_events" (
  "id"           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "vale_pass_id" UUID NOT NULL REFERENCES "vale_passes"("id"),
  "type"         TEXT NOT NULL,
  "detail"       JSONB,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX "vale_pass_events_vale_pass_id_idx" ON "vale_pass_events"("vale_pass_id");
