-- Fase 5 — idempotência de POST /holds.
--
-- Aditivo puro: uma tabela nova, nenhuma alteração em tabela existente.
-- `key` é a PRIMARY KEY (não um índice auxiliar sobre outra PK) de
-- propósito: é a violação dessa PK, arbitrada pelo Postgres, que resolve
-- com segurança duas requisições com a MESMA Idempotency-Key chegando ao
-- mesmo tempo (double-click) — ver HoldsService.createHold, o mesmo
-- padrão da EXCLUDE constraint (deixar o banco arbitrar, não lock de
-- aplicação).
CREATE TABLE "hold_idempotency_keys" (
  "key"            TEXT PRIMARY KEY,
  "request_hash"   TEXT NOT NULL,
  "reservation_id" UUID NOT NULL REFERENCES "reservations"("id"),
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX "hold_idempotency_keys_reservation_id_idx" ON "hold_idempotency_keys" ("reservation_id");
