-- Valle Pass 2027 — prorrogação COLETIVA da validade dos vouchers, com histórico imutável.
--
-- O que muda
--  * Nova tabela `vale_pass_validity_extensions` (só INSERT): cada prorrogação, com a data final anterior, a NOVA data final, fuso, justificativa (10–500), quem autorizou,
--    chave de idempotência (única por campanha), numeração por campanha e um retrato do que foi feito (quantos vouchers ganharam a nova validade, quantos ficaram de
--    fora por já estarem vencidos ou cancelados, e a soma dos saldos dos prorrogados — prova de que a prorrogação não mexe em saldo). UPDATE/DELETE/TRUNCATE recusados.
--  * Gatilho BEFORE INSERT valida SOB O LOCK da campanha: a campanha precisa ter validade configurada; `previous_until` tem de ser a validade ATUAL (prévia velha é recusada);
--    a nova data só pode ser MAIOR; calcula o instante de vencimento no fuso informado e o retrato acima. Trava os vouchers da campanha em ordem fixa (id).
--  * Gatilho AFTER INSERT aplica, na MESMA transação (tudo ou nada): sobe `expires_at` SÓ dos vouchers elegíveis (ACTIVE ou USED, ainda dentro da validade e com validade
--    menor que a nova), grava um evento `VALIDITY_EXTENDED` por voucher e atualiza a validade final da campanha (valerá para as emissões futuras).
--  * `expires_at` do voucher deixa de ser "imutável absoluto": só muda para MAIS tarde, para voucher ACTIVE/USED, dentro desse gatilho e com uma prorrogação existente
--    que a autorize (campanha e instante conferem). UPDATE direto continua recusado.
--  * NÃO reativa nada: vouchers cancelados, expirados (por status ou por data) e bloqueados mantêm o estado; saldo, ledger, benefícios, empresa, código, valor e
--    `valid_from` não mudam. A elegibilidade de vouchers JÁ EXPIRADOS é decisão comercial pendente: aqui eles ficam de fora.
--
-- Compatibilidade / deploy gradual: aditiva (tabela, funções, gatilhos); a função `vale_pass_immutable_fields` do PR dos dois vouchers é substituída por CREATE OR REPLACE com a
-- mesma regra para os demais campos e a exceção estreita acima. Código ANTIGO nunca altera `expires_at` (continua recusado) e ignora a tabela nova. Rollback: ver
-- docs/rollbacks/20261028100000_vale_pass_prorrogacao_validade.down.sql. Atomicidade: uma transação; `lock_timeout` evita esperar indefinidamente.
SET lock_timeout = '5s';

CREATE TABLE "vale_pass_validity_extensions" (
  "id"                     UUID           NOT NULL DEFAULT gen_random_uuid(),
  "campaign_id"            UUID           NOT NULL,
  "seq"                    INTEGER        NOT NULL,
  "previous_until"         DATE           NOT NULL,
  "new_until"              DATE           NOT NULL,
  "timezone"               TEXT           NOT NULL,
  "new_expires_at"         TIMESTAMPTZ(6) NOT NULL,
  "reason"                 TEXT           NOT NULL,
  "actor_admin_id"         UUID,
  "actor_name"             TEXT,
  "idempotency_key"        TEXT           NOT NULL,
  "request_hash"           TEXT,
  "extended_count"         INTEGER        NOT NULL DEFAULT 0,
  "expired_not_included"   INTEGER        NOT NULL DEFAULT 0,
  "cancelled_not_included" INTEGER        NOT NULL DEFAULT 0,
  "already_longer_count"   INTEGER        NOT NULL DEFAULT 0,
  "balance_total_cents"    BIGINT         NOT NULL DEFAULT 0,
  "created_at"             TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "vale_pass_validity_extensions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vale_pass_validity_ext_seq_positive" CHECK ("seq" >= 1),
  CONSTRAINT "vale_pass_validity_ext_increase_only" CHECK ("new_until" > "previous_until"),
  CONSTRAINT "vale_pass_validity_ext_reason_len" CHECK (char_length(btrim("reason")) BETWEEN 10 AND 500),
  CONSTRAINT "vale_pass_validity_ext_idempotency_key_len" CHECK (char_length("idempotency_key") BETWEEN 8 AND 128)
);
CREATE UNIQUE INDEX "vale_pass_validity_extensions_campaign_id_seq_key" ON "vale_pass_validity_extensions"("campaign_id", "seq");
CREATE UNIQUE INDEX "vale_pass_validity_extensions_campaign_id_idempotency_key_key" ON "vale_pass_validity_extensions"("campaign_id", "idempotency_key");
CREATE INDEX "vale_pass_validity_extensions_campaign_id_idx" ON "vale_pass_validity_extensions"("campaign_id");
ALTER TABLE "vale_pass_validity_extensions" ADD CONSTRAINT "vale_pass_validity_extensions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "vale_pass_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Histórico imutável.
CREATE FUNCTION "vale_pass_validity_extensions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'vale_pass_validity_immutable: o histórico de prorrogações não pode ser alterado nem apagado' USING ERRCODE = '23514';
END
$fn$;
CREATE TRIGGER "vale_pass_validity_no_update_delete" BEFORE UPDATE OR DELETE ON "vale_pass_validity_extensions" FOR EACH ROW EXECUTE FUNCTION "vale_pass_validity_extensions_immutable"();
CREATE TRIGGER "vale_pass_validity_no_truncate" BEFORE TRUNCATE ON "vale_pass_validity_extensions" FOR EACH STATEMENT EXECUTE FUNCTION "vale_pass_validity_extensions_immutable"();

