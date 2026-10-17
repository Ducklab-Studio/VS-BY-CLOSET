-- Fase 3 (aluguel por peça) — migration A1, modelo de dados v2.1 (docs/FASE3-MODELO-DADOS-V2.md).
--
-- SÓ ADICIONA e NADA É ATIVADO: colunas NULAS e sem DEFAULT (somente metadado, sem reescrever tabela) e CHECKs
-- `NOT VALID`. Nenhuma coluna, linha, índice, gatilho ou constraint existente muda; a EXCLUDE
-- `reservation_items_no_overlap_per_unit` e o gatilho `reservation_status_sync` ficam exatamente como estão. Nenhum
-- código lê ou grava estas colunas ainda: todo item e todo pedido existente continua "legado" (colunas nulas).
--
-- `NOT VALID`: a constraint já vale para toda linha nova ou alterada, mas não varre as linhas existentes agora. A
-- varredura (`VALIDATE CONSTRAINT`) é a migration A2, separada, porque num único lote ela seguraria o ACCESS EXCLUSIVE
-- das linhas abaixo durante a varredura. Os gatilhos de invariantes entre tabelas são a migration B (depois que o
-- código escrever os dados novos). Os índices parciais entram junto do PR que introduzir as consultas que os usam.
--
-- Falha segura: `lock_timeout` impede que o ALTER TABLE espere indefinidamente atrás de uma transação longa e enfileire
-- todas as leituras da tabela. Se estourar, o lote inteiro é desfeito (nada fica aplicado pela metade); o runbook em
-- docs/FASE3-MIGRATION-A1-RUNBOOK.md descreve como recuperar o estado "falhou" do Prisma (P3009).
--
-- Tetos de valores monetários (centavos) são TÉCNICOS (cabem em int4), não regra comercial. A fórmula do total é
-- calculada em bigint: em 32 bits a própria conta estoura com "integer out of range" antes de o CHECK reprovar.

SET lock_timeout = '5s';

-- ─────────────────────────────────────────────────────────────
-- 1. reservation_items — cronograma por peça (grupo 1) e preço congelado (grupo 2)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE "reservation_items"
  ADD COLUMN "pickup_date"            DATE,
  ADD COLUMN "rental_days"            INTEGER,
  ADD COLUMN "calculated_return_date" DATE,
  ADD COLUMN "return_date"            DATE,
  ADD COLUMN "prep_days_applied"      INTEGER,
  ADD COLUMN "cleaning_days_applied"  INTEGER,
  ADD COLUMN "pickup_minute_of_day"   SMALLINT,
  ADD COLUMN "unit_base_cents"        INTEGER,
  ADD COLUMN "extra_day_cents"        INTEGER,
  ADD COLUMN "line_total_cents"       INTEGER;

-- ─────────────────────────────────────────────────────────────
-- 2. reservations — regra de preço congelada e total esperado
-- ─────────────────────────────────────────────────────────────
ALTER TABLE "reservations"
  ADD COLUMN "pricing_version"       INTEGER,
  ADD COLUMN "pricing_snapshot"      JSONB,
  ADD COLUMN "reservation_fee_cents" INTEGER,
  ADD COLUMN "expected_total_cents"  INTEGER;

