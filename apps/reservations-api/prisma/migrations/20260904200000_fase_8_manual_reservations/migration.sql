-- Fase 8 — reservas manuais/staff.
--
-- Aditivo: um enum novo (não altera nenhum existente — não precisa do
-- split em duas transações que ALTER TYPE ... ADD VALUE exige), 4
-- colunas novas em reservations (nullable ou com DEFAULT — nenhuma linha
-- existente quebra ou precisa de backfill), e 1 tabela nova.
--
-- source: de onde a reserva veio. DEFAULT 'online' cobre toda linha já
-- gravada (Fases 4-7, todas vieram do checkout público) sem UPDATE, e
-- cobre também qualquer INSERT futuro que não passe esse campo, então
-- HoldsService (Fase 5) não precisa ser tocado pra continuar correto.
--
-- customer_name/customer_phone: reserva manual precisa desses dois
-- (reserva online nunca tinha esse dado — o cliente nem se autentica).
-- Nullable porque reserva online legada/futura não os usa.
--
-- internal_note: observação da equipe, nunca exposta em endpoint público.
--
-- Deliberadamente NÃO criado: um status novo tipo 'manual_confirmed'.
-- Reserva manual nasce em 'confirmed' — status que já é membro de
-- OCCUPYING_RESERVATION_STATUSES, já tem 'confirmed → cancelled' na
-- máquina de estados (reservation-state-machine.ts), já é coberto pela
-- EXCLUDE constraint. `source` é o que diferencia a origem, não o status.
CREATE TYPE "reservation_source" AS ENUM ('online', 'manual_admin');

ALTER TABLE "reservations"
  ADD COLUMN "source" "reservation_source" NOT NULL DEFAULT 'online',
  ADD COLUMN "customer_name" TEXT,
  ADD COLUMN "customer_phone" TEXT,
  ADD COLUMN "internal_note" TEXT;

-- Idempotência da criação manual — mesmo padrão técnico de
-- hold_idempotency_keys (Fase 5: a PK é a própria "key", é o Postgres
-- que arbitra a corrida, não um lock de aplicação), mas em tabela
-- PRÓPRIA — pedido explícito: hold_idempotency_keys pertence
-- semanticamente ao fluxo de HOLD, reutilizá-la entre canais diferentes
-- criaria um espaço de chaves compartilhado onde uma Idempotency-Key do
-- painel administrativo poderia colidir com uma do carrinho público.
CREATE TABLE "manual_reservation_idempotency_keys" (
  "key"            TEXT PRIMARY KEY,
  "request_hash"   TEXT NOT NULL,
  "reservation_id" UUID NOT NULL REFERENCES "reservations"("id"),
  "created_at"     TIMESTAMPTZ NOT NULL DEFAULT now()
);
