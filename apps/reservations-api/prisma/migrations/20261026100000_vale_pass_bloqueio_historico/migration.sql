-- Valle Pass 2027 — Fase 3 / PR C1: bloqueio e desbloqueio administrativo de vouchers, com histórico imutável.
--
-- O que muda
--  * Nova tabela `vale_pass_block_events` (só INSERT): cada bloqueio/desbloqueio, com justificativa (10–500), operador, chave de idempotência (única por voucher),
--    sequência por voucher e um retrato do saldo (prova de que o bloqueio não mexe no saldo). UPDATE/DELETE/TRUNCATE recusados.
--  * Gatilho BEFORE INSERT valida sob o lock da linha do voucher (BLOCK só se não estiver bloqueado; UNBLOCK só se estiver, e nunca de voucher CANCELADO nem
--    com reembolso em revisão); AFTER INSERT aplica `blocked_at/by/reason` em `vale_passes` (único caminho: UPDATE direto dessas colunas é recusado).
--  * Voucher bloqueado nunca vira USADO (status), e agora também não aceita REVERSÃO de resgate (o saldo fica congelado). O RESGATE já era recusado (PR A).
--  * Bloqueio NÃO altera status, saldo, validade nem histórico; desbloquear NÃO reativa nada (cancelado/expirado/em revisão continuam como estão).
--
-- Compatibilidade / deploy gradual: aditiva (tabela, tipo, funções, gatilhos; duas funções existentes são substituídas por CREATE OR REPLACE com a regra a mais).
-- Código ANTIGO não toca `blocked_*` (nenhum caminho do código atual escreve essas colunas), então continua funcionando. Rollback: ver
-- docs/VALLE-PASS-2027-FASE3-BLOQUEIO.md. Atomicidade: uma transação; `lock_timeout` evita esperar indefinidamente.
SET lock_timeout = '5s';

CREATE TYPE "vale_pass_block_kind" AS ENUM ('BLOCK', 'UNBLOCK');

CREATE TABLE "vale_pass_block_events" (
  "id"              UUID                   NOT NULL DEFAULT gen_random_uuid(),
  "vale_pass_id"    UUID                   NOT NULL,
  "seq"             INTEGER                NOT NULL,
  "kind"            "vale_pass_block_kind" NOT NULL,
  "reason"          TEXT                   NOT NULL,
  "actor_admin_id"  UUID,
  "actor_name"      TEXT,
  "idempotency_key" TEXT                   NOT NULL,
  "request_hash"    TEXT,
  "balance_cents"   INTEGER                NOT NULL DEFAULT 0,
  "created_at"      TIMESTAMPTZ(6)         NOT NULL DEFAULT now(),
  CONSTRAINT "vale_pass_block_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vale_pass_block_seq_positive" CHECK ("seq" >= 1),
  CONSTRAINT "vale_pass_block_reason_len" CHECK (char_length(btrim("reason")) BETWEEN 10 AND 500),
  CONSTRAINT "vale_pass_block_idempotency_key_len" CHECK (char_length("idempotency_key") BETWEEN 8 AND 128)
);
CREATE UNIQUE INDEX "vale_pass_block_events_vale_pass_id_seq_key" ON "vale_pass_block_events"("vale_pass_id", "seq");
CREATE UNIQUE INDEX "vale_pass_block_events_vale_pass_id_idempotency_key_key" ON "vale_pass_block_events"("vale_pass_id", "idempotency_key");
CREATE INDEX "vale_pass_block_events_vale_pass_id_idx" ON "vale_pass_block_events"("vale_pass_id");
ALTER TABLE "vale_pass_block_events" ADD CONSTRAINT "vale_pass_block_events_vale_pass_id_fkey" FOREIGN KEY ("vale_pass_id") REFERENCES "vale_passes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Validação e numeração (BEFORE INSERT), sob o lock da linha do voucher. Não altera outra tabela: o efeito só acontece no AFTER INSERT.
CREATE FUNCTION "vale_pass_block_before_insert"() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v "vale_passes"%ROWTYPE;
  last_seq integer;
