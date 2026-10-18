-- Valle Pass 2027 — PR G: trilha de reembolsos (idempotência por reembolso + fila de revisão administrativa).
--
-- ADITIVA: uma tabela nova, um tipo novo e UM gatilho em vale_passes (só dispara na transição para USED). Nenhum dado existente é alterado e nenhuma linha é lida, copiada ou apagada (a única tabela
-- existente referenciada é vale_pass_campaigns, pela FK opcional). Nada usa a tabela até a integração financeira (PR F, com autorização própria).
--
-- Atomicidade: o arquivo roda como uma transação implícita; `lock_timeout` evita esperar indefinidamente atrás de uma transação longa.
SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "vale_pass_refund_status" AS ENUM ('APPLIED', 'NEEDS_REVIEW', 'RESOLVED');

-- CreateTable
CREATE TABLE "vale_pass_refund_applications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopify_refund_id" TEXT NOT NULL,
    "shopify_order_id" TEXT NOT NULL,
    "campaign_id" UUID,
    "classification" TEXT NOT NULL,
    "refunded_units" INTEGER NOT NULL DEFAULT 0,
    "cancelled_group_ids" JSONB NOT NULL DEFAULT '[]',
    "status" "vale_pass_refund_status" NOT NULL,
    "review_reasons" JSONB NOT NULL DEFAULT '[]',
    "detail" JSONB,
    "shipping_refund_cents" INTEGER,
    "transactions_cents" INTEGER,
    "resolution" TEXT,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by" UUID,
    "resolution_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vale_pass_refund_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "vale_pass_refund_applications_shopify_refund_id_key" ON "vale_pass_refund_applications"("shopify_refund_id");

-- CreateIndex
CREATE INDEX "vale_pass_refund_applications_shopify_order_id_idx" ON "vale_pass_refund_applications"("shopify_order_id");

-- CreateIndex
CREATE INDEX "vale_pass_refund_applications_status_idx" ON "vale_pass_refund_applications"("status");

-- AddForeignKey
ALTER TABLE "vale_pass_refund_applications" ADD CONSTRAINT "vale_pass_refund_applications_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "vale_pass_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Garantias no banco (a aplicação também valida; aqui é a última linha de defesa).
ALTER TABLE "vale_pass_refund_applications"
  ADD CONSTRAINT "vra_units_nonneg" CHECK ("refunded_units" >= 0),
  ADD CONSTRAINT "vra_cents_nonneg" CHECK (("shipping_refund_cents" IS NULL OR "shipping_refund_cents" >= 0) AND ("transactions_cents" IS NULL OR "transactions_cents" >= 0)),
  ADD CONSTRAINT "vra_json_shapes" CHECK (jsonb_typeof("cancelled_group_ids") = 'array' AND jsonb_typeof("review_reasons") = 'array'),
  -- Só "revisão resolvida" tem decisão, quem decidiu, quando e a justificativa; as demais não.
  ADD CONSTRAINT "vra_resolution_fields" CHECK (
    ("status" = 'RESOLVED' AND "resolution" IN ('KEEP_VOUCHERS', 'CANCEL_ACTIVE_VOUCHERS') AND "resolved_at" IS NOT NULL AND "resolved_by" IS NOT NULL AND length("resolution_note") >= 10)
    OR ("status" <> 'RESOLVED' AND "resolution" IS NULL AND "resolved_at" IS NULL AND "resolved_by" IS NULL AND "resolution_note" IS NULL)),
  -- Revisão sempre diz o porquê; reembolso aplicado por completo não tem motivo de revisão.
  ADD CONSTRAINT "vra_review_has_reason" CHECK (("status" = 'APPLIED') = (jsonb_array_length("review_reasons") = 0) OR "status" = 'RESOLVED');

-- A identidade do reembolso não muda; a trilha nunca é apagada.
CREATE FUNCTION "vale_pass_refund_guard"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'vale_pass_refund_no_delete: a trilha de reembolsos não pode ser apagada' USING ERRCODE = '23514';
  END IF;
  IF NEW."shopify_refund_id" IS DISTINCT FROM OLD."shopify_refund_id"
     OR NEW."shopify_order_id" IS DISTINCT FROM OLD."shopify_order_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
     OR (OLD."status" = 'RESOLVED' AND NEW."status" IS DISTINCT FROM OLD."status") THEN
    RAISE EXCEPTION 'vale_pass_refund_immutable: reembolso, pedido e data não mudam, e uma revisão resolvida não é reaberta' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "vale_pass_refund_guard" BEFORE UPDATE OR DELETE ON "vale_pass_refund_applications" FOR EACH ROW EXECUTE FUNCTION "vale_pass_refund_guard"();

-- Defesa em profundidade (F2): nenhum caminho — nem SQL direto — marca como USADO um voucher de unidade com reembolso em revisão. A cláusula WHEN
-- restringe o gatilho à transição para USED; as demais atualizações de vale_passes não executam nada. Sem linhas NEEDS_REVIEW, nunca bloqueia.
CREATE FUNCTION "vale_pass_block_use_under_refund_review"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."group_id" IS NOT NULL AND NEW."shopify_order_id" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "vale_pass_refund_applications" r
    WHERE r."shopify_order_id" = NEW."shopify_order_id" AND r."status" = 'NEEDS_REVIEW' AND r."detail"->'reviewGroupIds' @> to_jsonb(NEW."group_id"::text)
  ) THEN
    RAISE EXCEPTION 'vale_pass_use_blocked_refund_review: unidade com reembolso aguardando decisão administrativa' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "vale_pass_block_use_under_refund_review" BEFORE UPDATE OF "status" ON "vale_passes" FOR EACH ROW
  WHEN (NEW."status" = 'USED' AND OLD."status" IS DISTINCT FROM 'USED') EXECUTE FUNCTION "vale_pass_block_use_under_refund_review"();

-- Devolve o lock_timeout da sessão ao padrão da conexão (o SET acima é de sessão; o pré-deploy usa o pooler do Neon).
RESET lock_timeout;