-- ─────────────────────────────────────────────────────────────
-- 3. CHECKs de reservation_items (NOT VALID)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE "reservation_items"
  -- grupo de cronograma: tudo ou nada
  ADD CONSTRAINT "ri_schedule_all_or_none" CHECK (
        ("pickup_date" IS NULL) = ("rental_days" IS NULL)
    AND ("pickup_date" IS NULL) = ("calculated_return_date" IS NULL)
    AND ("pickup_date" IS NULL) = ("return_date" IS NULL)
    AND ("pickup_date" IS NULL) = ("prep_days_applied" IS NULL)
    AND ("pickup_date" IS NULL) = ("cleaning_days_applied" IS NULL)) NOT VALID,
  ADD CONSTRAINT "ri_schedule_ranges" CHECK (
    ("rental_days" IS NULL OR "rental_days" BETWEEN 1 AND 3650)
    AND ("prep_days_applied" IS NULL OR "prep_days_applied" BETWEEN 0 AND 365)
    AND ("cleaning_days_applied" IS NULL OR "cleaning_days_applied" BETWEEN 0 AND 365)) NOT VALID,
  -- duração contratada: retirada + dias
  ADD CONSTRAINT "ri_calculated_return_matches" CHECK (
    "calculated_return_date" IS NULL OR "calculated_return_date" = "pickup_date" + "rental_days") NOT VALID,
  -- devolução efetiva: ">=" de propósito (a regra do domingo ainda é decisão comercial pendente: a opção "sábado"
  -- devolve em calculada − 1, que em aluguel de 1 dia pode cair no próprio dia da retirada)
  ADD CONSTRAINT "ri_return_not_before_pickup" CHECK (
    "return_date" IS NULL OR "return_date" >= "pickup_date") NOT VALID,
  -- a janela bloqueada gravada tem que ser a das regras congeladas no item
  ADD CONSTRAINT "ri_blocked_range_matches_frozen_rules" CHECK (
    "pickup_date" IS NULL OR "blocked_range" =
      daterange("pickup_date" - "prep_days_applied", "return_date" + "cleaning_days_applied" + 1, '[)')) NOT VALID,
  ADD CONSTRAINT "ri_pickup_minute_range" CHECK (
    "pickup_minute_of_day" IS NULL
    OR ("pickup_date" IS NOT NULL AND "pickup_minute_of_day" BETWEEN 0 AND 1439)) NOT VALID,
  -- grupo de preço: tudo ou nada, e exige o cronograma
  ADD CONSTRAINT "ri_pricing_all_or_none" CHECK (
        ("unit_base_cents" IS NULL) = ("extra_day_cents" IS NULL)
    AND ("unit_base_cents" IS NULL) = ("line_total_cents" IS NULL)) NOT VALID,
  ADD CONSTRAINT "ri_pricing_requires_schedule" CHECK (
    "unit_base_cents" IS NULL OR "pickup_date" IS NOT NULL) NOT VALID,
  ADD CONSTRAINT "ri_pricing_ceilings" CHECK (
    ("unit_base_cents" IS NULL OR "unit_base_cents" BETWEEN 0 AND 100000000)
    AND ("extra_day_cents" IS NULL OR "extra_day_cents" BETWEEN 0 AND 100000000)
    AND ("line_total_cents" IS NULL OR "line_total_cents" BETWEEN 0 AND 1000000000)) NOT VALID,
  -- total = base + (dias − 1) × extra, em bigint
  ADD CONSTRAINT "ri_line_total_formula" CHECK (
    "line_total_cents" IS NULL
    OR "line_total_cents"::bigint = "unit_base_cents"::bigint + ("rental_days" - 1)::bigint * "extra_day_cents"::bigint) NOT VALID;

-- ─────────────────────────────────────────────────────────────
-- 4. CHECKs de reservations (NOT VALID)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE "reservations"
  ADD CONSTRAINT "r_pricing_all_or_none" CHECK (
        ("pricing_version" IS NULL) = ("pricing_snapshot" IS NULL)
    AND ("pricing_version" IS NULL) = ("reservation_fee_cents" IS NULL)
    AND ("pricing_version" IS NULL) = ("expected_total_cents" IS NULL)) NOT VALID,
  ADD CONSTRAINT "r_pricing_amounts" CHECK (
    "pricing_version" IS NULL
    OR ("pricing_version" >= 1
        AND "reservation_fee_cents" BETWEEN 0 AND 100000000
        AND "expected_total_cents" BETWEEN "reservation_fee_cents" AND 2000000000)) NOT VALID,
  ADD CONSTRAINT "r_pricing_snapshot_valid" CHECK (
    "pricing_snapshot" IS NULL OR (
      jsonb_typeof("pricing_snapshot") = 'object'
      AND "pricing_snapshot" ?& ARRAY['engine','currency','timezone','extraDayBasisPoints','extraDayRounding','reservationFeeCents']
      AND jsonb_typeof("pricing_snapshot"->'engine') = 'string'
      AND "pricing_snapshot"->>'engine' = 'rental-pricing@' || "pricing_version"::text
      AND jsonb_typeof("pricing_snapshot"->'currency') = 'string'
      AND "pricing_snapshot"->>'currency' ~ '^[A-Z]{3}$'
      AND jsonb_typeof("pricing_snapshot"->'timezone') = 'string'
      AND length("pricing_snapshot"->>'timezone') BETWEEN 1 AND 64
      AND jsonb_typeof("pricing_snapshot"->'extraDayBasisPoints') = 'number'
      AND CASE WHEN "pricing_snapshot"->>'extraDayBasisPoints' ~ '^[0-9]{1,6}$'
               THEN ("pricing_snapshot"->>'extraDayBasisPoints')::int <= 100000 ELSE false END
      AND jsonb_typeof("pricing_snapshot"->'extraDayRounding') = 'string'
      AND "pricing_snapshot"->>'extraDayRounding' IN ('half_up','down','up')
      AND jsonb_typeof("pricing_snapshot"->'reservationFeeCents') = 'number'
      AND "pricing_snapshot"->>'reservationFeeCents' = "reservation_fee_cents"::text)) NOT VALID;

RESET lock_timeout;
