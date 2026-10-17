-- Valle Pass — lotes comerciais e limite global (PR A, só administração).
--
-- SÓ ADICIONA. Nada é ativado e nenhum dado existente muda:
--   * 4 colunas NULAS em `vale_pass_campaigns` (limite global, validade fixa dos vouchers, fim das vendas);
--   * a tabela `vale_pass_lots` (lotes) e seu enum.
-- A emissão de vales (webhook) NÃO lê nada disto nesta etapa: ela continua exatamente como era.
--
-- Falha segura: `lock_timeout` impede esperar indefinidamente atrás de uma transação longa. As CHECKs só olham colunas
-- novas (todas NULAS) e a tabela de campanhas tem poucas linhas, então a validação é instantânea.

SET lock_timeout = '5s';

-- CreateEnum
CREATE TYPE "vale_pass_lot_status" AS ENUM ('PLANNED', 'OPEN', 'CLOSED', 'CANCELLED');

-- AlterTable
ALTER TABLE "vale_pass_campaigns" ADD COLUMN     "global_limit" INTEGER,
ADD COLUMN     "sales_end_date" DATE,
ADD COLUMN     "voucher_valid_from" DATE,
ADD COLUMN     "voucher_valid_until" DATE;

-- Limite global positivo; validade fixa dos vouchers: as duas datas ou nenhuma, início ≤ fim.
ALTER TABLE "vale_pass_campaigns"
  ADD CONSTRAINT "vpc_global_limit_positive" CHECK ("global_limit" IS NULL OR "global_limit" >= 1),
  ADD CONSTRAINT "vpc_voucher_window" CHECK (
    ("voucher_valid_from" IS NULL) = ("voucher_valid_until" IS NULL)
    AND ("voucher_valid_from" IS NULL OR "voucher_valid_from" <= "voucher_valid_until"));

-- CreateTable
CREATE TABLE "vale_pass_lots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "vale_pass_lot_status" NOT NULL DEFAULT 'PLANNED',
    "open_flag" BOOLEAN,
    "opened_at" TIMESTAMPTZ(6),
    "closed_at" TIMESTAMPTZ(6),
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vale_pass_lots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "vale_pass_lots_campaign_id_idx" ON "vale_pass_lots"("campaign_id");

-- No máximo UM lote aberto por campanha: `open_flag` é `true` só no lote aberto e NULL nos demais (NULLs não colidem no
-- índice único). Sem índice parcial, que o Prisma não representa.
CREATE UNIQUE INDEX "vale_pass_lots_campaign_id_open_flag_key" ON "vale_pass_lots"("campaign_id", "open_flag");

-- AddForeignKey
ALTER TABLE "vale_pass_lots" ADD CONSTRAINT "vale_pass_lots_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "vale_pass_campaigns"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Invariantes do lote (o serviço já os respeita; o banco é a última linha):
--  * quantidade positiva;
--  * `open_flag` verdadeiro exatamente quando ABERTO;
--  * horários coerentes com o status (aberto/encerrado têm abertura; encerrado tem encerramento ≥ abertura;
--    planejado/cancelado nunca foram abertos).
ALTER TABLE "vale_pass_lots"
  ADD CONSTRAINT "vpl_quantity_positive" CHECK ("quantity" >= 1),
  ADD CONSTRAINT "vpl_open_flag_matches_status" CHECK (
    ("status" = 'OPEN' AND "open_flag" IS TRUE) OR ("status" <> 'OPEN' AND "open_flag" IS NULL)),
  ADD CONSTRAINT "vpl_timestamps_match_status" CHECK (
    CASE "status"
      WHEN 'OPEN' THEN "opened_at" IS NOT NULL AND "closed_at" IS NULL
      WHEN 'CLOSED' THEN "opened_at" IS NOT NULL AND "closed_at" IS NOT NULL AND "closed_at" >= "opened_at"
      ELSE "opened_at" IS NULL AND "closed_at" IS NULL
    END);

-- Devolve o lock_timeout da sessão ao padrão da conexão (o SET acima é de sessão; o pré-deploy usa o pooler do Neon).
RESET lock_timeout;
