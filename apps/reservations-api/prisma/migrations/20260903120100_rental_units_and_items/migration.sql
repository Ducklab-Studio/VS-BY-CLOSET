-- Migration B de 2 — precisa rodar DEPOIS que a A já commitou (os
-- valores novos do enum são usados no WHERE da EXCLUDE constraint lá
-- embaixo).
--
-- Tudo aditivo/incremental: nenhum DROP TABLE, TRUNCATE ou reset.
-- reservations.sku e reservations.date_range NÃO são removidos aqui —
-- ficam como legado inerte (nada novo escreve neles) até uma migration
-- de limpeza futura, depois que o caminho novo estiver provado em
-- produção. A constraint reservations_no_overlap_per_sku (a trava
-- antiga) também fica — não protege mais nada de novo, mas não atrapalha
-- e não é destrutiva mantê-la por enquanto.

-- ─────────────────────────────────────────────────────────────
-- 1. rental_units (renomeia product_references, reestrutura a chave)
-- ─────────────────────────────────────────────────────────────

-- A FK de reservations.sku apontava pra product_references(sku), que
-- vai deixar de ser a chave primária da tabela — precisa cair antes de
-- mexer nas constraints de chave. reservations.sku continua existindo
-- como coluna (legado), só sem FK enforçada.
ALTER TABLE "reservations" DROP CONSTRAINT "reservations_sku_fkey";

ALTER TABLE "product_references" RENAME TO "rental_units";
ALTER TABLE "rental_units" RENAME COLUMN "sku" TO "code";

ALTER TABLE "rental_units"
  ADD COLUMN "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN "shopify_product_id" TEXT,
  ADD COLUMN "shopify_variant_id" TEXT,
  ADD COLUMN "shopify_sku" TEXT,
  -- Confirmado: hoje toda peça cadastrada é roupa/bota (reservável e
  -- contável). Acessório é exceção explícita, cadastrado com os dois
  -- campos em false — não é o padrão da tabela.
  ADD COLUMN "reservable_online" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "counts_toward_rental_duration" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "rental_units" DROP CONSTRAINT "product_references_pkey";
ALTER TABLE "rental_units" ADD CONSTRAINT "rental_units_pkey" PRIMARY KEY ("id");
ALTER TABLE "rental_units" ADD CONSTRAINT "rental_units_code_key" UNIQUE ("code");

CREATE INDEX "rental_units_shopify_variant_id_idx" ON "rental_units" ("shopify_variant_id");
CREATE INDEX "rental_units_active_idx" ON "rental_units" ("active");

-- ─────────────────────────────────────────────────────────────
-- 2. reservations — novas colunas pro fluxo de HOLD (Fase 5)
-- ─────────────────────────────────────────────────────────────

ALTER TABLE "reservations"
  ADD COLUMN "pickup_date" DATE,
  ADD COLUMN "return_date" DATE,
  ADD COLUMN "expires_at" TIMESTAMPTZ,
  ADD COLUMN "terms_accepted_at" TIMESTAMPTZ,
  ADD COLUMN "terms_version" TEXT;

-- Um HOLD ainda não tem pedido Shopify — só ganha quando vira
-- pending_payment.
ALTER TABLE "reservations" ALTER COLUMN "shopify_order_id" DROP NOT NULL;
ALTER TABLE "reservations" ALTER COLUMN "status" SET DEFAULT 'hold';

-- ─────────────────────────────────────────────────────────────
-- 3. reservation_items — onde a trava de verdade vive agora
-- ─────────────────────────────────────────────────────────────

CREATE TABLE "reservation_items" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "reservation_id"  UUID NOT NULL REFERENCES "reservations"("id"),
  "rental_unit_id"  UUID NOT NULL REFERENCES "rental_units"("id"),
  -- Cópia de reservations.status, mantida só por trigger (ver abaixo) —
  -- nunca escrita direto pela aplicação. Existe porque a EXCLUDE
  -- constraint só pode olhar coluna da própria tabela.
  "status"          "reservation_status" NOT NULL,
  -- Janela de ocupação JÁ com preparo+higienização embutidos, calculada
  -- e gravada no momento da criação (não derivada on-the-fly) — se as
  -- regras de config mudarem depois, reservas já feitas não deslocam.
  "blocked_range"   DATERANGE NOT NULL,
  "created_at"      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A trava real: nenhuma unidade física pode ter duas linhas "ocupando"
  -- (nos status abaixo) com blocked_range sobreposto. Funciona sob
  -- múltiplas instâncias/requests concorrentes porque é o próprio
  -- Postgres que garante, não lock de aplicação.
  CONSTRAINT "reservation_items_no_overlap_per_unit"
    EXCLUDE USING gist (
      "rental_unit_id" WITH =,
      "blocked_range" WITH &&
    ) WHERE (
      "status" IN (
        'hold', 'pending_payment', 'confirmed', 'preparing',
        'ready_for_pickup', 'picked_up', 'returned', 'cleaning', 'problem'
      )
    )
);

CREATE INDEX "reservation_items_reservation_id_idx" ON "reservation_items" ("reservation_id");
CREATE INDEX "reservation_items_rental_unit_id_status_idx" ON "reservation_items" ("rental_unit_id", "status");

-- Sincronia: reservations.status é a fonte da verdade;
-- reservation_items.status é espelho garantido por trigger, nunca
-- escrito à mão pela aplicação (ver decisão da Fase 2 revisada).
CREATE FUNCTION sync_reservation_item_status() RETURNS trigger AS $$
BEGIN
  UPDATE "reservation_items" SET "status" = NEW."status" WHERE "reservation_id" = NEW."id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "reservation_status_sync"
  AFTER UPDATE OF "status" ON "reservations"
  FOR EACH ROW
  WHEN (OLD."status" IS DISTINCT FROM NEW."status")
  EXECUTE FUNCTION sync_reservation_item_status();

-- ─────────────────────────────────────────────────────────────
-- 4. rental_rule_config — singleton com os valores confirmados
-- ─────────────────────────────────────────────────────────────

CREATE TABLE "rental_rule_config" (
  "id"                   TEXT PRIMARY KEY DEFAULT 'default',
  "min_advance_days"     INT NOT NULL DEFAULT 15,
  "prep_days"            INT NOT NULL DEFAULT 3,
  "cleaning_days"        INT NOT NULL DEFAULT 2,
  "blackout_start"       TEXT NOT NULL DEFAULT '06-01',
  "blackout_end"         TEXT NOT NULL DEFAULT '09-30',
  "max_pieces"           INT NOT NULL DEFAULT 6,
  "pieces_to_days_table" JSONB NOT NULL,
  "timezone"             TEXT NOT NULL DEFAULT 'America/Santiago',
  "updated_at"           TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO "rental_rule_config" ("id", "pieces_to_days_table") VALUES (
  'default',
  '[{"upTo":2,"days":2},{"upTo":4,"days":3},{"upTo":6,"days":4}]'
);
