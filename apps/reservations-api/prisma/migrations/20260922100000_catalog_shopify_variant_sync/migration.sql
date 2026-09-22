-- Sincronização Shopify → peça física: marca QUANDO a variante vinculada
-- deixou de existir na Shopify, sem apagar o vínculo (necessário pra
-- reativação segura se a mesma variante voltar). `active=false` (já
-- existente) é quem efetivamente bloqueia reserva/disponibilidade.
ALTER TABLE "rental_units" ADD COLUMN "shopify_variant_missing_at" timestamptz;

-- Singleton com a última execução da sincronização (usado pelo painel para
-- "última sincronização"). Sem linha 'default' = nunca sincronizado; ao
-- contrário de rental_rule_config, essa ausência não é seedada nem é erro.
CREATE TABLE "catalog_sync_state" (
  "id" text PRIMARY KEY DEFAULT 'default',
  "last_synced_at" timestamptz NOT NULL,
  "last_synced_by" uuid,
  "last_synced_by_name" text,
  "checked_variants" integer NOT NULL DEFAULT 0,
  "deactivated_count" integer NOT NULL DEFAULT 0,
  "reactivated_count" integer NOT NULL DEFAULT 0
);
