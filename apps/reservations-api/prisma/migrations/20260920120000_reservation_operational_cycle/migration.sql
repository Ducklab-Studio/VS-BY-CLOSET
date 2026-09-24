ALTER TABLE "reservation_items"
  ADD COLUMN "returned_at" timestamptz,
  ADD COLUMN "returned_by" uuid,
  ADD COLUMN "cleaning_started_at" timestamptz,
  ADD COLUMN "cleaning_started_by" uuid,
  ADD COLUMN "cleaning_completed_at" timestamptz,
  ADD COLUMN "cleaning_completed_by" uuid;

-- Older legacy returned/completed rows have no actor or physical receipt time.
-- They remain nullable; new per-item transitions fill both columns atomically.
ALTER TABLE "reservation_items"
  ADD CONSTRAINT "reservation_item_cleaning_timestamps_ordered" CHECK (
    ("cleaning_started_at" IS NULL OR "returned_at" IS NULL OR "cleaning_started_at" >= "returned_at")
    AND ("cleaning_completed_at" IS NULL OR "cleaning_started_at" IS NULL OR "cleaning_completed_at" >= "cleaning_started_at")
  ),
  ADD CONSTRAINT "reservation_item_cancel_never_returned" CHECK (
    status <> 'cancelled' OR "returned_at" IS NULL
  );

CREATE OR REPLACE FUNCTION sync_reservation_item_status() RETURNS trigger AS $$
BEGIN
  -- Devolução/higienização são por peça; esses agregados são atualizados
  -- pelo painel sem sobrescrever itens em etapas diferentes.
  IF NEW."status" IN ('returned', 'cleaning', 'completed') THEN
    RETURN NEW;
  END IF;

  UPDATE "reservation_items" SET "status" = NEW."status" WHERE "reservation_id" = NEW."id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
