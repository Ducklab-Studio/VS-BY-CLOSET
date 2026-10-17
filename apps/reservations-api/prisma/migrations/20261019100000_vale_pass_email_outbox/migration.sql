-- Valle Pass 2027 — PR C: caixa de saída (outbox) dos e-mails com os vouchers.
--
-- Estritamente ADITIVA: duas tabelas novas e dois tipos novos, sem tocar em nenhuma tabela existente. Nada é lido, copiado ou apagado.
-- Não envia nada por si só: o envio só acontece quando o backend roda o worker com VALE_PASS_EMAIL_MODE=live (padrão: off).
--
-- Atomicidade: o arquivo roda como uma transação implícita; `lock_timeout` evita esperar indefinidamente atrás de uma transação longa.
-- Só cria objetos novos (a única tabela existente referenciada é vale_pass_campaigns, pela FK), então o lock é curto.
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "vale_pass_email_status" AS ENUM ('QUEUED', 'SENDING', 'UNKNOWN', 'ACCEPTED', 'DELIVERED', 'FAILED', 'NEEDS_ATTENTION', 'CANCELLED');

-- CreateEnum
CREATE TYPE "vale_pass_email_kind" AS ENUM ('INITIAL', 'RESEND');

-- CreateTable
CREATE TABLE "vale_pass_email_outbox" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopify_order_id" TEXT NOT NULL,
    "campaign_id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "kind" "vale_pass_email_kind" NOT NULL DEFAULT 'INITIAL',
    "dedupe_key" TEXT NOT NULL,
    "to_email" TEXT NOT NULL,
    "recipient_name" TEXT,
    "status" "vale_pass_email_status" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMPTZ(6),
    "idempotency_key" TEXT NOT NULL,
    "first_attempt_at" TIMESTAMPTZ(6),
    "last_attempt_at" TIMESTAMPTZ(6),
    "provider_message_id" TEXT,
    "accepted_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "failed_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "deadline_at" TIMESTAMPTZ(6) NOT NULL,
    "resend_of_id" UUID,
    "requested_by" UUID,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vale_pass_email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vale_pass_email_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "outbox_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vale_pass_email_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vale_pass_email_outbox_dedupe_key_key" ON "vale_pass_email_outbox"("dedupe_key");

-- CreateIndex
CREATE UNIQUE INDEX "vale_pass_email_outbox_provider_message_id_key" ON "vale_pass_email_outbox"("provider_message_id");

-- CreateIndex
CREATE INDEX "vale_pass_email_outbox_status_next_attempt_at_idx" ON "vale_pass_email_outbox"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "vale_pass_email_outbox_shopify_order_id_idx" ON "vale_pass_email_outbox"("shopify_order_id");

-- CreateIndex
CREATE INDEX "vale_pass_email_outbox_group_id_idx" ON "vale_pass_email_outbox"("group_id");

-- CreateIndex
CREATE INDEX "vale_pass_email_events_outbox_id_created_at_idx" ON "vale_pass_email_events"("outbox_id", "created_at");

-- AddForeignKey
ALTER TABLE "vale_pass_email_outbox" ADD CONSTRAINT "vale_pass_email_outbox_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "vale_pass_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vale_pass_email_events" ADD CONSTRAINT "vale_pass_email_events_outbox_id_fkey" FOREIGN KEY ("outbox_id") REFERENCES "vale_pass_email_outbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Garantias no banco (a aplicação também valida; aqui é a última linha de defesa).
ALTER TABLE "vale_pass_email_outbox"
  ADD CONSTRAINT "vpe_attempts_nonneg" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "vpe_to_email_length" CHECK (length("to_email") <= 320),
  -- Aceita/entregue sempre tem o id da Resend.
  ADD CONSTRAINT "vpe_accepted_has_provider_id" CHECK ("status" NOT IN ('ACCEPTED', 'DELIVERED') OR "provider_message_id" IS NOT NULL),
  -- `dedupe_key` no formato esperado e coerente com o tipo: uma mensagem INICIAL por unidade comercial.
  ADD CONSTRAINT "vpe_dedupe_format" CHECK ("dedupe_key" ~ '^(initial:[0-9a-f-]{36}|resend:[0-9a-f-]{36}:[0-9]+)$'),
  ADD CONSTRAINT "vpe_kind_matches_dedupe" CHECK (("kind" = 'INITIAL') = ("dedupe_key" LIKE 'initial:%')),
  -- Um reenvio sempre aponta para a mensagem original e registra quem pediu.
  ADD CONSTRAINT "vpe_resend_has_origin" CHECK ("kind" = 'INITIAL' OR ("resend_of_id" IS NOT NULL AND "requested_by" IS NOT NULL)),
  ADD CONSTRAINT "vpe_delivered_after_accepted" CHECK ("status" <> 'DELIVERED' OR ("accepted_at" IS NOT NULL AND "delivered_at" IS NOT NULL));

-- A identidade da mensagem não muda depois de criada (o resto — estado, tentativas, destinatário corrigido por um ADMIN — muda).
CREATE FUNCTION "vale_pass_email_outbox_guard"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."shopify_order_id" IS DISTINCT FROM OLD."shopify_order_id"
     OR NEW."campaign_id" IS DISTINCT FROM OLD."campaign_id"
     OR NEW."group_id" IS DISTINCT FROM OLD."group_id"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."dedupe_key" IS DISTINCT FROM OLD."dedupe_key"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (OLD."provider_message_id" IS NOT NULL AND NEW."provider_message_id" IS DISTINCT FROM OLD."provider_message_id") THEN
    RAISE EXCEPTION 'vale_pass_email_immutable: pedido, unidade, tipo, chave e id da Resend de uma mensagem não mudam' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "vale_pass_email_outbox_guard" BEFORE UPDATE ON "vale_pass_email_outbox" FOR EACH ROW EXECUTE FUNCTION "vale_pass_email_outbox_guard"();

-- A linha do tempo só cresce: nunca é alterada nem apagada.
CREATE FUNCTION "vale_pass_email_events_append_only"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'vale_pass_email_events_append_only: a linha do tempo dos e-mails não pode ser alterada nem apagada' USING ERRCODE = '23514';
END
$fn$;
CREATE TRIGGER "vale_pass_email_events_append_only" BEFORE UPDATE OR DELETE ON "vale_pass_email_events" FOR EACH ROW EXECUTE FUNCTION "vale_pass_email_events_append_only"();

-- Devolve o lock_timeout da sessão ao padrão da conexão (o SET acima é de sessão; o pré-deploy usa o pooler do Neon).
RESET lock_timeout;
