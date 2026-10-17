-- Valle Pass 2027 — modelo de DOIS vouchers por unidade comercial (PR B, só estrutura).
--
-- SÓ ADICIONA. Nada é ativado e nenhum dado existente muda:
--   * 4 colunas NULAS em `vale_passes` (empresa, grupo da unidade, benefício, início do uso): todo voucher existente continua LEGADO
--     (1 linha = 1 passe), com o mesmo código, valor, validade e histórico;
--   * `vale_pass_campaign_benefits` (benefícios por campanha) e `vale_pass_issuance_holds` (fila de resolução de pagamentos sem emissão);
--   * gatilhos que tornam IMUTÁVEIS os campos que definem o que foi vendido (em qualquer voucher, legado ou novo).
-- A emissão (webhook) NÃO lê nada disto até o PR de ligação, que precisa de autorização própria.
--
-- Atomicidade: o arquivo roda como uma transação implícita; `lock_timeout` evita esperar indefinidamente atrás de uma transação longa e,
-- se estourar, nada fica aplicado (o Prisma marca a migration como falhada: ver docs/VALLE-PASS-2027-DESENHO.md, recuperação P3009).

SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "vale_pass_company" AS ENUM ('VALLE_SHOWROOM', 'VS_BY_CLOSET');
CREATE TYPE "vale_pass_benefit_kind" AS ENUM ('VOUCHER', 'DISCOUNT');
CREATE TYPE "vale_pass_hold_status" AS ENUM ('OPEN', 'ISSUED', 'DISMISSED');
CREATE TYPE "vale_pass_hold_reason" AS ENUM ('CAPACITY_EXCEEDED', 'CAMPAIGN_NOT_READY');

-- AlterTable (colunas nulas, sem DEFAULT: só metadado, sem reescrever a tabela)
ALTER TABLE "vale_passes" ADD COLUMN     "benefit_id" UUID,
ADD COLUMN     "company" "vale_pass_company",
ADD COLUMN     "group_id" UUID,
ADD COLUMN     "valid_from" TIMESTAMPTZ(6);

-- CreateTable
CREATE TABLE "vale_pass_campaign_benefits" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "vale_pass_benefit_kind" NOT NULL,
    "company" "vale_pass_company",
    "label" TEXT NOT NULL,
    "amount_cents" INTEGER,
    "discount_percent" INTEGER,
    "terms" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vale_pass_campaign_benefits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vale_pass_issuance_holds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shopify_order_id" TEXT NOT NULL,
    "campaign_id" UUID NOT NULL,
    "units" INTEGER NOT NULL,
    "reason" "vale_pass_hold_reason" NOT NULL,
    "status" "vale_pass_hold_status" NOT NULL DEFAULT 'OPEN',
    "open_flag" BOOLEAN,
    "detail" JSONB,
    "issued_units" INTEGER,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by" UUID,
    "resolution_note" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vale_pass_issuance_holds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vale_pass_campaign_benefits_campaign_id_idx" ON "vale_pass_campaign_benefits"("campaign_id");

-- Um benefício por código e UM voucher por empresa em cada campanha (NULLs de empresa — descontos — não colidem).
CREATE UNIQUE INDEX "vale_pass_campaign_benefits_campaign_id_code_key" ON "vale_pass_campaign_benefits"("campaign_id", "code");
CREATE UNIQUE INDEX "vale_pass_campaign_benefits_campaign_id_company_key" ON "vale_pass_campaign_benefits"("campaign_id", "company");

-- CreateIndex
CREATE INDEX "vale_pass_issuance_holds_campaign_id_idx" ON "vale_pass_issuance_holds"("campaign_id");
CREATE INDEX "vale_pass_issuance_holds_status_idx" ON "vale_pass_issuance_holds"("status");

-- No máximo UMA retenção ABERTA por pedido e campanha (`open_flag` é true só enquanto aberta; NULLs não colidem).
CREATE UNIQUE INDEX "vale_pass_issuance_holds_shopify_order_id_campaign_id_open__key" ON "vale_pass_issuance_holds"("shopify_order_id", "campaign_id", "open_flag");

-- CreateIndex
CREATE INDEX "vale_passes_group_id_idx" ON "vale_passes"("group_id");
CREATE INDEX "vale_passes_benefit_id_idx" ON "vale_passes"("benefit_id");

-- Nunca dois vouchers do MESMO benefício (nem da mesma empresa) na mesma unidade comercial (legado, sem grupo, não colide).
CREATE UNIQUE INDEX "vale_passes_group_id_benefit_id_key" ON "vale_passes"("group_id", "benefit_id");
CREATE UNIQUE INDEX "vale_passes_group_id_company_key" ON "vale_passes"("group_id", "company");

-- AddForeignKey (RESTRICT: um benefício usado por vouchers nunca é apagado)
ALTER TABLE "vale_passes" ADD CONSTRAINT "vale_passes_benefit_id_fkey" FOREIGN KEY ("benefit_id") REFERENCES "vale_pass_campaign_benefits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vale_pass_campaign_benefits" ADD CONSTRAINT "vale_pass_campaign_benefits_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "vale_pass_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "vale_pass_issuance_holds" ADD CONSTRAINT "vale_pass_issuance_holds_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "vale_pass_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- Invariantes (o serviço já as respeita; o banco é a última linha)
-- ─────────────────────────────────────────────────────────────

