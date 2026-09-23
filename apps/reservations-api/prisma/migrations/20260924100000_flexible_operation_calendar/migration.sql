-- Calendário flexível: data de início da operação + períodos fechados
-- configuráveis pelo painel. Migration só aditiva: nenhuma linha apagada,
-- nenhuma reserva ou bloqueio existente alterado.

-- Primeira data de retirada aceita. NULL = sem restrição (loja aberta).
ALTER TABLE "rental_rule_config" ADD COLUMN "operation_start_date" date;

-- Valor inicial definido pela operação (abertura em 01/04/2027). É dado, não
-- regra de código: o ADMIN altera ou limpa pelo painel (/closetadmin/regras).
UPDATE "rental_rule_config"
SET "operation_start_date" = DATE '2027-04-01'
WHERE "id" = 'default' AND "operation_start_date" IS NULL;

-- A temporada anual fixa (MM-DD, 01/06–30/09) deixa de ser aplicada pelo
-- motor; fechamentos passam a ser períodos com data completa. As colunas
-- ficam (valores preservados, rollback seguro), só sem default e opcionais.
ALTER TABLE "rental_rule_config"
  ALTER COLUMN "blackout_start" DROP NOT NULL,
  ALTER COLUMN "blackout_start" DROP DEFAULT,
  ALTER COLUMN "blackout_end" DROP NOT NULL,
  ALTER COLUMN "blackout_end" DROP DEFAULT;

-- Períodos fechados = operational_blocks, agora editáveis e ativáveis.
-- Bloqueios existentes continuam ativos (DEFAULT true). Quem editou fica em
-- admin_audit_events, como já acontece com quem criou/levantou.
ALTER TABLE "operational_blocks"
  ADD COLUMN "active" boolean NOT NULL DEFAULT true,
  ADD COLUMN "updated_at" timestamptz(6);

-- NOT VALID: vale para toda linha nova/alterada sem reprovar dado legado.
ALTER TABLE "operational_blocks"
  ADD CONSTRAINT "operational_blocks_dates_ordered" CHECK ("end_date" >= "start_date") NOT VALID,
  ADD CONSTRAINT "operational_blocks_scope_unit" CHECK (("scope" = 'UNIT') = ("rental_unit_id" IS NOT NULL)) NOT VALID;
