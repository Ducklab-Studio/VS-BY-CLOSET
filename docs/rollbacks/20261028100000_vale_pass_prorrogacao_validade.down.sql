-- Rollback de 20261028100000_vale_pass_prorrogacao_validade. Só rodar se NÃO houver prorrogações reais (o histórico seria perdido; as validades já prorrogadas
-- continuam como estão nos vouchers). Depois: remover a linha da migration em `_prisma_migrations` manualmente (nunca `migrate resolve` automático).
SET lock_timeout = '5s';
DROP TABLE "vale_pass_validity_extensions";
DROP FUNCTION "vale_pass_validity_extension_before_insert"();
DROP FUNCTION "vale_pass_validity_extension_after_insert"();
DROP FUNCTION "vale_pass_validity_extensions_immutable"();
-- Volta a função de imutabilidade do PR dos dois vouchers (validade 100% imutável).
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
     OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
     OR NEW."valid_from" IS DISTINCT FROM OLD."valid_from" THEN
    RAISE EXCEPTION 'vale_pass_immutable: código, valor, empresa, grupo, benefício, pedido e datas de um voucher emitido não podem mudar'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$fn$;
