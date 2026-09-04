-- Migration escrita à mão, não gerada por `prisma migrate dev`.
-- Motivo: a trava anti-double-booking (a constraint EXCLUDE lá embaixo) usa
-- sintaxe (EXCLUDE USING gist) que o DSL do Prisma não sabe expressar. Esta
-- migration é a fonte de verdade do schema físico; prisma/schema.prisma
-- descreve o mesmo resultado pro Prisma Client, com a coluna date_range
-- marcada Unsupported().

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TYPE "reservation_status" AS ENUM ('pending', 'confirmed', 'cancelled', 'completed');
CREATE TYPE "webhook_status" AS ENUM ('processed', 'failed', 'ignored');

CREATE TABLE "stores" (
  "id"             TEXT PRIMARY KEY,
  "shopify_domain" TEXT NOT NULL UNIQUE,
  "currency"       TEXT NOT NULL,
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "product_references" (
  "sku"             TEXT PRIMARY KEY,
  "name"            TEXT NOT NULL,
  "deposit_amount"  DECIMAL(10, 2),
  "active"          BOOLEAN NOT NULL DEFAULT true,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE "reservations" (
  "id"                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "sku"               TEXT NOT NULL REFERENCES "product_references"("sku"),
  "date_range"        DATERANGE NOT NULL,
  "status"            "reservation_status" NOT NULL DEFAULT 'pending',
  "origin_store_id"   TEXT NOT NULL REFERENCES "stores"("id"),
  "shopify_order_id"  TEXT NOT NULL,
  "shopify_order_gid" TEXT NOT NULL,
  "customer_email"    TEXT,
  "created_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Um pedido Shopify nunca vira duas reservas, mesmo se o webhook duplicar
  -- (reentrega é esperada, não é bug — ver webhook_events abaixo).
  CONSTRAINT "reservations_origin_store_id_shopify_order_id_key"
    UNIQUE ("origin_store_id", "shopify_order_id"),

  -- A trava real: o Postgres recusa fisicamente inserir/atualizar uma
  -- reservation 'confirmed' cujo date_range se sobreponha (&&) a outra
  -- reservation 'confirmed' do mesmo sku. Isso vale mesmo com múltiplas
  -- réplicas da API rodando ao mesmo tempo — não depende de lock de
  -- aplicação (SELECT FOR UPDATE), é o próprio banco que garante.
  -- O WHERE restringe a exclusão a linhas confirmed: pending/cancelled/
  -- completed podem se sobrepor livremente (ex.: histórico, ou dois pedidos
  -- pending concorrendo até um deles confirmar).
  CONSTRAINT "reservations_no_overlap_per_sku"
    EXCLUDE USING gist (
      "sku" WITH =,
      "date_range" WITH &&
    ) WHERE ("status" = 'confirmed')
);

CREATE INDEX "reservations_sku_status_idx" ON "reservations" ("sku", "status");

CREATE TABLE "webhook_events" (
  "id"                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "shopify_webhook_id" TEXT NOT NULL UNIQUE,
  "store_id"           TEXT NOT NULL REFERENCES "stores"("id"),
  "topic"              TEXT NOT NULL,
  "payload"            JSONB NOT NULL,
  "status"             "webhook_status" NOT NULL,
  "error_message"      TEXT,
  "processed_at"       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "webhook_events_store_id_topic_idx" ON "webhook_events" ("store_id", "topic");
