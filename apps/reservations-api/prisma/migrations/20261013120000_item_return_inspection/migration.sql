-- Conferência de devolução por peça. Só ADICIONA: dois tipos enumerados e duas
-- tabelas novas. Nenhuma tabela, coluna, linha ou constraint existente muda
-- (em particular reservation_items e a EXCLUDE de disponibilidade).

CREATE TYPE "return_condition" AS ENUM ('good', 'needs_cleaning', 'needs_maintenance', 'damaged');
CREATE TYPE "item_occurrence_kind" AS ENUM ('not_returned', 'note');

CREATE TABLE "reservation_item_returns" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "reservation_item_id" UUID NOT NULL,
  "reservation_id" UUID NOT NULL,
  "condition" "return_condition" NOT NULL,
  "notes" TEXT,
  "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "received_by" UUID NOT NULL,
  "received_by_name" TEXT NOT NULL,
  "expected_return_date" DATE,
  "days_late" INTEGER NOT NULL DEFAULT 0,
  "hold_released_at" TIMESTAMPTZ(6),
  "hold_released_by" UUID,
  "hold_released_by_name" TEXT,
  "hold_release_note" TEXT,
  CONSTRAINT "reservation_item_returns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reservation_item_returns_days_late_check" CHECK ("days_late" >= 0),
  -- Avaria ou manutenção sem descrição não é um registro útil: o banco também exige.
  CONSTRAINT "reservation_item_returns_notes_check" CHECK (
    "condition" IN ('good', 'needs_cleaning') OR char_length(btrim(coalesce("notes", ''))) >= 3
  ),
  -- Liberação só faz sentido para peça segurada, e sempre com autor e motivo.
  CONSTRAINT "reservation_item_returns_release_check" CHECK (
    "hold_released_at" IS NULL OR (
      "condition" IN ('needs_maintenance', 'damaged')
      AND "hold_released_by" IS NOT NULL
      AND char_length(btrim(coalesce("hold_release_note", ''))) >= 3
    )
  )
);

-- No máximo uma conferência por peça: o banco impede devolução duplicada.
CREATE UNIQUE INDEX "reservation_item_returns_reservation_item_id_key" ON "reservation_item_returns"("reservation_item_id");
CREATE INDEX "reservation_item_returns_reservation_id_idx" ON "reservation_item_returns"("reservation_id");
CREATE INDEX "reservation_item_returns_condition_idx" ON "reservation_item_returns"("condition");

ALTER TABLE "reservation_item_returns"
  ADD CONSTRAINT "reservation_item_returns_reservation_item_id_fkey"
  FOREIGN KEY ("reservation_item_id") REFERENCES "reservation_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "reservation_item_occurrences" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "reservation_item_id" UUID NOT NULL,
  "reservation_id" UUID NOT NULL,
  "kind" "item_occurrence_kind" NOT NULL,
  "notes" TEXT NOT NULL,
  "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "recorded_by" UUID NOT NULL,
  "recorded_by_name" TEXT NOT NULL,
  CONSTRAINT "reservation_item_occurrences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "reservation_item_occurrences_notes_check" CHECK (char_length(btrim("notes")) >= 3)
);

CREATE INDEX "reservation_item_occurrences_reservation_item_id_idx" ON "reservation_item_occurrences"("reservation_item_id");
CREATE INDEX "reservation_item_occurrences_reservation_id_idx" ON "reservation_item_occurrences"("reservation_id");

ALTER TABLE "reservation_item_occurrences"
  ADD CONSTRAINT "reservation_item_occurrences_reservation_item_id_fkey"
  FOREIGN KEY ("reservation_item_id") REFERENCES "reservation_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