BEGIN
  SELECT * INTO v FROM "vale_passes" WHERE "id" = NEW."vale_pass_id" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vale_pass_block_voucher_missing: voucher inexistente' USING ERRCODE = '23503';
  END IF;
  SELECT coalesce(max("seq"), 0) INTO last_seq FROM "vale_pass_block_events" WHERE "vale_pass_id" = NEW."vale_pass_id";
  NEW."seq" := last_seq + 1;
  NEW."balance_cents" := v."balance_cents"; -- retrato do saldo no instante (o bloqueio nunca o altera)
  IF NEW."kind" = 'BLOCK' THEN
    IF v."blocked_at" IS NOT NULL THEN
      RAISE EXCEPTION 'vale_pass_block_already_blocked: o voucher já está bloqueado' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF v."blocked_at" IS NULL THEN
      RAISE EXCEPTION 'vale_pass_block_not_blocked: o voucher não está bloqueado' USING ERRCODE = '23514';
    END IF;
    IF v."status" = 'CANCELLED' THEN
      RAISE EXCEPTION 'vale_pass_unblock_cancelled: voucher cancelado não é desbloqueado (o cancelamento continua valendo)' USING ERRCODE = '23514';
    END IF;
    IF v."group_id" IS NOT NULL AND v."shopify_order_id" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "vale_pass_refund_applications" r
      WHERE r."shopify_order_id" = v."shopify_order_id" AND r."status" = 'NEEDS_REVIEW'
        AND (r."detail"->'reviewGroupIds' @> to_jsonb(v."group_id"::text) OR jsonb_array_length(coalesce(r."detail"->'reviewGroupIds', '[]'::jsonb)) = 0)
    ) THEN
      RAISE EXCEPTION 'vale_pass_unblock_refund_review: reembolso aguardando decisão administrativa; o desbloqueio espera a decisão' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "vale_pass_block_before_insert" BEFORE INSERT ON "vale_pass_block_events" FOR EACH ROW EXECUTE FUNCTION "vale_pass_block_before_insert"();

-- Aplica o bloqueio (AFTER INSERT): único caminho autorizado a mudar blocked_* (pg_trigger_depth() >= 2 no gatilho de vale_passes). Só estas colunas mudam.
CREATE FUNCTION "vale_pass_block_after_insert"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."kind" = 'BLOCK' THEN
    UPDATE "vale_passes" SET "blocked_at" = NEW."created_at", "blocked_by" = NEW."actor_admin_id", "block_reason" = NEW."reason", "updated_at" = now() WHERE "id" = NEW."vale_pass_id";
  ELSE
    UPDATE "vale_passes" SET "blocked_at" = NULL, "blocked_by" = NULL, "block_reason" = NULL, "updated_at" = now() WHERE "id" = NEW."vale_pass_id";
  END IF;
  RETURN NULL;
END
$fn$;
CREATE TRIGGER "vale_pass_block_after_insert" AFTER INSERT ON "vale_pass_block_events" FOR EACH ROW EXECUTE FUNCTION "vale_pass_block_after_insert"();

-- Histórico imutável.
CREATE FUNCTION "vale_pass_block_events_immutable"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'vale_pass_block_immutable: o histórico de bloqueios não pode ser alterado nem apagado' USING ERRCODE = '23514';
END
$fn$;
CREATE TRIGGER "vale_pass_block_no_update_delete" BEFORE UPDATE OR DELETE ON "vale_pass_block_events" FOR EACH ROW EXECUTE FUNCTION "vale_pass_block_events_immutable"();
CREATE TRIGGER "vale_pass_block_no_truncate" BEFORE TRUNCATE ON "vale_pass_block_events" FOR EACH STATEMENT EXECUTE FUNCTION "vale_pass_block_events_immutable"();

-- vale_passes: blocked_* só mudam pelo histórico; voucher bloqueado nunca vira USADO (nem o legado, tudo ou nada). Substitui a função do PR A (mesmas regras + 2).
CREATE OR REPLACE FUNCTION "vale_pass_balance_guard"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."balance_cents" IS DISTINCT FROM OLD."balance_cents" AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'vale_pass_balance_direct_update: o saldo só muda por lançamento no livro-razão' USING ERRCODE = '23514';
  END IF;
  IF (NEW."blocked_at" IS DISTINCT FROM OLD."blocked_at" OR NEW."blocked_by" IS DISTINCT FROM OLD."blocked_by" OR NEW."block_reason" IS DISTINCT FROM OLD."block_reason")
     AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'vale_pass_block_direct_update: o bloqueio só muda pelo histórico de bloqueios' USING ERRCODE = '23514';
  END IF;
  IF NEW."status" = 'USED' AND OLD."status" IS DISTINCT FROM 'USED' AND NEW."blocked_at" IS NOT NULL THEN
    RAISE EXCEPTION 'vale_pass_use_blocked: voucher bloqueado não pode ser marcado como usado' USING ERRCODE = '23514';
  END IF;
  IF NEW."company" IS NOT NULL THEN
    IF NEW."status" = 'USED' AND NEW."balance_cents" <> 0 THEN
      RAISE EXCEPTION 'vale_pass_used_requires_zero_balance: voucher com saldo não pode ser marcado como usado (use o resgate por saldo)' USING ERRCODE = '23514';
    END IF;
    IF NEW."status" = 'ACTIVE' AND NEW."balance_cents" = 0 AND NEW."amount_cents" > 0 THEN
      RAISE EXCEPTION 'vale_pass_active_requires_balance: voucher sem saldo não fica ativo' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;

-- Livro-razão: a REVERSÃO também é recusada em voucher bloqueado (saldo congelado). Substitui a função do PR A (mesma lógica + 1 regra).
CREATE OR REPLACE FUNCTION "vale_pass_ledger_before_insert"() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  v "vale_passes"%ROWTYPE;
  orig "vale_pass_ledger_entries"%ROWTYPE;
  last_seq integer;