-- Validação e retrato (BEFORE INSERT), sob o lock da campanha e dos vouchers (ordem fixa: campanha → vouchers por id).
CREATE FUNCTION "vale_pass_validity_extension_before_insert"() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  c "vale_pass_campaigns"%ROWTYPE;
BEGIN
  SELECT * INTO c FROM "vale_pass_campaigns" WHERE "id" = NEW."campaign_id" FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'vale_pass_validity_campaign_not_found: campanha inexistente' USING ERRCODE = '23514';
  END IF;
  IF c."voucher_valid_until" IS NULL THEN
    RAISE EXCEPTION 'vale_pass_validity_no_window: a campanha não tem validade configurada: nada a prorrogar' USING ERRCODE = '23514';
  END IF;
  IF NEW."previous_until" IS DISTINCT FROM c."voucher_valid_until" THEN
    RAISE EXCEPTION 'vale_pass_validity_stale: a validade atual da campanha mudou desde a prévia' USING ERRCODE = '23514';
  END IF;
  IF NEW."new_until" <= c."voucher_valid_until" THEN
    RAISE EXCEPTION 'vale_pass_validity_increase_only: a nova data precisa ser posterior à validade atual' USING ERRCODE = '23514';
  END IF;
  -- Fuso inexistente falha aqui (melhor recusar do que gravar validade errada).
  PERFORM now() AT TIME ZONE NEW."timezone";
  NEW."seq" := coalesce((SELECT max("seq") FROM "vale_pass_validity_extensions" WHERE "campaign_id" = NEW."campaign_id"), 0) + 1;
  -- Mesma conta do emissor: o voucher vale até 00:00 do dia SEGUINTE ao último dia, no fuso.
  NEW."new_expires_at" := ((NEW."new_until" + 1)::timestamp AT TIME ZONE NEW."timezone");

  PERFORM 1 FROM "vale_passes" WHERE "campaign_id" = NEW."campaign_id" ORDER BY "id" FOR UPDATE;

  SELECT
    count(*) FILTER (WHERE "status" IN ('ACTIVE', 'USED') AND "expires_at" > now() AND "expires_at" < NEW."new_expires_at"),
    count(*) FILTER (WHERE "status" <> 'CANCELLED' AND ("status" = 'EXPIRED' OR "expires_at" <= now())),
    count(*) FILTER (WHERE "status" = 'CANCELLED'),
    count(*) FILTER (WHERE "status" IN ('ACTIVE', 'USED') AND "expires_at" > now() AND "expires_at" >= NEW."new_expires_at"),
    coalesce(sum("balance_cents") FILTER (WHERE "status" IN ('ACTIVE', 'USED') AND "expires_at" > now() AND "expires_at" < NEW."new_expires_at" AND "company" IS NOT NULL), 0)
  INTO NEW."extended_count", NEW."expired_not_included", NEW."cancelled_not_included", NEW."already_longer_count", NEW."balance_total_cents"
  FROM "vale_passes" WHERE "campaign_id" = NEW."campaign_id";
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "vale_pass_validity_before_insert" BEFORE INSERT ON "vale_pass_validity_extensions" FOR EACH ROW EXECUTE FUNCTION "vale_pass_validity_extension_before_insert"();

