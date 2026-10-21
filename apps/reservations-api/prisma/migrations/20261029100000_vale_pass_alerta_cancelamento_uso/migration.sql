-- Valle Pass 2027 — alerta administrativo persistente para pedido CANCELADO/REEMBOLSADO cujos vouchers já tiveram crédito utilizado.
--
-- O que muda
--  * Nova tabela `vale_pass_cancellation_alerts`: UMA linha por pedido (`shopify_order_id` único = idempotência: webhook repetido ou concorrente nunca duplica o alerta).
--    Guarda só o necessário para o painel: referência interna do pedido (nome e id da Shopify), campanha, tópico do cancelamento, total utilizado e um retrato por empresa
--    (valor emitido, utilizado, saldo e status — SEM código de voucher e SEM dado pessoal).
--  * Os fatos do alerta são imutáveis (gatilho): só a conferência muda, e uma única vez: ABERTO → CONFERIDO, com quem conferiu, quando e a justificativa (10–500).
--    Nunca se apaga (DELETE/TRUNCATE recusados). O alerta NÃO altera saldo, voucher, reembolso nem a regra de cancelamento: é só informação para o ADMIN.
--
-- Compatibilidade / deploy gradual: aditiva (tipo, tabela, índices, gatilhos; sem FK). Código ANTIGO ignora a tabela. Rollback: docs/rollbacks/20261029100000_vale_pass_alerta_cancelamento_uso.down.sql
-- (só se não houver alertas reais: o histórico seria perdido). Atomicidade: uma transação; `lock_timeout` evita esperar indefinidamente.
SET lock_timeout = '5s';

CREATE TYPE "vale_pass_cancellation_alert_status" AS ENUM ('OPEN', 'ACKNOWLEDGED');

CREATE TABLE "vale_pass_cancellation_alerts" (
  "id"                   UUID                                 NOT NULL DEFAULT gen_random_uuid(),
  "shopify_order_id"     TEXT                                 NOT NULL,
  "shopify_order_name"   TEXT,
  "campaign_id"          UUID,
  "topic"                TEXT                                 NOT NULL,
  "used_cents"           INTEGER                              NOT NULL,
  "detail"               JSONB                                NOT NULL,
  "status"               "vale_pass_cancellation_alert_status" NOT NULL DEFAULT 'OPEN',
  "acknowledged_at"      TIMESTAMPTZ(6),
  "acknowledged_by"      UUID,
  "acknowledged_by_name" TEXT,
  "acknowledge_note"     TEXT,
  "created_at"           TIMESTAMPTZ(6)                       NOT NULL DEFAULT now(),
  CONSTRAINT "vale_pass_cancellation_alerts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "vale_pass_cancellation_alerts_used_positive" CHECK ("used_cents" > 0),
  CONSTRAINT "vale_pass_cancellation_alerts_ack_consistent" CHECK (
    ("status" = 'OPEN' AND "acknowledged_at" IS NULL AND "acknowledge_note" IS NULL)
    OR ("status" = 'ACKNOWLEDGED' AND "acknowledged_at" IS NOT NULL AND char_length(btrim("acknowledge_note")) BETWEEN 10 AND 500)
  )
);
CREATE UNIQUE INDEX "vale_pass_cancellation_alerts_shopify_order_id_key" ON "vale_pass_cancellation_alerts"("shopify_order_id");
CREATE INDEX "vale_pass_cancellation_alerts_status_idx" ON "vale_pass_cancellation_alerts"("status");
CREATE INDEX "vale_pass_cancellation_alerts_campaign_id_idx" ON "vale_pass_cancellation_alerts"("campaign_id");
-- Sem FK de propósito (mesmo padrão de outros registros de auditoria): o alerta é um fato imutável do pedido e nunca deve bloquear nem sumir com a campanha.

-- Fatos imutáveis; a conferência só muda de ABERTO para CONFERIDO (uma vez); nunca apaga.
CREATE FUNCTION "vale_pass_cancellation_alerts_guard"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."shopify_order_id" IS DISTINCT FROM OLD."shopify_order_id" OR NEW."shopify_order_name" IS DISTINCT FROM OLD."shopify_order_name"
       OR NEW."campaign_id" IS DISTINCT FROM OLD."campaign_id" OR NEW."topic" IS DISTINCT FROM OLD."topic" OR NEW."used_cents" IS DISTINCT FROM OLD."used_cents"
       OR NEW."detail" IS DISTINCT FROM OLD."detail" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'vale_pass_cancellation_alert_immutable: os fatos do alerta não podem ser alterados' USING ERRCODE = '23514';
    END IF;
    IF OLD."status" = 'ACKNOWLEDGED' THEN
      RAISE EXCEPTION 'vale_pass_cancellation_alert_immutable: um alerta já conferido não muda mais' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'vale_pass_cancellation_alert_immutable: alertas não podem ser apagados' USING ERRCODE = '23514';
END
$fn$;
CREATE TRIGGER "vale_pass_cancellation_alerts_no_change" BEFORE UPDATE OR DELETE ON "vale_pass_cancellation_alerts" FOR EACH ROW EXECUTE FUNCTION "vale_pass_cancellation_alerts_guard"();
CREATE TRIGGER "vale_pass_cancellation_alerts_no_truncate" BEFORE TRUNCATE ON "vale_pass_cancellation_alerts" FOR EACH STATEMENT EXECUTE FUNCTION "vale_pass_cancellation_alerts_guard"();