BEGIN
  IF NOT "vale_pass_ledger_kind_enabled"(NEW."kind") THEN
    RAISE EXCEPTION 'vale_pass_ledger_kind_disabled: o tipo de lançamento % não está habilitado (falta política comercial aprovada)', NEW."kind" USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v FROM "vale_passes" WHERE "id" = NEW."vale_pass_id" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vale_pass_ledger_voucher_missing: voucher inexistente' USING ERRCODE = '23503';
  END IF;

  -- Empresa: sempre a do voucher (um lançamento nunca contradiz a empresa do voucher). Só o voucher do modelo novo (com empresa) tem saldo operável.
  IF v."company" IS NULL THEN
    RAISE EXCEPTION 'vale_pass_ledger_legacy_voucher: voucher legado (sem empresa) não tem controle de saldo' USING ERRCODE = '23514';
  END IF;
  IF NEW."company" IS NOT NULL AND NEW."company" IS DISTINCT FROM v."company" THEN
    RAISE EXCEPTION 'vale_pass_ledger_company_mismatch: lançamento de outra empresa' USING ERRCODE = '23514';
  END IF;
  NEW."company" := v."company";

  SELECT coalesce(max("seq"), 0) INTO last_seq FROM "vale_pass_ledger_entries" WHERE "vale_pass_id" = NEW."vale_pass_id";
  NEW."seq" := last_seq + 1;
  NEW."balance_after_cents" := v."balance_cents" + NEW."delta_cents";

  IF NEW."kind" = 'REDEEM' THEN
    IF v."status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'vale_pass_ledger_not_redeemable: voucher com status % não pode ser resgatado', v."status" USING ERRCODE = '23514';
    END IF;
    IF v."blocked_at" IS NOT NULL THEN
      RAISE EXCEPTION 'vale_pass_ledger_blocked: voucher bloqueado administrativamente' USING ERRCODE = '23514';
    END IF;
    IF v."expires_at" <= now() THEN
      RAISE EXCEPTION 'vale_pass_ledger_expired: voucher fora da validade' USING ERRCODE = '23514';
    END IF;
    IF v."valid_from" IS NOT NULL AND v."valid_from" > now() THEN
      RAISE EXCEPTION 'vale_pass_ledger_not_yet_valid: voucher ainda não está no período de uso' USING ERRCODE = '23514';
    END IF;
    -- Mesma regra do gatilho de status (revisão de reembolso do pedido): vale para QUALQUER resgate, parcial ou total.
    IF v."group_id" IS NOT NULL AND v."shopify_order_id" IS NOT NULL AND EXISTS (
      SELECT 1 FROM "vale_pass_refund_applications" r
      WHERE r."shopify_order_id" = v."shopify_order_id" AND r."status" = 'NEEDS_REVIEW'
        AND (r."detail"->'reviewGroupIds' @> to_jsonb(v."group_id"::text) OR jsonb_array_length(coalesce(r."detail"->'reviewGroupIds', '[]'::jsonb)) = 0)
    ) THEN
      RAISE EXCEPTION 'vale_pass_use_blocked_refund_review: unidade com reembolso aguardando decisão administrativa' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."kind" = 'REVERSAL' THEN
    -- Voucher bloqueado: o saldo fica CONGELADO (nem resgate nem reversão) até o desbloqueio administrativo.
    IF v."blocked_at" IS NOT NULL THEN
      RAISE EXCEPTION 'vale_pass_ledger_blocked: voucher bloqueado administrativamente' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO orig FROM "vale_pass_ledger_entries" WHERE "id" = NEW."reverses_entry_id";
    IF NOT FOUND OR orig."vale_pass_id" <> NEW."vale_pass_id" OR orig."kind" <> 'REDEEM' THEN
      RAISE EXCEPTION 'vale_pass_ledger_bad_reversal: só um resgate do mesmo voucher pode ser revertido' USING ERRCODE = '23514';
    END IF;
    IF NEW."delta_cents" <> -orig."delta_cents" THEN
      RAISE EXCEPTION 'vale_pass_ledger_bad_reversal: a reversão devolve exatamente o valor do lançamento revertido' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (SELECT 1 FROM "vale_pass_ledger_entries" WHERE "reverses_entry_id" = NEW."reverses_entry_id") THEN
      RAISE EXCEPTION 'vale_pass_ledger_already_reversed: este lançamento já foi revertido' USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW."balance_after_cents" < 0 THEN
    RAISE EXCEPTION 'vale_pass_ledger_insufficient_balance: saldo insuficiente' USING ERRCODE = '23514';
  END IF;
  IF NEW."balance_after_cents" > v."amount_cents" THEN
    RAISE EXCEPTION 'vale_pass_ledger_over_credit: o saldo não pode passar do crédito emitido' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;

RESET lock_timeout;