-- Voucher: empresa, grupo e benefício vêm JUNTOS ou nenhum (legado); o início do uso precede a validade.
ALTER TABLE "vale_passes"
  ADD CONSTRAINT "vp_company_group_benefit_together" CHECK (
    ("company" IS NULL) = ("group_id" IS NULL) AND ("company" IS NULL) = ("benefit_id" IS NULL)),
  ADD CONSTRAINT "vp_valid_window" CHECK ("valid_from" IS NULL OR "valid_from" < "expires_at");

-- Benefício: VOUCHER = empresa + valor em centavos (1 a R$ 100.000,00), sem percentual; DISCOUNT = percentual de 1 a 100, sem empresa nem valor.
ALTER TABLE "vale_pass_campaign_benefits"
  ADD CONSTRAINT "vpb_code_format" CHECK ("code" ~ '^[a-z0-9_]{1,40}$'),
  ADD CONSTRAINT "vpb_kind_fields" CHECK (
    ("kind" = 'VOUCHER' AND "company" IS NOT NULL AND "amount_cents" BETWEEN 1 AND 10000000 AND "discount_percent" IS NULL)
    OR ("kind" = 'DISCOUNT' AND "company" IS NULL AND "amount_cents" IS NULL AND "discount_percent" BETWEEN 1 AND 100));

-- Retenção: unidades > 0; aberta ⇔ open_flag; resolvida exige data e justificativa; emitida exige unidades emitidas.
ALTER TABLE "vale_pass_issuance_holds"
  ADD CONSTRAINT "vph_units_positive" CHECK ("units" >= 1),
  ADD CONSTRAINT "vph_open_flag_matches_status" CHECK (
    ("status" = 'OPEN' AND "open_flag" IS TRUE) OR ("status" <> 'OPEN' AND "open_flag" IS NULL)),
  ADD CONSTRAINT "vph_resolution_fields" CHECK (
    ("status" = 'OPEN' AND "resolved_at" IS NULL AND "issued_units" IS NULL)
    OR ("status" = 'ISSUED' AND "resolved_at" IS NOT NULL AND "resolution_note" IS NOT NULL AND "issued_units" >= 1)
    OR ("status" = 'DISMISSED' AND "resolved_at" IS NOT NULL AND "resolution_note" IS NOT NULL AND "issued_units" IS NULL));

-- ─────────────────────────────────────────────────────────────
-- Imutabilidade (gatilhos). Só barram o que define O QUE FOI VENDIDO; status, uso, cancelamento e restauração seguem livres.
-- ─────────────────────────────────────────────────────────────

-- Voucher emitido: código, campanha, valor, empresa, grupo, benefício, pedido e datas de compra/validade nunca mudam.
CREATE FUNCTION "vale_pass_immutable_fields"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."code" IS DISTINCT FROM OLD."code"
     OR NEW."campaign_id" IS DISTINCT FROM OLD."campaign_id"
     OR NEW."amount_cents" IS DISTINCT FROM OLD."amount_cents"
     OR NEW."company" IS DISTINCT FROM OLD."company"
     OR NEW."group_id" IS DISTINCT FROM OLD."group_id"
     OR NEW."benefit_id" IS DISTINCT FROM OLD."benefit_id"
     OR NEW."shopify_order_id" IS DISTINCT FROM OLD."shopify_order_id"
     OR NEW."purchased_at" IS DISTINCT FROM OLD."purchased_at"
     OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
     OR NEW."valid_from" IS DISTINCT FROM OLD."valid_from" THEN
    RAISE EXCEPTION 'vale_pass_immutable: código, valor, empresa, grupo, benefício, pedido e datas de um voucher emitido não podem mudar'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "vale_passes_immutable_fields" BEFORE UPDATE ON "vale_passes" FOR EACH ROW EXECUTE FUNCTION "vale_pass_immutable_fields"();

-- Benefício já usado: tipo, código, empresa e valor imutáveis; o percentual do desconto também, assim que a campanha emitiu no
-- modelo de vários vouchers. Rótulo, condições, ordem e `active` seguem editáveis.
CREATE FUNCTION "vale_pass_benefit_guard"() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW."campaign_id" IS DISTINCT FROM OLD."campaign_id" OR NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."code" IS DISTINCT FROM OLD."code" THEN
    RAISE EXCEPTION 'vale_pass_benefit_immutable: campanha, tipo e código de um benefício não mudam' USING ERRCODE = '23514';
  END IF;
  IF (NEW."company" IS DISTINCT FROM OLD."company" OR NEW."amount_cents" IS DISTINCT FROM OLD."amount_cents")
     AND EXISTS (SELECT 1 FROM "vale_passes" WHERE "benefit_id" = OLD."id") THEN
    RAISE EXCEPTION 'vale_pass_benefit_immutable: empresa e valor de um benefício já emitido não mudam' USING ERRCODE = '23514';
  END IF;
  IF NEW."discount_percent" IS DISTINCT FROM OLD."discount_percent"
     AND EXISTS (SELECT 1 FROM "vale_passes" WHERE "campaign_id" = OLD."campaign_id" AND "group_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'vale_pass_benefit_immutable: o percentual do desconto não muda depois que a campanha emitiu passes' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER "vale_pass_benefits_guard" BEFORE UPDATE ON "vale_pass_campaign_benefits" FOR EACH ROW EXECUTE FUNCTION "vale_pass_benefit_guard"();

-- Devolve o lock_timeout da sessão ao padrão da conexão (o SET acima é de sessão; o pré-deploy usa o pooler do Neon).
RESET lock_timeout;
