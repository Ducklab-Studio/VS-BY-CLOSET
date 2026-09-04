-- Fase 6 — vínculo Reservation ↔ Shopify Cart + prova de posse do HOLD.
--
-- Aditivo puro: um enum NOVO (CREATE TYPE, não ALTER TYPE ADD VALUE —
-- não tem a restrição de duas transações que os enums existentes tinham
-- na Fase 4/5) e colunas novas em `reservations`, todas nullable ou com
-- DEFAULT. Nenhuma tabela/coluna existente é alterada de forma
-- destrutiva.
CREATE TYPE "checkout_state" AS ENUM ('none', 'creating', 'ready', 'failed');

ALTER TABLE "reservations"
  ADD COLUMN "hold_token_hash"     TEXT,
  ADD COLUMN "checkout_state"      "checkout_state" NOT NULL DEFAULT 'none',
  ADD COLUMN "shopify_cart_id"     TEXT,
  ADD COLUMN "checkout_url"        TEXT,
  ADD COLUMN "checkout_created_at" TIMESTAMPTZ,
  ADD COLUMN "payment_expires_at"  TIMESTAMPTZ;

-- Um cart Shopify não pode pertencer a duas Reservations. NULL é
-- permitido múltiplas vezes (comportamento padrão do Postgres: cada NULL
-- é distinto de todo outro NULL para fins de UNIQUE) — só o valor, quando
-- existe, precisa ser único.
CREATE UNIQUE INDEX "reservations_shopify_cart_id_key" ON "reservations" ("shopify_cart_id");