-- Efeito (AFTER INSERT), na MESMA transação: só os elegíveis ganham a nova validade; um evento por voucher; a campanha passa a emitir com a nova validade final.
CREATE FUNCTION "vale_pass_validity_extension_after_insert"() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  changed integer;
BEGIN
  PERFORM set_config('vale_pass.extension_id', NEW."id"::text, true);
  WITH old AS (
    SELECT "id", "expires_at" AS old_expires_at FROM "vale_passes"
    WHERE "campaign_id" = NEW."campaign_id" AND "status" IN ('ACTIVE', 'USED') AND "expires_at" > now() AND "expires_at" < NEW."new_expires_at"
  ), upd AS (
    UPDATE "vale_passes" v SET "expires_at" = NEW."new_expires_at" FROM old o WHERE v."id" = o."id" RETURNING v."id", o.old_expires_at
  ), ev AS (
    INSERT INTO "vale_pass_events" ("vale_pass_id", "type", "detail")
    SELECT u."id", 'VALIDITY_EXTENDED', jsonb_build_object('extensionId', NEW."id", 'previousExpiresAt', u.old_expires_at, 'newExpiresAt', NEW."new_expires_at", 'newUntil', NEW."new_until")
    FROM upd u RETURNING 1
  )
  SELECT count(*) INTO changed FROM ev;
  PERFORM set_config('vale_pass.extension_id', '', true);
  IF changed <> NEW."extended_count" THEN
    RAISE EXCEPTION 'vale_pass_validity_count_mismatch: a prorrogação alcançou % vouchers, esperados %', changed, NEW."extended_count" USING ERRCODE = '23514';
  END IF;
  UPDATE "vale_pass_campaigns" SET "voucher_valid_until" = NEW."new_until", "updated_at" = now() WHERE "id" = NEW."campaign_id";
  RETURN NULL;
END
$fn$;
CREATE TRIGGER "vale_pass_validity_after_insert" AFTER INSERT ON "vale_pass_validity_extensions" FOR EACH ROW EXECUTE FUNCTION "vale_pass_validity_extension_after_insert"();

-- Voucher emitido: o que define O QUE FOI VENDIDO nunca muda; a validade (`expires_at`) só sobe, dentro da prorrogação acima. Substitui a função do PR dos dois vouchers
-- (mesma regra para os demais campos).
CREATE OR REPLACE FUNCTION "vale_pass_immutable_fields"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."campaign_id" IS DISTINCT FROM OLD."campaign_id"
     OR NEW."amount_cents" IS DISTINCT FROM OLD."amount_cents"
     OR NEW."company" IS DISTINCT FROM OLD."company"
     OR NEW."group_id" IS DISTINCT FROM OLD."group_id"
     OR NEW."benefit_id" IS DISTINCT FROM OLD."benefit_id"
     OR NEW."shopify_order_id" IS DISTINCT FROM OLD."shopify_order_id"
     OR NEW."purchased_at" IS DISTINCT FROM OLD."purchased_at"
     OR NEW."valid_from" IS DISTINCT FROM OLD."valid_from" THEN
    RAISE EXCEPTION 'vale_pass_immutable: código, valor, empresa, grupo, benefício, pedido e datas de um voucher emitido não podem mudar'
      USING ERRCODE = '23514';
  END IF;
  IF NEW."expires_at" IS DISTINCT FROM OLD."expires_at" THEN
    IF NOT (
      pg_trigger_depth() >= 2
      AND NEW."expires_at" > OLD."expires_at"
      AND OLD."status" IN ('ACTIVE', 'USED')
      AND NEW."status" = OLD."status"
      AND EXISTS (
        SELECT 1 FROM "vale_pass_validity_extensions" x
        WHERE x."id"::text = current_setting('vale_pass.extension_id', true)
          AND x."campaign_id" = OLD."campaign_id"
          AND x."new_expires_at" = NEW."expires_at"
      )
    ) THEN
      RAISE EXCEPTION 'vale_pass_immutable: a validade de um voucher só pode ser prorrogada (para mais tarde) por uma prorrogação coletiva registrada'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
