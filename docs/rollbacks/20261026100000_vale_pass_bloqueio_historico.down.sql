SET lock_timeout = '5s';
DROP TABLE "vale_pass_block_events";
DROP FUNCTION "vale_pass_block_before_insert"();
DROP FUNCTION "vale_pass_block_after_insert"();
DROP FUNCTION "vale_pass_block_events_immutable"();
DROP TYPE "vale_pass_block_kind";
CREATE OR REPLACE FUNCTION "vale_pass_balance_guard"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."balance_cents" IS DISTINCT FROM OLD."balance_cents" AND pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'vale_pass_balance_direct_update: o saldo só muda por lançamento no livro-razão' USING ERRCODE = '23514';
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
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261026100000_vale_pass_bloqueio_historico';
RESET lock_timeout;
